#!/usr/bin/env node
// 배치 게이트 — 프레임워크에서 독립한 크레이트는 프레임워크의 마당에 살지 않는다.
//
// 왜 있나(실측 2026-07-29): `crates/` 밑 열 크레이트와 `crates/soksak-cli` 는 Cargo.toml
// 어디에도 tauri·wry·tao 가 없다. 그중 `soksak-cored` 는 tests/no_framework.rs 로 그 이름들을
// **대놓고 거부**하기까지 한다. 프레임워크를 이름으로 거부하는 코드가 그 프레임워크 이름의
// 폴더 안에 산다 — 폴더 이름은 소유를 말하므로(docs/REPO-LAYOUT.md), 읽는 사람은 "여기 있으니
// 저것의 일부"라고 읽고 다음 결합을 그 오독 위에 짓는다. 그 오독은 에러로 안 나온다.
//
// 지금 있는 검사는 크레이트 **하나**만 지킨다: no_framework.rs 는 자기 의존성 트리만 본다.
// 그러니 새 크레이트를 프레임워크 폴더 안에 하나 더 만들어도 아무도 세지 않는다. 여기서
// 그 법을 **배치**로 넓힌다 — 어느 크레이트가 어디 있고 무엇을 의존하는지 Cargo.toml 에서 잰다.
//
// 두 법(docs/REPO-LAYOUT.md §게이트).
//   L1 배치   프레임워크 무관 크레이트는 프레임워크의 마당 **밑에** 두지 않는다.
//   L2 의존   `frameworks/` 밖의 크레이트는 프레임워크 크레이트를 의존하지 않는다.
//
// 워크스페이스 루트가 프레임워크 앱인 것(공용 크레이트가 한 프레임워크의 빌드 단위에 산다)은
// 여기서 판정하지 않는다 — scripts/gates/workspace-root-not-framework.mjs 가 그 법의 주인이다.
// 같은 사실을 두 게이트가 재면 둘은 갈리고, 갈린 뒤에는 어느 쪽이 법인지 아무도 모른다.
//
// **마당은 이름으로 박지 않는다.** `frameworks/tauri` 를 상수로 넣으면 옮긴 다음 날 죽은 규칙이 된다.
// 마당은 둘로 유도한다: ① 선언 — `frameworks/<이름>/` 은 그 이름의 것이다. ② 실측 — 프레임워크
// 크레이트를 **직접** 의존하는 패키지의 디렉터리는 그 프레임워크의 마당이다(오늘의 `frameworks/tauri`).
//
// **재는 폭.** Cargo.toml 만 읽는다. crates.io 를 타고 깊이 들어온 프레임워크는 여기서 안 보인다 —
// 그 깊이는 `cargo tree` 를 쓰는 크레이트별 tests/no_framework.rs 가 맡는다. 두 검사는 짝이고,
// 어느 한쪽이 다른 쪽을 대신하지 않는다: 저쪽은 한 크레이트를 깊게, 여기는 전 크레이트를 넓게.
//
// **오늘은 RED 다.** 배치는 아직 안 옮겼고 위반 12 건이 그대로 서 있다(L1 11 · L2 1).
// KNOWN_DEBT 는 그 12 건이 **알려진 부채**임을 적을 뿐 통과시키지 않는다 — 법이 깨진 동안
// 이 게이트는 exit 1 이다. 장부의 일은 새 위반과 옛 부채를 가르는 것뿐이다.
//
// 래칫: 목록에 없는 위반이 나오면 새로 어긴 것이고, 목록에 있는데 위반이 없으면 고친 것이니
// 목록에서 뺀다. 옮기고도 장부를 비우지 않으면 그 수가 거짓이 되므로 그때도 exit 1 이다.
//
// 실행: node scripts/gates/framework-free-placement.mjs [--json]

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/**
 * 프레임워크 크레이트 — 창·이벤트 루프·번들을 주는 것.
 *
 * 어휘 넷 중 **framework 축만** 넣는다(docs/REPO-LAYOUT.md 표). objc2·windows-sys 는 platform,
 * rusqlite·notify 는 자원이다 — 여기 섞으면 이 게이트가 두 가지를 뜻하게 되고, 그때부터
 * "무엇을 어긴 것인가"에 답이 둘이 된다. 저 축들은 각자의 게이트가 맡는다.
 *
 * 대조는 **이름**으로 한다. 부분문자열로 보면 `tao` 가 여러 이름에 걸린다(no_framework.rs 가
 * 첫 판에서 그렇게 오탐했다) — 정확히 같거나 `<이름>-` 접두일 때만 프레임워크로 센다.
 */
export const FRAMEWORK_CRATES = ["tauri", "wry", "tao"];

