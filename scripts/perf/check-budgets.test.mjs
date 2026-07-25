// 예산 게이트 자체 검증(M3 RED→GREEN) — 게이트가 위반을 놓치면 회귀 감지망 전체가 무효라
// 게이트를 먼저 검증한다: 위반 픽스처 → 위반 열거(exit 1 경로), 통과 픽스처 → 위반 0.
// 러너는 vitest 하나(vitest.config.ts scripts/**/*.test.mjs — 검사 메커니즘을 늘리지 않는다).
// 실행: pnpm vitest run scripts/perf/check-budgets.test.mjs (make perf-gate 가 실측 전 선행)
import { test } from "vitest";
import assert from "node:assert/strict";
import { checkBudgets } from "./check-budgets.mjs";

const budgets = {
  budgets: {
    "t1_plain.mbps": { min: 10 },
    "t1_plain.cpu.avg": { max: 120 },
    "t2.medianMs": { max: 20 },
    "t2.p95Ms": { max: 40 },
    "t5_idle.cpu.avg": { max: 3 },
    "t6_memory.rssMb": { max: 900 },
  },
};

const passingReport = {
  scenarios: {
    t1_plain: { mbps: 25.1, cpu: { avg: 80.2, max: 130 } },
    t2: { medianMs: 8.5, p95Ms: 14.2 },
    t5_idle: { cpu: { avg: 1.1, max: 4.0 } },
    t6_memory: { rssMb: 512 },
  },
};

test("통과 픽스처 → 위반 0", () => {
  const { violations } = checkBudgets(passingReport, budgets);
  assert.deepEqual(violations, []);
});

test("min 위반(처리량 하락)과 max 위반(레이턴시 상승)을 열거한다", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t1_plain.mbps = 3.2; // min 10 미달
  report.scenarios.t2.p95Ms = 95; // max 40 초과
  const { violations } = checkBudgets(report, budgets);
  assert.equal(violations.length, 2);
  const byPath = Object.fromEntries(violations.map((v) => [v.path, v]));
  assert.equal(byPath["t1_plain.mbps"].kind, "BELOW_MIN");
  assert.equal(byPath["t1_plain.mbps"].actual, 3.2);
  assert.equal(byPath["t1_plain.mbps"].limit, 10);
  assert.equal(byPath["t2.p95Ms"].kind, "ABOVE_MAX");
  assert.equal(byPath["t2.p95Ms"].actual, 95);
  assert.equal(byPath["t2.p95Ms"].limit, 40);
});

test("리포트에 예산 지표가 없으면 MISSING 위반 — 시나리오 무언 탈락 방지", () => {
  const report = structuredClone(passingReport);
  delete report.scenarios.t2; // t2 통째 누락
  delete report.scenarios.t5_idle.cpu; // 중간 경로 누락
  const { violations } = checkBudgets(report, budgets);
  const kinds = Object.fromEntries(violations.map((v) => [v.path, v.kind]));
  assert.equal(kinds["t2.medianMs"], "MISSING");
  assert.equal(kinds["t2.p95Ms"], "MISSING");
  assert.equal(kinds["t5_idle.cpu.avg"], "MISSING");
});

test("경계값은 통과(초과/미달만 위반)", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t1_plain.mbps = 10; // == min
  report.scenarios.t2.medianMs = 20; // == max
  const { violations } = checkBudgets(report, budgets);
  assert.deepEqual(violations, []);
});

test("숫자가 아닌 지표값은 MISSING 취급", () => {
  const report = structuredClone(passingReport);
  report.scenarios.t2.medianMs = "n/a";
  const { violations } = checkBudgets(report, budgets);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "MISSING");
});

// ── 조건 강제 ────────────────────────────────────────────────────────────────
// 예산은 측정 조건 아래에서만 뜻을 가진다. 조건이 다른 리포트를 예산과 대조하는 것은
// 비교가 아니라 오류다 — budgets.json / run-t.sh / README 가 세 곳에서 선언만 하고
// 비교기가 강제하지 않으면 다른 조건의 초록이 같은 초록으로 보인다.

const conditioned = {
  meta: {
    conditions: { identity: "debug", cargoProfile: "release", windowsOpen: 7, machine: "Apple M1 Pro" },
  },
  budgets: { "t5_idle.cpu.avg": { max: 60 } },
};
const conditionedReport = {
  meta: { identity: "debug", cargoProfile: "release", windowsOpen: 7, machine: "Apple M1 Pro" },
  scenarios: { t5_idle: { cpu: { avg: 12.0 } } },
};

test("조건이 전부 일치하면 위반 0", () => {
  const { violations } = checkBudgets(conditionedReport, conditioned);
  assert.deepEqual(violations, []);
});

