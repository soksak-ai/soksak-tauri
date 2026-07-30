#!/usr/bin/env node
// 명령 소유 장부 — 앱이 부르는 백엔드 이름마다 **누가 답하는가**를 세운다.
//
// 왜 있나(실측 2026-07-29): 두 번째 프레임워크를 세우면서 "다 됐다"고 말할 수 있었다. 앱이
// 부르는 이름 171 개 중 42 개가 Tauri 에만 있고 이쪽에서는 아무도 안 받는데, 그 사실이
// 어디에도 **선언되어 있지 않아** 세는 자리가 없었기 때문이다. 런타임은 그것을
// FRAMEWORK_CONCEPT_ABSENT 로 답했고, 그 코드는 두 가지를 한 통에 담는다:
//
//   ① 그 프레임워크에 개념이 정말 없다(네이티브 자식 표면 — 콘텐츠가 페이지 안에 산다)
//   ② 아직 이식하지 않았다(스케줄러·시크릿·클립보드·웹소켓 …)
//
// 둘은 고칠 자리가 완전히 다르다. 섞이면 ②가 ①의 얼굴을 쓰고 영원히 남는다.
//
// 분류는 지어내지 않는다 — **증거에서 읽는다.**
//   cored 표에 있으면            core      (창도 앱 핸들도 없이 같은 답)
//   프레임워크 표에 answer 가 있으면 framework (창·네이티브 표면 — 어댑터마다 구현)
//   프레임워크 표에 delegated 면    renderer  (프로세스를 건널 이유가 없다)
//   프레임워크 표에 absent 면      absent    (그 프레임워크에 개념이 없다 — 선언된 부재)
//   cored 가 사유를 달고 거절하면  refused   (선언된 공백)
//   어디에도 없으면                gap       (= 이식 공백. 선언 없이는 통과 못 한다)
//
// absent 를 framework 로 세면 **이 프레임워크가 답하는 표면이 부풀려진다.** 실측(2026-07-29):
// framework 로 세던 24 중 10 이 absent 선언이었다 — 앱이 그 이름을 부르면
// FRAMEWORK_CONCEPT_ABSENT 를 받는데 장부는 "구현되어 있다"고 말했다. 그 차이는 오류가 아니라
// **다른 사실**로 퍼진다. 갈라 센 뒤 그 24 는 framework 15 · absent 9 가 된다(그 열 중 하나였던
// webview_emit_native 는 같은 날 지운 중복 선언이라 answer 쪽으로 돌아갔다).
//
// gap 은 래칫이다. 늘면 실패한다 — 새 프레임워크 표면을 이식 없이 늘리는 것을 막는다.
// 줄면 장부를 줄이라고 말한다 — 고친 것을 장부가 계속 부채로 들고 있으면 수가 거짓이 된다.
//
// 실행: node scripts/gates/command-ownership.mjs [--json]

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEDGER = join(ROOT, "scripts", "gates", "command-ownership.json");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const read = (p) => readFileSync(p, "utf8");

