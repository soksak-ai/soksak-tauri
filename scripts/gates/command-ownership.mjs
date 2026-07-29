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
//   어디에도 없으면                gap       (= 이식 공백. 선언 없이는 통과 못 한다)
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
export function coredServes(root = ROOT) {
  const src = read(join(root, "crates", "soksak-cored", "src", "registry.rs"));
  return new Set([...src.matchAll(/Command\s*\{\s*name:\s*"([a-z_0-9]+)"/g)].map((m) => m[1]));
}

/** cored 가 **사유를 달고 거절하는** 이름 — 선언된 공백. 미선언 공백과 갈라 센다. */
export function coredUnserved(root = ROOT) {
  const src = read(join(root, "crates", "soksak-cored", "src", "registry.rs"));
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

/** 프레임워크 표의 이름 → 답하는 방식(answer|delegated). */
export function frameworkTable(root = ROOT, dir = join("frameworks", "electron", "native")) {
  const out = new Map();
  for (const f of walk(join(root, dir))) {
    if (!f.endsWith(".cjs") || f.endsWith(".test.cjs")) continue;
    const src = read(f);
    // 표 항목은 최상위 들여쓰기 2칸의 `name: {` 이고, 그 블록 안의 answer/delegated 로 갈린다.
    for (const m of src.matchAll(/^ {2}([a-z_0-9]+):\s*\{([\s\S]*?)^ {2}\},$/gm)) {
      const [, name, body] = m;
      if (!name.includes("_")) continue;
      out.set(name, /\bdelegated\s*:/.test(body) ? "renderer" : "framework");
    }
  }
  return out;
}

export function survey(root = ROOT) {
  const app = appInvokes(root);
  const cored = coredServes(root);
  const refused = coredUnserved(root);
  const tauri = tauriRegisters(root);
  const electron = frameworkTable(root);

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
  return { rows, app, cored, refused, tauri, electron };
}

export function verify(root = ROOT, ledgerPath = LEDGER) {
  const { rows } = survey(root);
  const ledger = JSON.parse(read(ledgerPath));
  const declared = new Map(Object.entries(ledger.gaps ?? {}));
  const gaps = rows.filter((r) => r.owner === "gap");
  const problems = [];

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
  // 래칫 — 공백은 늘지 않는다.
  const cap = Number(ledger.cap ?? 0);
  if (gaps.length > cap) {
    problems.push(`공백 ${gaps.length} 개 > 상한 ${cap} — 이식 없이 표면을 늘리지 마라`);
  }
  return { rows, gaps, problems, cap };
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
        "cap 은 래칫이다: 늘리지 마라. 하나 이식할 때마다 항목을 빼고 cap 을 줄인다.",
      cap: gaps.length,
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

  const { rows, gaps, problems, cap } = verify();
  const by = (o) => rows.filter((r) => r.owner === o).length;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ rows, gaps: gaps.map((g) => g.name), problems }, null, 2));
  } else {
    console.log("명령 소유 — 앱이 부르는 이름의 답하는 자리");
    console.log(
      `  core ${by("core")} · framework ${by("framework")} · renderer ${by("renderer")}` +
        ` · 선언거절 ${by("refused")} · 미선언공백 ${gaps.length}/${cap}`,
    );
    // 답하지 않는 총수도 함께 낸다 — 미선언만 보면 사유를 적는 것이 수를 줄인 것처럼 보인다.
    console.log(`  답하지 않는 이름 합계: ${by("refused") + gaps.length}`);
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
  if (problems.length > 0) {
    console.log("\nFAIL: 소유가 선언되지 않은 이름이 있다");
    process.exit(1);
  }
  console.log("✓ 모든 이름의 답하는 자리가 선언되어 있다");
}

if (process.argv[1] && process.argv[1].endsWith("command-ownership.mjs")) main();