export const isFrameworkCrate = (name) =>
  FRAMEWORK_CRATES.some((c) => name === c || name.startsWith(`${c}-`));

/**
 * 알려진 배치 부채 — 표준(docs/REPO-LAYOUT.md)은 섰고 트리는 아직 안 옮겼다.
 *
 * 여기 이름이 있다는 것은 "이미 세어진 위반"이라는 뜻이지 "허용"이 아니다. 옮기는 커밋이
 * 이 목록을 비운다. 목록에 없는 이름이 나오면 그것은 **새로** 어긴 것이다.
 */
export const KNOWN_DEBT = {
  why:
    "docs/REPO-LAYOUT.md 가 목표 배치를 세웠고 트리는 아직 그대로다 — " +
    "crates/* 로 옮기고 frameworks/tauri 를 세운 커밋이 이 목록을 비웠다(2026-07-29).",
  // L1 — frameworks/tauri(= Tauri 앱 패키지의 디렉터리) 밑에 사는 프레임워크 무관 크레이트.
  // 비어 있다 — 이주가 끝났다. 새 위반이 나면 그것은 배치를 되돌린 것이므로 여기 적지 말고
  // 옮겨라(이 장부는 이주 중의 임시 유예였지 영구 예외가 아니다).
  placement: [],
  // L2 — frameworks/ 밖에서 tauri 를 의존한다(앱 자신). frameworks/tauri 로 가면 사라진다.
  dependency: [],
};

/** 산출물·의존성 캐시·다른 체크아웃은 세지 않는다 — 워크트리 20 벌이 모든 판정을 20 배로 부풀린다. */
const SKIP_DIRS = new Set(["node_modules", "target", "dist"]);

function walkManifests(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .claude/worktrees · .github/fixtures
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkManifests(join(dir, e.name), out);
    } else if (e.name === "Cargo.toml") {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** 따옴표 밖의 `#` 부터가 주석이다 — 문자열 안의 `#` 을 자르면 값이 깨진다. */
function stripComment(line) {
  let out = "";
  let quote = null;
  for (const c of line) {
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#") break;
    out += c;
  }
  return out;
}

/** 인라인 테이블·배열의 열림 정도. 값이 여러 줄에 걸리면 닫힐 때까지 이어 붙여야 한다. */
function netDepth(text) {
  let d = 0;
  let quote = null;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{" || c === "[") d += 1;
    else if (c === "}" || c === "]") d -= 1;
  }
  return d;
}

/**
 * 의존성 표인가.
 *
 * `[patch.crates-io]` 는 의존이 아니라 **출처 교체**다(이 저장소는 거기서 tauri 계열 일곱을
 * 한 rev 로 물린다). 세면 그 블록만으로 프레임워크 무관 크레이트가 프레임워크로 둔갑한다.
 * `[workspace.dependencies]` 도 세지 않는다 — 선언은 사용이 아니고, 실제로 쓰는 크레이트는
 * 자기 표에 같은 이름을 다시 적으므로 오염이 새지 않는다.
 */
function depTable(section) {
  if (/^(patch|replace)\b/.test(section)) return null;
  if (/^workspace\./.test(section)) return null;
  const m = /(^|\.)(dependencies|dev-dependencies|build-dependencies)(\.([^.]+))?$/.exec(section);
  if (!m) return null;
  const table = m[2] === "dev-dependencies" ? "dev" : m[2] === "build-dependencies" ? "build" : "normal";
  return { table, subkey: m[4] ? m[4].replace(/^"|"$/g, "") : null };
}

/**
 * Cargo.toml 한 벌 — 패키지 이름과 의존성(이름·표·path)만.
 *
 * 워크스페이스 멤버 목록은 읽지 않는다 — 그 축의 판정은 workspace-root-not-framework.mjs 의
 * 것이고, 안 쓰는 실측을 들고 있으면 다음 사람이 그것으로 판정을 하나 더 만든다.
 *
 * 값이 여러 줄에 걸리는 인라인 테이블(`{ … }`)은 이어 붙여 읽는다. 한 줄만 보면 닫히지 않은
 * 항목 뒤가 통째로 안 읽히고, 안 읽힌 의존성은 **통과로 위장**한다.
 */
export function readManifest(file) {
  const out = { file, pkg: null, deps: [] };
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let section = "";
  let sub = null; // [dependencies.foo] 로 열린 항목
  let acc = null; // { key, text }
  let depth = 0;

  const push = (key, text) => {
    const name = key.replace(/^"|"$/g, "").split(".")[0]; // `tauri.workspace = true`
    const t = depTable(section);
    if (!t) return;
    out.deps.push({ name, table: t.table, path: /path\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null });
  };

  for (const raw of lines) {
    const line = stripComment(raw);
    if (acc) {
      acc.text += ` ${line.trim()}`;
      depth += netDepth(line);
      if (depth <= 0) {
        push(acc.key, acc.text);
        acc = null;
        depth = 0;
      }
      continue;
    }

    const head = line.trim();
    if (!head) continue;

    const sec = /^\[\s*([^\]]+?)\s*\]$/.exec(head);
    if (sec) {
      section = sec[1].trim();
      const t = depTable(section);
      sub = t?.subkey ?? null;
      // [dependencies.foo] 는 그 자체가 의존성 하나다. 안쪽 줄(features·version)은 의존성이 아니다.
      if (sub) out.deps.push({ name: sub, table: t.table, path: null });
      continue;
    }

    const kv = /^("?[A-Za-z0-9_.\- ]+"?)\s*=\s*(.*)$/.exec(head);
    if (!kv) continue;
    const key = kv[1].trim();
    const rest = kv[2];

    if (sub) {
      // 열린 항목의 안쪽 — path 만 거둔다.
      if (key === "path") {
        const p = /"([^"]+)"/.exec(rest)?.[1] ?? null;
        const last = out.deps[out.deps.length - 1];
        if (last && last.name === sub) last.path = p;
      }
      continue;
    }

    if (section === "package" && key === "name") {
      out.pkg = /"([^"]+)"/.exec(rest)?.[1] ?? null;
      continue;
    }

    if (!depTable(section)) continue;
    const opens = netDepth(rest);
    if (opens > 0) {
      acc = { key, text: rest };
      depth = opens;
    } else {
      push(key, rest);
    }
  }
  return out;
}