/** 앱이 부르는 백엔드 이름 — invoke("...") 의 리터럴만. 변수 호출은 이름을 알 수 없다. */
export function appInvokes(root = ROOT) {
  const names = new Set();
  for (const f of walk(join(root, "src"))) {
    if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f)) continue;
    // 주석 속 invoke("...") 는 호출이 아니다 — 세면 이미 없어진 이름이 영원히 공백으로 남는다
    // (실측: remote_confirm_resolve 는 Rust 핸들러가 0 인데 주석 다섯 줄로 공백이 됐다).
    const code = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/\binvoke\s*(?:<[^>]*>)?\s*\(\s*"([a-z_0-9]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * cored 가 **서빙하는** 이름 — `Command { name: ... }` 만.
 *
 * `name:` 을 통째로 긁으면 `Arg { name: ... }`(인자 이름)과 `Unserved { name: ... }`(대놓고
 * 거절하는 이름)까지 서빙으로 센다. 실측(2026-07-29): 통째 긁기 130 vs 실제 Command 63.
 * 그러면 거절이 서빙으로 둔갑하고, 더 나쁘게는 **정직하게 "못 한다"고 적을수록 공백 수가
 * 줄어든다** — 사유를 적는 행위가 은폐가 된다. 표 종류를 이름으로 가른다.
 */
/**
 * 표 원문에서 서빙 이름을 읽는다 — 인자로 받으므로 심은 원문으로도 잰다.
 *
 * `Command {` 와 `name:` 사이의 **주석을 건너뛴다.** 사유를 그 자리에 적는 것은 이 저장소의
 * 평범한 습관인데, 그것을 못 넘던 파서는 서빙하는 명령을 공백으로 둔갑시켰다(실측 2026-07-30:
 * download_verify 를 서빙하면서 게이트는 "어디서도 답하지 않는다"고 답했다). 주석 위치 같은
 * 서식이 계측을 바꾸면 그 수는 사실이 아니라 서식의 함수다.
 *
 * `Unserved {` 는 이름이 달라 여기 안 걸린다 — 거절을 서빙으로 세면 정직하게 적을수록 공백이
 * 줄어드는 함정이 돌아온다.
 */
export function coredServesIn(src) {
  return new Set(
    [...src.matchAll(/\bCommand\s*\{(?:\s*\/\/[^\n]*\n)*\s*name:\s*"([a-z_0-9]+)"/g)].map(
      (m) => m[1],
    ),
  );
}

/** cored 크레이트의 러스트 원문 전부 — 표가 어느 파일에 사는지는 계측의 문제가 아니다.
 *
 *  한 파일을 못 박으면 코드를 옮기는 것만으로 인구조사가 바뀐다(실측 2026-07-30: 거절 표
 *  35건을 옆 파일로 옮기자 공백이 27 → 62 로 뛰었다 — 아무것도 안 잃었는데 게이트는 이식이
 *  35건 후퇴했다고 답했다). 어디에 적었는지는 사람의 정리이고, 무엇을 서빙·거절하는지가 사실이다. */
function coredSources(root = ROOT) {
  return walk(join(root, "crates", "soksak-cored", "src"))
    .filter((f) => f.endsWith(".rs"))
    .map(read)
    .join("\n");
}

export function coredServes(root = ROOT) {
  return coredServesIn(coredSources(root));
}

/** cored 가 **사유를 달고 거절하는** 이름 — 선언된 공백. 미선언 공백과 갈라 센다. */
export function coredUnserved(root = ROOT) {
  const src = coredSources(root);
  const out = new Map();
  // 항목은 여러 줄이고 blocked_by 는 줄바꿈 이어붙임(`\\` + 개행)을 쓴다 — 이름만 잡고
  // 사유가 비지 않았는지만 본다. 사유 원문은 registry.rs 가 단일 진실이다.
  for (const m of src.matchAll(
    /Unserved\s*\{\s*name:\s*"([a-z_0-9]+)"\s*,\s*blocked_by:\s*"([\s\S]*?)",?\s*\}/g,
  )) {
    out.set(m[1], m[2].replace(/\\\s*\n\s*/g, " ").trim());
  }
  return out;
}

/** Tauri 가 등록한 이름 — invoke_handler 목록. */
export function tauriRegisters(root = ROOT) {
  const src = read(join(root, "frameworks/tauri", "src", "lib.rs"));
  // 대괄호를 세어 닫는다 — 첫 `]` 로 끊으면 목록 안의 `#[cfg(...)]` 에서 멈춰 그 뒤 이름을
  // 통째로 놓친다(실측: sidecar_* 넷과 titlebar_backing·window_activate 가 "Tauri 에 없음"으로 나왔다).
  const at = src.indexOf("generate_handler![");
  let block = "";
  if (at >= 0) {
    let depth = 0;
    for (let i = at + "generate_handler!".length; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          block = src.slice(at + "generate_handler![".length, i);
          break;
        }
      }
    }
  }
  return new Set(
    [...block.matchAll(/([a-z_0-9]+)\s*(?:,|\])/g)]
      .map((m) => m[1])
      .filter((n) => n.includes("_")),
  );
}

