#!/usr/bin/env node
// 예산 게이트 — 성능 리포트 JSON 을 budgets.json / targets.json 과 대조한다.
// ptyd 등 터미널 데이터 경로 수술의 회귀 감지망(W4 M3).
//
// 사용: node check-budgets.mjs <report.json> [budgets.json(기본: 이 스크립트 옆)]
//       targets.json 은 budgets.json 옆에 있으면 자동으로 읽는다.
//
// 이 게이트가 강제하는 네 가지 — 어느 하나라도 빠지면 초록이 정보를 담지 못한다.
//
// 1. 조건. 예산은 측정 조건 아래에서만 뜻을 가진다. 조건이 다른 리포트를 예산과
//    대조하는 것은 비교가 아니라 오류다. budgets.meta.conditions 의 스칼라 키는
//    전부 report.meta 와 일치해야 한다(산문은 note 에 둔다) — 불일치·누락은
//    INVALID_CONDITIONS. cargoProfile 이 여기 포함된다: 비최적화 빌드의 수치는
//    최적화 빌드의 예산과 비교할 수 없다.
// 2. 런 유효성. 실패한 런은 측정이 아니다. exitCode != 0 이거나, 보고한 바이트와
//    실제 전달 바이트(counters.writtenBytesDelta)가 어긋나면 그 시나리오의 지표는
//    읽지 않는다(INVALID_RUN). 처리량 분자가 디스크 픽스처 크기라 시나리오가 죽어도
//    만점이 찍히던 경로를 막는다.
// 3. 회귀 예산(budgets). baseline × headroom. 예산에 있는 지표가 리포트에 없으면
//    MISSING — 시나리오 무언 탈락(게이트 공동화) 금지.
// 4. 절대 목표(targets). 건강한 수치가 무엇인가. 회귀 예산과 섞지 않는다 —
//    파생 예산은 이미 망가진 상태를 기준으로 삼으므로 절대 결함을 구조적으로
//    검출할 수 없다. 목표 미달은 BELOW_TARGET 으로 따로 보고하고, 미달이 있는 동안
//    게이트를 초록이라 부르지 않는다.
//
// budgets.json 형식:
//   { "meta": { "conditions": {...강제되는 스칼라 조건...}, ... },
//     "budgets": { "<시나리오>.<지표.경로>": { "min"?: n, "max"?: n } } }
// targets.json 형식:
//   { "targets": { "<시나리오>.<지표.경로>": { "min"?: n, "max"?: n } } }
// 경로는 report.scenarios 아래를 점 표기로 내려간다(예: "t1_plain.cpu.avg").

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function dig(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

// 산문 전용 키 — 조건이 아니라 기록이므로 대조하지 않는다.
const CONDITION_PROSE_KEYS = new Set(["note"]);
// 보고 바이트 대비 실전송 바이트의 허용 편차. 셸 프롬프트/에코가 얹히므로 정확히
// 같지는 않다(실측: 100 MiB 픽스처에 writtenBytesDelta 106,010,661 = +1.1%).
// 이 폭을 벗어나면 보고된 처리량의 분자가 실제 전달량이 아니라는 뜻이다.
const BYTES_TOLERANCE = 0.1;

/** 측정 조건 대조 — budgets.meta.conditions 의 스칼라 키가 전부 report.meta 와 같아야 한다. */
function checkConditions(report, budgets, violations) {
  const declared = budgets?.meta?.conditions;
  if (!declared || typeof declared !== "object") return;
  const meta = report?.meta ?? {};
  for (const [key, expected] of Object.entries(declared)) {
    if (CONDITION_PROSE_KEYS.has(key)) continue;
    if (expected === null || typeof expected === "object") continue; // 산문/구조는 조건이 아니다
    const actual = meta[key];
    if (actual !== expected) {
      violations.push({ path: `meta.${key}`, kind: "INVALID_CONDITIONS", actual: actual ?? null, limit: expected });
    }
  }
}

/** 런이 측정으로 성립하는가 — 실패했거나 전달량이 어긋난 시나리오는 지표를 읽지 않는다. */
function invalidRunReason(scenario) {
  if (!scenario || typeof scenario !== "object") return null;
  if (typeof scenario.exitCode === "number" && scenario.exitCode !== 0) {
    return `exitCode=${scenario.exitCode}`;
  }
  const claimed = scenario.bytes;
  const written = scenario.counters?.writtenBytesDelta;
  if (typeof claimed === "number" && claimed > 0 && typeof written === "number") {
    const deviation = Math.abs(written - claimed) / claimed;
    if (deviation > BYTES_TOLERANCE) {
      return `bytes=${claimed} 인데 writtenBytesDelta=${written} (편차 ${(deviation * 100).toFixed(1)}%)`;
    }
  }
  return null;
}

/** 한 축(예산 또는 목표)을 대조해 위반을 모은다. invalidRuns 에 든 시나리오는 건너뛴다. */
function compareAxis(scenarios, limits, kinds, invalidRuns, out) {
  for (const [p, limit] of Object.entries(limits ?? {})) {
    if (invalidRuns.has(p.split(".")[0])) continue; // 무효 런의 지표는 측정이 아니다
    const actual = dig(scenarios, p);
    if (typeof actual !== "number" || Number.isNaN(actual)) {
      if (kinds.missing) out.push({ path: p, kind: kinds.missing, actual: actual ?? null, limit });
      continue;
    }
    if (typeof limit.min === "number" && actual < limit.min) {
      out.push({ path: p, kind: kinds.belowMin, actual, limit: limit.min });
    }
    if (typeof limit.max === "number" && actual > limit.max) {
      out.push({ path: p, kind: kinds.aboveMax, actual, limit: limit.max });
    }
  }
}

/**
 * 순수 판정 — {violations, belowTargets}.
 * violations kind: INVALID_CONDITIONS | INVALID_RUN | MISSING | BELOW_MIN | ABOVE_MAX (전부 게이트 실패)
 * belowTargets kind: BELOW_TARGET (회귀 아님 — 절대 목표 미달. 초록이라 부르지 않는 근거)
 */
export function checkBudgets(report, budgets, targets) {
  const scenarios = report?.scenarios ?? {};
  const violations = [];

  checkConditions(report, budgets, violations);

  const invalidRuns = new Set();
  const referenced = new Set(
    [...Object.keys(budgets?.budgets ?? {}), ...Object.keys(targets?.targets ?? {})].map((p) => p.split(".")[0]),
  );
  for (const name of referenced) {
    const reason = invalidRunReason(scenarios[name]);
    if (reason) {
      invalidRuns.add(name);
      violations.push({ path: name, kind: "INVALID_RUN", actual: reason, limit: null });
    }
  }

  compareAxis(scenarios, budgets?.budgets, { missing: "MISSING", belowMin: "BELOW_MIN", aboveMax: "ABOVE_MAX" }, invalidRuns, violations);

  const belowTargets = [];
  compareAxis(scenarios, targets?.targets, { missing: null, belowMin: "BELOW_TARGET", aboveMax: "BELOW_TARGET" }, invalidRuns, belowTargets);

  return { violations, belowTargets };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [reportPath, budgetsPath] = process.argv.slice(2);
  if (!reportPath) {
    console.error("사용법: check-budgets.mjs <report.json> [budgets.json]");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bPath = budgetsPath ?? path.join(here, "budgets.json");
  const tPath = path.join(path.dirname(bPath), "targets.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const budgets = JSON.parse(fs.readFileSync(bPath, "utf8"));
  const targets = fs.existsSync(tPath) ? JSON.parse(fs.readFileSync(tPath, "utf8")) : undefined;
  const { violations, belowTargets } = checkBudgets(report, budgets, targets);

  const describe = (v) => {
    switch (v.kind) {
      case "INVALID_CONDITIONS":
        return `  · ${v.path}: ${JSON.stringify(v.actual)} ≠ 예산 조건 ${JSON.stringify(v.limit)} — 조건이 다르면 비교 자체가 무효`;
      case "INVALID_RUN":
        return `  · ${v.path}: 실패한 런은 측정이 아니다 (${v.actual})`;
      case "MISSING":
        return `  · ${v.path}: 리포트에 없음(예산 ${JSON.stringify(v.limit)}) — 시나리오 무언 탈락 금지`;
      default:
        return `  · ${v.path}: ${v.actual} ${v.kind === "BELOW_MIN" ? "<" : ">"} 예산 ${v.limit} (${v.kind})`;
    }
  };

  if (violations.length > 0) {
    console.error(`perf-gate 실패 — 위반 ${violations.length}건 (${path.basename(reportPath)}):`);
    for (const v of violations) console.error(describe(v));
    if (belowTargets.length > 0) {
      console.error(`  (절대 목표 미달 ${belowTargets.length}건도 함께 있음 — 아래 참조)`);
      for (const t of belowTargets) console.error(`  · ${t.path}: ${t.actual} vs 목표 ${JSON.stringify(t.limit)}`);
    }
    process.exit(1);
  }

  const nBudgets = Object.keys(budgets.budgets ?? {}).length;
  if (belowTargets.length > 0) {
    // 회귀는 없다. 그러나 절대 목표에 못 미치므로 초록이 아니다 — 기준을 낮춰 초록을
    // 만드는 대신 미달을 그대로 드러낸다.
    console.error(`perf-gate 회귀 없음(${nBudgets}개 예산 통과) — 그러나 절대 목표 미달 ${belowTargets.length}건 (${path.basename(reportPath)}):`);
    for (const t of belowTargets) {
      const dir = typeof t.limit === "number" && t.actual < t.limit ? "<" : ">";
      console.error(`  · ${t.path}: ${t.actual} ${dir} 목표 ${t.limit}`);
    }
    process.exit(3);
  }

  console.log(`perf-gate 통과 — ${nBudgets}개 예산 + ${Object.keys(targets?.targets ?? {}).length}개 목표 전부 충족 (${path.basename(reportPath)})`);
  process.exit(0);
}