const rel = (root, p) => relative(root, p).split("\\").join("/");

/** `frameworks/<이름>` 안(또는 그 자신)인가 — L2 가 보는 **선언된** 마당. */
export const insideDeclaredFrameworks = (dir) => /^frameworks\/[^/]+(\/|$)/.test(dir);

const isUnder = (dir, home) => dir !== home && dir.startsWith(`${home}/`);

/**
 * 크레이트 전수 실측 — 어디 있고, 무엇을 의존하고, 프레임워크가 묻었는가.
 *
 * 오염은 이름으로 직접 묻고, 저장소 안 path 의존을 타고 번진다. dev 의존으로는 번지지 않는다 —
 * 검사만 쓰는 크레이트는 소비자의 링크 그래프에 들어가지 않는다. 다만 자기 자신은 오염된다:
 * 검사를 돌리려면 프레임워크가 있어야 하는 크레이트는 프레임워크 없이 못 도는 크레이트다.
 */
export function survey(root = REPO_ROOT) {
  const manifests = walkManifests(root).map(readManifest);
  const pkgs = manifests
    .filter((m) => m.pkg)
    .map((m) => ({
      name: m.pkg,
      dir: rel(root, dirname(m.file)),
      manifest: rel(root, m.file),
      deps: m.deps,
      framework: false,
      direct: false,
      via: null,
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));

  const byDir = new Map(pkgs.map((p) => [p.dir, p]));

  for (const p of pkgs) {
    // 표 순서가 아니라 무게로 고른다 — 앱이 tauri 를 **링크**하는 사실이 tauri-build 를 빌드에
    // 쓰는 사실 뒤에 가리면, 사유가 실제보다 가볍게 읽힌다(파일에서는 build-dependencies 가 위다).
    const weight = { normal: 0, build: 1, dev: 2 };
    const hit = p.deps
      .filter((d) => isFrameworkCrate(d.name))
      .sort((a, b) => weight[a.table] - weight[b.table])[0];
    if (hit) {
      p.framework = true;
      p.direct = true;
      p.via = `${hit.name}(${hit.table})`;
    }
  }
  // 번짐 — 오염된 크레이트를 path 로 무는 크레이트도 프레임워크를 진다.
  for (let moved = true; moved; ) {
    moved = false;
    for (const p of pkgs) {
      if (p.framework) continue;
      for (const d of p.deps) {
        if (!d.path || d.table === "dev") continue;
        const target = byDir.get(rel(root, resolve(root, p.dir, d.path)));
        if (target?.framework) {
          p.framework = true;
          p.via = `${target.name} 를 타고 ${target.via ?? "프레임워크"}`;
          moved = true;
          break;
        }
      }
    }
  }

  // 마당 ① 선언 — frameworks/<이름> 은 그 이름의 것이다.
  const homes = [];
  try {
    for (const e of readdirSync(join(root, "frameworks"), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        homes.push({ dir: `frameworks/${e.name}`, why: "선언된 프레임워크 마당" });
      }
    }
  } catch {
    /* frameworks/ 는 아직 없다 — 실측 마당만 선다 */
  }
  // 마당 ② 실측 — 프레임워크를 **직접** 의존하는 패키지의 디렉터리. 번져서 오염된 크레이트는
  // 마당이 아니다(그건 위반이지 소유가 아니다).
  for (const p of pkgs) {
    if (p.direct) homes.push({ dir: p.dir, why: `${p.name} 이 ${p.via} 를 의존한다` });
  }
  // 한 마당은 한 번만 선다 — `frameworks/tauri` 처럼 선언과 실측이 겹치면 같은 사실이 두 줄로
  // 나오고, 그때부터 마당 수가 프레임워크 수를 뜻하지 않는다(선언이 이긴다: 이름이 곧 소유다).
  const seen = new Set();
  const unique = homes.filter((h) => !seen.has(h.dir) && seen.add(h.dir));

  return { pkgs, homes: unique };
}

export function judge(root = REPO_ROOT) {
  const { pkgs, homes } = survey(root);
  const violations = [];

  for (const p of pkgs) {
    // L1 — 프레임워크 무관 크레이트가 마당 밑에 산다.
    if (!p.framework) {
      const home = homes.find((h) => isUnder(p.dir, h.dir));
      if (home) {
        violations.push({
          law: "placement",
          name: p.name,
          dir: p.dir,
          why: `${home.dir}/ 밑에 산다 — 프레임워크 의존이 하나도 없는데 그 프레임워크의 마당이다(${home.why})`,
        });
      }
      continue;
    }
    // L2 — frameworks/ 밖에서 프레임워크를 의존한다.
    if (!insideDeclaredFrameworks(p.dir)) {
      violations.push({
        law: "dependency",
        name: p.name,
        dir: p.dir,
        why: `${p.via} 를 의존하는데 frameworks/ 밖에 산다`,
      });
    }
  }

  return { pkgs, homes, violations };
}

export function verify(root = REPO_ROOT, known = KNOWN_DEBT) {
  const { pkgs, homes, violations } = judge(root);
  const problems = [];

  // 오라클 생존 — 매니페스트를 못 읽으면 위반 0 이 되어 통과로 위장한다("0 의 두 얼굴").
  if (pkgs.length === 0) problems.push("Cargo.toml 을 하나도 못 읽었다 — 게이트가 통과로 위장한다");

  const fresh = violations.filter((v) => !(known[v.law] ?? []).includes(v.name));
  for (const v of fresh) {
    problems.push(`${v.law} ${v.name}(${v.dir}): ${v.why} — 장부에 없다, 새로 어겼다`);
  }
  for (const law of ["placement", "dependency"]) {
    for (const name of known[law] ?? []) {
      if (!violations.some((v) => v.law === law && v.name === name)) {
        problems.push(`${law} ${name}: 이제 안 어긴다 — 장부에서 빼라`);
      }
    }
  }
  return { pkgs, homes, violations, fresh, problems };
}

function main() {
  const args = process.argv.slice(2);
  const { pkgs, homes, violations, fresh, problems } = verify();
  const count = (law) => violations.filter((v) => v.law === law).length;

  if (args.includes("--json")) {
    console.log(JSON.stringify({ pkgs, homes, violations, problems }, null, 2));
  } else {
    console.log("배치 — 프레임워크 무관 크레이트는 프레임워크 밖에 산다");
    console.log(`  크레이트 ${pkgs.length} · 프레임워크 마당 ${homes.map((h) => h.dir).join(" · ") || "없음"}`);
    console.log(
      `  위반: 배치 ${count("placement")} · 의존 ${count("dependency")} (그중 새 위반 ${fresh.length})`,
    );
    for (const v of violations) console.log(`  ✗ ${v.law} ${v.name} (${v.dir}) — ${v.why}`);
    for (const p of problems) console.log(`  ! ${p}`);
  }

  // 판정은 stderr 로 낸다 — --json 의 stdout 이 기계가 읽는 한 벌로 남아야 한다.
  if (violations.length > 0) {
    console.error(`framework-free-placement: FAIL — 법이 깨져 있다 (${violations.length}건)`);
    // 아직 안 옮긴 것과 새로 어긴 것을 갈라 말한다 — 한 통에 담으면 새 위반이 옛 부채 뒤에 숨는다.
    if (fresh.length === 0) console.error(`  전부 알려진 부채다 — ${KNOWN_DEBT.why}`);
    else for (const v of fresh) console.error(`  - 새 위반: ${v.law} ${v.name} (${v.dir})`);
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(`framework-free-placement: FAIL — 장부가 실측과 어긋난다 (${problems.length}건)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.error("framework-free-placement: PASS — 프레임워크 무관 크레이트가 모두 프레임워크 밖에 있다");
}

if (process.argv[1] && process.argv[1].endsWith("framework-free-placement.mjs")) main();