/**
 * 프레임워크 표의 이름 → 답하는 방식(framework|renderer|absent), 그리고 **중복 선언**.
 *
 * 중복을 소스 텍스트에서 잡는 이유: 표를 합치는 `native/index.cjs` 의 `assemble` 은 이미
 * 해석된 객체를 `Object.entries` 로 받는다. 그 시점에는 **한 파일 안의 중복이 존재하지
 * 않는다** — JS 객체 리터럴이 같은 키를 두 번 쓰면 뒤엣것이 앞엣것을 조용히 덮고, 남는 것은
 * 항목 하나다. 그래서 파일 사이 중복만 잡히고 파일 안 중복은 원리상 못 본다.
 *
 * 실측(2026-07-29): `webview_emit_native` 가 webview.cjs 안에 answer 로 한 번, absent 로 한 번
 * 선언되어 있었다. 뒤엣것이 이겨 그 명령은 **항상 거절**됐는데, 적재도 통과하고 표도
 * 답하므로 어디에도 오류가 나지 않았다. 텍스트 단계에서만 둘 다 보인다.
 */
export function frameworkTable(root = ROOT, dir = join("frameworks", "electron", "native")) {
  const owners = new Map();
  const declaredAt = new Map();
  const duplicates = [];
  for (const f of walk(join(root, dir))) {
    if (!f.endsWith(".cjs") || f.endsWith(".test.cjs")) continue;
    const src = read(f);
    const rel = relative(root, f);
    // 표 항목은 최상위 들여쓰기 2칸의 `name: {` 이고, 그 블록 안의 delegated/absent 로 갈린다.
    for (const m of src.matchAll(/^ {2}([a-z_0-9]+):\s*\{([\s\S]*?)^ {2}\},$/gm)) {
      const [, name, body] = m;
      if (!name.includes("_")) continue;
      const kind = /\bdelegated\s*:/.test(body)
        ? "renderer"
        : /\babsent\s*:/.test(body)
          ? "absent"
          : "framework";
      if (declaredAt.has(name)) {
        duplicates.push({ name, first: declaredAt.get(name), again: rel });
      }
      declaredAt.set(name, rel);
      owners.set(name, kind);
    }
  }
  return { owners, duplicates };
}

export function survey(root = ROOT) {
  const app = appInvokes(root);
  const cored = coredServes(root);
  const refused = coredUnserved(root);
  const tauri = tauriRegisters(root);
  const { owners: electron, duplicates } = frameworkTable(root);

  const rows = [];
  for (const name of [...app].sort()) {
    let owner = "gap";
    if (cored.has(name)) owner = "core";
    else if (electron.has(name)) owner = electron.get(name);
    // 사유를 달고 거절한 것은 **선언된 공백**이다. 미선언과 갈라야 "정직하게 적는 일"이
    // 진전으로 보인다 — 한 통에 담으면 사유를 적어도 수가 그대로라 적을 이유가 없다.
    else if (refused.has(name)) owner = "refused";
    rows.push({ name, owner, inTauri: tauri.has(name), why: refused.get(name) ?? null });
  }
  return { rows, app, cored, refused, tauri, electron, duplicates };
}

/**
 * 중복 선언 → 문제 문장. 순수 함수라 심은 입력으로 그대로 잰다.
 *
 * 같은 이름을 두 번 선언하면 뒤엣것이 이긴다 — 조용히. 적재도 통과하고 표도 답하므로
 * 오류가 어디에도 안 나고, 그 명령의 실제 답만 바뀐다.
 */
export function duplicateProblems(duplicates) {
  return duplicates.map(
    (d) => `${d.name}: 표에 두 번 선언됐다(${d.first}, ${d.again}) — 뒤엣것이 앞엣것을 조용히 덮는다`,
  );
}