test("창 개수가 다르면 INVALID_CONDITIONS — 예산 비교 자체가 무효", () => {
  const report = structuredClone(conditionedReport);
  report.meta.windowsOpen = 1;
  const { violations } = checkBudgets(report, conditioned);
  const v = violations.find((x) => x.path === "meta.windowsOpen");
  assert.equal(v?.kind, "INVALID_CONDITIONS");
  assert.equal(v.actual, 1);
  assert.equal(v.limit, 7);
});

test("cargo 프로파일이 다르면 INVALID_CONDITIONS — 비최적화 수치는 최적화 예산과 비교 불가", () => {
  const report = structuredClone(conditionedReport);
  report.meta.cargoProfile = "dev";
  const { violations } = checkBudgets(report, conditioned);
  assert.equal(violations.find((x) => x.path === "meta.cargoProfile")?.kind, "INVALID_CONDITIONS");
});

test("리포트에 조건 필드가 없으면 INVALID_CONDITIONS — 침묵 통과 금지", () => {
  const report = structuredClone(conditionedReport);
  delete report.meta.cargoProfile;
  const { violations } = checkBudgets(report, conditioned);
  assert.equal(violations.find((x) => x.path === "meta.cargoProfile")?.kind, "INVALID_CONDITIONS");
});

// ── 실패한 런은 측정이 아니다 ────────────────────────────────────────────────
// driver 가 mbps 를 디스크 픽스처 크기로 계산하므로, 시나리오가 죽어도 만점이 찍힌다.
// results/20260711-142832-ab-local-debug.json 이 실제 사례다: exitCode 1, 실전송 765 B,
// 기록 mbps 10000 — min 예산 3.2 의 3125배.

const runBudgets = { budgets: { "t1_plain.mbps": { min: 10 } } };

test("exitCode != 0 인 시나리오는 점수를 못 낸다 — INVALID_RUN", () => {
  const report = {
    scenarios: { t1_plain: { mbps: 10000, exitCode: 1, counters: { writtenBytesDelta: 765 } } },
  };
  const { violations } = checkBudgets(report, runBudgets);
  assert.equal(violations.find((x) => x.path === "t1_plain")?.kind, "INVALID_RUN");
});

test("보고 바이트와 실전송 바이트가 어긋나면 INVALID_RUN", () => {
  const report = {
    scenarios: {
      t1_plain: { mbps: 10000, exitCode: 0, bytes: 104857600, counters: { writtenBytesDelta: 765 } },
    },
  };
  const { violations } = checkBudgets(report, runBudgets);
  assert.equal(violations.find((x) => x.path === "t1_plain")?.kind, "INVALID_RUN");
});

test("바이트가 오차 범위 안이면 유효한 런", () => {
  const report = {
    scenarios: {
      t1_plain: { mbps: 25, exitCode: 0, bytes: 104857600, counters: { writtenBytesDelta: 106010661 } },
    },
  };
  const { violations } = checkBudgets(report, runBudgets);
  assert.deepEqual(violations, []);
});

// ── 회귀 게이트 ≠ 절대 목표 ──────────────────────────────────────────────────
// baseline × headroom 은 회귀 검출에는 옳지만 절대 결함은 구조적으로 못 잡는다.
// 유휴 46.4% 를 baseline 으로 삼으면 예산 60 이 반쪽 코어를 정상으로 인증한다.
// 두 축을 분리해 둘 다 보고하되 서로 섞지 않는다.

const targets = { targets: { "t5_idle.cpu.avg": { max: 5 }, "t1_plain.mbps": { min: 100 } } };

test("회귀는 통과해도 절대 목표 미달은 BELOW_TARGET 으로 별도 보고", () => {
  const report = {
    meta: {},
    scenarios: { t5_idle: { cpu: { avg: 46.4 } }, t1_plain: { mbps: 4.58, exitCode: 0 } },
  };
  const b = { budgets: { "t5_idle.cpu.avg": { max: 60 }, "t1_plain.mbps": { min: 3.2 } } };
  const { violations, belowTargets } = checkBudgets(report, b, targets);
  assert.deepEqual(violations, [], "회귀 예산 안에 있으므로 위반은 없어야 한다");
  const paths = belowTargets.map((t) => t.path).sort();
  assert.deepEqual(paths, ["t1_plain.mbps", "t5_idle.cpu.avg"]);
  assert.equal(belowTargets.find((t) => t.path === "t5_idle.cpu.avg").kind, "BELOW_TARGET");
});

test("목표를 만족하면 belowTargets 는 빈 배열", () => {
  const report = { meta: {}, scenarios: { t5_idle: { cpu: { avg: 2.1 } }, t1_plain: { mbps: 180 } } };
  const { belowTargets } = checkBudgets(report, { budgets: {} }, targets);
  assert.deepEqual(belowTargets, []);
});

test("targets 를 안 주면 belowTargets 는 빈 배열(기존 호출부 무영향)", () => {
  const { belowTargets } = checkBudgets(passingReport, budgets);
  assert.deepEqual(belowTargets, []);
});