export function verify(root = ROOT, ledgerPath = LEDGER) {
  const { rows, duplicates } = survey(root);
  const ledger = JSON.parse(read(ledgerPath));
  const declared = new Map(Object.entries(ledger.gaps ?? {}));
  const gaps = rows.filter((r) => r.owner === "gap");
  const problems = [];

  problems.push(...duplicateProblems(duplicates));

  for (const g of gaps) {
    if (!declared.has(g.name)) {
      problems.push(
        `${g.name}: 어디서도 답하지 않는데 장부에 없다 — 이식 공백은 선언하고 들어온다` +
          (g.inTauri ? " (Tauri 에는 있다)" : ""),
      );
      continue;
    }
    const d = declared.get(g.name);
    if (!d || typeof d.why !== "string" || d.why.length < 8) {
      problems.push(`${g.name}: 사유가 없다 — 사유 없는 공백은 영원히 남는다`);
      continue;
    }
    // 사유만으로는 부채가 어디로 갚히는지 모른다. 갈 자리를 함께 선언한다 — 그래야 다음
    // 사람이 "여기 붙일까 저기 붙일까"를 다시 판단하지 않고, 붙이는 자리가 흩어지지 않는다.
    if (!["core", "framework", "renderer", "unserved"].includes(d.to)) {
      problems.push(`${g.name}: 갈 자리(to)가 없다 — core|framework|renderer|unserved 중 하나`);
    }
  }
  // 고친 것을 장부가 계속 부채로 들면 수가 거짓이 된다.
  const names = new Set(gaps.map((g) => g.name));
  for (const name of declared.keys()) {
    if (!names.has(name)) problems.push(`${name}: 이제 누군가 답한다 — 장부에서 빼라`);
  }
  // 래칫 ① 미선언 공백은 늘지 않는다. 사유를 적는 일이 진전으로 보이려면 이 수가 따로 있어야 한다.
  const cap = Number(ledger.cap ?? 0);
  if (gaps.length > cap) {
    problems.push(`공백 ${gaps.length} 개 > 상한 ${cap} — 이식 없이 표면을 늘리지 마라`);
  }

  // 래칫 ② **답하지 않는 이름** — 부른 쪽이 값을 못 받는 모든 이름.
  //
  // 사유를 적는 것은 진전이지 답이 아니다. 부른 쪽에서 "선언거절"과 "미선언공백"은 같은
  // 사실이다: 값이 안 온다. 미선언만 세면 사유를 적는 순간 그 이름이 세는 자리에서 사라지고,
  // 영원히 안 답해도 게이트가 통과한다. 실측(2026-07-30): sidecar_open 이 선언거절에 앉아
  // 통과하는 동안 두 번째 프레임워크의 렌더러는 그 이름을 139번 부르고 139번 거절당했다 —
  // 브라우저 엔진이 뜨지 못했고 화면에는 "엔진 서피스 생성 실패"만 남았다.
  //
  // absent 는 여기 안 든다. 그것은 **증명된 부재**이고, 부른 쪽은 "없다"는 값을 받는다.
  const unanswered = rows.filter((r) => r.owner === "refused" || r.owner === "gap");
  const unansweredCap = Number(ledger.unansweredCap ?? 0);
  if (unanswered.length > unansweredCap) {
    problems.push(
      `답하지 않는 이름 ${unanswered.length} 개 > 상한 ${unansweredCap} — 사유를 적는 것은 답하는 것이 아니다`,
    );
  } else if (unanswered.length < unansweredCap) {
    // 줄어든 것을 장부가 안 따라오면 그 자리는 다음 사람이 채워도 되는 빈칸이 된다.
    problems.push(
      `답하지 않는 이름 ${unanswered.length} 개 < 상한 ${unansweredCap} — 상한을 줄여라(줄인 만큼이 진전이다)`,
    );
  }
  return { rows, gaps, unanswered, problems, cap, unansweredCap };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--seed")) {
    // 최초 장부 작성 — 실측을 그대로 옮긴다(분류는 증거에서 읽으므로 손으로 정하지 않는다).
    const { rows } = survey();
    const gaps = rows.filter((r) => r.owner === "gap");
    const prev = (() => {
      try {
        return JSON.parse(read(LEDGER));
      } catch {
        return { gaps: {} };
      }
    })();
    const out = {
      about:
        "이식 공백 장부 — 앱이 부르는데 이 프레임워크에서 아무도 답하지 않는 이름. " +
        "분류는 command-ownership.mjs 가 소스에서 실측하고, 여기에는 사유와 상한만 산다. " +
        "cap 은 미선언 공백의 래칫이고, unansweredCap 은 **답이 없는 이름 전체**(선언거절+미선언)의 " +
        "래칫이다. 둘 다 늘리지 마라. 사유를 적는 것은 답하는 것이 아니므로, 사유를 적어도 " +
        "unansweredCap 은 줄지 않는다 — 그 이름을 누군가 실제로 답할 때만 줄어든다.",
      cap: gaps.length,
      unansweredCap: rows.filter((r) => r.owner === "refused" || r.owner === "gap").length,
      gaps: Object.fromEntries(
        gaps.map((g) => [
          g.name,
          prev.gaps?.[g.name] ?? {
            why: g.inTauri
              ? "Tauri 에는 있다 — 아직 이 프레임워크로 옮기지 않았다"
              : "어느 프레임워크에도 없다 — 이름이 낡았거나 옮길 자리를 정하지 않았다",
          },
        ]),
      ),
    };
    writeFileSync(LEDGER, JSON.stringify(out, null, 2) + "\n");
    console.log(`장부 작성: 공백 ${gaps.length} 개 → ${relative(ROOT, LEDGER)}`);
    return;
  }

  const { rows, gaps, unanswered, problems, cap, unansweredCap } = verify();
  const by = (o) => rows.filter((r) => r.owner === o).length;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ rows, gaps: gaps.map((g) => g.name), problems }, null, 2));
  } else {
    console.log("명령 소유 — 앱이 부르는 이름의 답하는 자리");
    // 답이 오는 자리와 안 오는 자리를 **두 줄로 가른다.** 한 줄에 섞으면 부재 선언(확정된
    // 답)이 부채로 읽히거나, 거꾸로 부채가 선언으로 무마된다.
    const answered = by("core") + by("framework") + by("renderer") + by("absent");
    console.log(
      `  답이 온다 ${answered}: core ${by("core")} · framework ${by("framework")}` +
        ` · renderer ${by("renderer")} · 부재선언 ${by("absent")}`,
    );
    console.log(
      `  답이 없다 ${unanswered.length}/${unansweredCap}: 선언거절 ${by("refused")}` +
        ` · 미선언공백 ${gaps.length}/${cap}`,
    );
    // 공백은 어디로 갚히는지까지 보여야 계획이 된다 — 수만 보면 부채인지 설계인지 모른다.
    const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
    const plan = {};
    for (const g of gaps) {
      const to = ledger.gaps?.[g.name]?.to ?? "?";
      plan[to] = (plan[to] ?? 0) + 1;
    }
    console.log(`  공백이 갈 자리: ${Object.entries(plan).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  // 판정은 종료코드로 나간다. `--json` 은 기계가 읽는 자리라 사람 줄을 섞지 않는다 — 한 줄만
  // 붙어도 파싱이 통째로 죽고, 그러면 이 인구조사를 다른 장부와 붙일 수 없다.
  const machine = args.includes("--json");
  if (problems.length > 0) {
    if (!machine) console.log("\nFAIL: 소유가 선언되지 않은 이름이 있다");
    process.exit(1);
  }
  if (!machine) console.log("✓ 모든 이름의 답하는 자리가 선언되어 있다");
}

if (process.argv[1] && process.argv[1].endsWith("command-ownership.mjs")) main();
