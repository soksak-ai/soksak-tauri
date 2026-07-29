#!/usr/bin/env node
// 워크스페이스 루트는 프레임워크가 아니다 — 공유 크레이트가 **누구의 빌드 단위**에 사는지를 센다.
//
// 왜 있나(실측 2026-07-29): `frameworks/tauri/Cargo.toml` 한 파일이 둘을 겸한다. 1 행이 `[workspace]`,
// 4~7 행이 `[package] name = "soksak-dev"` — Tauri 앱 패키지다. 그 워크스페이스의 멤버 11 개
// (cli · crates/soksak-{core,cored,store,watch,ptyd,seal,spec-contract,spec-socket,spec-pty,
// spec-service})는 프레임워크 의존이 **0** 이다. 그중 soksak-cored 는 tests/no_framework.rs 로
// tauri·wry·tao 를 **이름으로** 금지한다. 프레임워크를 이름으로 거절하는 코드가 그 프레임워크
// 앱의 빌드 단위 안에 산다 — 선언과 배치가 정면으로 어긋난다.
//
// 무엇이 깨지나. 그 앱 패키지를 지우면 나머지 열한 개가 함께 무너진다. 더 나쁜 것은 cargo 의
// `[patch]` 가 **워크스페이스 루트에서만** 유효하다는 사실이다: 156~163 행이 tauri 계열 일곱
// 크레이트를 git rev 하나로 물려 놓았고, 그 고정은 같은 워크스페이스의 공유 크레이트 빌드에
// 그대로 얹힌다. "프레임워크 없이 답한다"는 보장이 빌드 단위에서는 이미 거짓이다.
//
// 판정은 지어내지 않는다 — 매니페스트에서 읽는다.
//   `[workspace]` 가 있는 파일          워크스페이스 루트
//   멤버 중 프레임워크 의존 0 인 것       공유 크레이트
//   공유 크레이트를 가진 워크스페이스만    이 게이트의 대상
//
// 대상에 대해서만 셋을 본다.
//   R1 루트 매니페스트가 프레임워크 의존을 선언한다 → 공유 코드가 프레임워크의 빌드 단위에 산다
//   R2 루트가 frameworks/ 안에 있다                → 프레임워크가 공유 코드의 부모다
//   R3 루트가 최상위도 crates/ 도 아니다            → 목표 배치(docs/REPO-LAYOUT.md)가 아니다
//
// 프레임워크 앱이 **제 워크스페이스**를 갖는 것은 위반이 아니다 — 멤버가 전부 프레임워크
// 의존이면 대상이 아니다. 막는 것은 하나다: 공유 코드가 남의 빌드 단위에 얹히는 것.
//
// 장부가 없다. 예외를 적을 자리를 두면 오늘의 배치가 첫 항목으로 적히고 이동은 영원히 미뤄진다
// — 위반은 0 으로만 간다. **지금 이 저장소는 어긴다(RED).** 고치는 길은 배치를 옮기는 것뿐이고,
// 옮기고 나면 이 파일을 한 줄도 손대지 않아도 GREEN 이 된다.
//
// 실행: node scripts/gates/workspace-root-not-framework.mjs [--json]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 프레임워크 크레이트 — 창·이벤트 루프·번들을 주는 것만. 사유를 단다.
 *
 * 어휘는 docs/REPO-LAYOUT.md 의 표가 정한다: framework(Tauri·Electron) / platform(OS) /
 * engine(웹뷰) / shell(명령 해석기). objc2·keyring·rusqlite 는 **자원**이지 프레임워크가
 * 아니다 — 창을 열지도 앱 핸들을 쥐지도 않는다. no_framework.rs 의 금지 목록을 그대로
 * 베끼지 않는 이유가 그것이다: 그 목록은 런타임(tokio·interprocess)까지 함께 막는다.
 * 여기서 그것들까지 막으면 이 게이트는 배치가 아니라 의존성을 심판하게 된다.
 */
export const FRAMEWORK_CRATES = new Map([
  ["tauri", "창·이벤트 루프·번들·IPC 를 준다. tauri-build·tauri-plugin-* 도 같은 뿌리다"],
  ["wry", "웹뷰를 창에 붙이는 런타임 — Tauri 가 그 위에 선다"],
  ["tao", "네이티브 창과 이벤트 루프 — 프레임워크가 하는 일 그 자체다"],
]);

/**
 * 워크스페이스 루트가 서도 되는 자리 — docs/REPO-LAYOUT.md 목표 배치. 사유를 단다.
 * 키는 저장소 루트 기준 상대 경로(빈 문자열 = 최상위).
 */
export const ALLOWED_WORKSPACE_DIRS = new Map([
  ["", "저장소 최상위 — 어느 프레임워크의 이름도 아니다"],
  ["crates", "프레임워크 없는 Rust 의 집 — 목표 배치가 여기를 가리킨다"],
]);

/** 프레임워크 폴더. 이 아래의 워크스페이스는 공유 크레이트를 멤버로 들 수 없다. */
export const FRAMEWORKS_DIR = "frameworks";

/** 빌드 산출물과 남의 체크아웃 — 이 저장소의 빌드가 아니다. */
const SKIP_DIRS = new Set(["node_modules", "target", "dist"]);

const DEP_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);

const posix = (p) => p.split(sep).join("/");

/** 주석 밖의 문자만 남긴다 — `#` 이 따옴표 안에 있으면 주석이 아니다. */
function stripComment(line) {
  let out = "";
  let quote = null;
  for (const ch of line) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

/**
 * 표 이름을 점으로 가른다 — 따옴표 안의 점은 구분자가 아니다.
 * `target.'cfg(target_os = "linux")'.dependencies` → [target, cfg(...), dependencies]
 */
function splitSection(name) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (const ch of name) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      segs.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.filter((s) => s.length > 0);
}

/**
 * 이 표가 의존성 표인가 — 맞으면 표 이름과(하위 표면) 크레이트 이름을 준다.
 *
 * `[dependencies]` 만 보면 프레임워크가 세 자리로 새 나간다: `[build-dependencies]`(tauri-build),
 * `[target.'cfg(...)'.dependencies]`(플랫폼별), `[patch.crates-io]`(rev 고정). 실측한 그 셋을
 * 다 센다.
 */
function depTableOf(segs) {
  if (segs.length === 0) return null;
  // `[patch.*]` 는 의존 간선이 아니라 **소스 대체**다. 그리고 cargo 는 그것을 워크스페이스
  // 루트에서만 인정한다 — 멤버에 두면 `patch for the non root package will be ignored` 경고만
  // 내고 무시한다(실측). 즉 상류 패치가 필요한 저장소는 루트 매니페스트에 프레임워크 이름을
  // **적을 수밖에 없다.** 그것을 의존으로 세면 이 게이트는 고칠 수 없는 위반을 영원히 낸다.
  //
  // 루트가 프레임워크의 빌드 단위인지는 [package] 와 진짜 의존 표가 말한다. patch 는 그
  // 판정에서 뺀다 — 대신 아래 depsOf 가 그 사실을 값으로 남겨 진단에 싣는다.
  if (segs[0] === "patch") return null;
  let at = -1;
  if (DEP_TABLES.has(segs[0])) at = 0;
  else if (segs[0] === "workspace" && DEP_TABLES.has(segs[1])) at = 1;
  else if (segs[0] === "target" && DEP_TABLES.has(segs[2])) at = 2;
  if (at < 0) return null;
  return { table: segs.slice(0, at + 1).join("."), crate: segs[at + 1] ?? null };
}

/**
 * 매니페스트에서 배치 판정에 필요한 것만 읽는다 — 워크스페이스 여부·멤버·패키지 이름·의존 크레이트.
 *
 * TOML 전체를 해석하지 않는다. 다만 **덜 읽어서 통과하는 일**은 없어야 하므로, 의존 이름은
 * 표 종류를 가려 전부 모으고 `pkg = { package = "tauri" }` 같은 개명도 실체 이름으로 센다.
 */
export function parseManifest(text) {
  const deps = new Map();
  const members = [];
  let section = [];
  let hasWorkspace = false;
  let packageName = null;
  let membersOpen = false;

  const add = (crate, table) => {
    if (!crate) return;
    if (!deps.has(crate)) deps.set(crate, new Set());
    deps.get(crate).add(table);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      membersOpen = false;
      section = splitSection(header[1]);
      if (section[0] === "workspace") hasWorkspace = true;
      const dt = depTableOf(section);
      if (dt?.crate) add(dt.crate, dt.table);
      continue;
    }

    if (membersOpen) {
      for (const m of line.matchAll(/"([^"]+)"/g)) members.push(m[1]);
      if (line.includes("]")) membersOpen = false;
      continue;
    }

    if (section.length === 1 && section[0] === "workspace") {
      const mm = line.match(/^\s*members\s*=\s*\[(.*)$/);
      if (mm) {
        for (const m of mm[1].matchAll(/"([^"]+)"/g)) members.push(m[1]);
        membersOpen = !mm[1].includes("]");
        continue;
      }
    }

    if (section.length === 1 && section[0] === "package") {
      const nm = line.match(/^\s*name\s*=\s*"([^"]+)"/);
      if (nm) packageName = nm[1];
      continue;
    }

    const dt = depTableOf(section);
    if (!dt) continue;
    if (dt.crate) {
      // 하위 표(`[dependencies.foo]`) 안에서는 개명만 더 본다 — 이름은 머리글이 이미 줬다.
      const pk = line.match(/^\s*package\s*=\s*"([^"]+)"/);
      if (pk) add(pk[1], dt.table);
      continue;
    }
    const kv = line.match(/^\s*("([^"]+)"|[A-Za-z0-9_.+-]+)\s*=/);
    if (!kv) continue;
    // `foo.workspace = true` 의 크레이트는 foo 다.
    add((kv[2] ?? kv[1]).split(".")[0], dt.table);
    // 이름을 바꿔 달아도 실체는 package 가 말한다 — `app = { package = "tauri" }`.
    const pk = line.match(/package\s*=\s*"([^"]+)"/);
    if (pk) add(pk[1], dt.table);
  }

  return { hasWorkspace, packageName, members, deps };
}

/** 이름으로 대조한다 — 부분문자열이면 `taos`·`wryte` 같은 남의 이름을 오탐한다. */
export function isFrameworkCrate(name) {
  for (const fw of FRAMEWORK_CRATES.keys()) {
    if (name === fw || name.startsWith(`${fw}-`)) return true;
  }
  return false;
}

export function frameworkDepsOf(parsed) {
  const out = [];
  for (const [crate, tables] of parsed.deps) {
    if (isFrameworkCrate(crate)) out.push({ crate, tables: [...tables].sort() });
  }
  return out.sort((a, b) => a.crate.localeCompare(b.crate));
}

/** Cargo.toml 을 전부 찾는다. 점으로 시작하는 폴더와 빌드 산출물은 이 저장소의 빌드가 아니다. */
export function findManifests(root) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // `.claude/worktrees` 는 다른 세션의 체크아웃이고 `.github/fixtures` 는 CI 픽스처다.
      // 세면 같은 위반이 수십 벌로 불어나 진짜 한 건이 묻힌다.
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name === "Cargo.toml") out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `a/b/../c` 를 `a/c` 로 접는다. 접지 않으면 멤버 경로가 실측 목록과 글자로 안 맞아
 * **읽은 멤버가 "못 읽음"으로 둔갑**하고, 그 자리에서 공유 크레이트 수가 0 이 된다.
 */
function normalizeRel(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** 멤버 한 줄을 실제 매니페스트 경로들로 편다 — `crates/*` 같은 글롭을 포함한다. */
function expandMember(root, dirRel, spec) {
  const base = normalizeRel(dirRel ? `${dirRel}/${spec}` : spec);
  if (!base.includes("*")) return [`${base}/Cargo.toml`];
  const at = base.lastIndexOf("/");
  const parent = base.slice(0, at);
  const pattern = base.slice(at + 1);
  const rx = new RegExp(`^${pattern.split("*").map(escapeRx).join("[^/]*")}$`);
  let names;
  try {
    names = readdirSync(join(root, parent));
  } catch {
    // 못 편 글롭을 빈 배열로 삼키면 멤버 0 개인 워크스페이스로 위장해 통과한다.
    return [`${base}/Cargo.toml`];
  }
  const hits = names
    .filter((n) => rx.test(n))
    .map((n) => `${parent}/${n}/Cargo.toml`)
    .filter((rel) => existsSync(join(root, rel)));
  return hits.length > 0 ? hits.sort() : [`${base}/Cargo.toml`];
}

export function survey(root = REPO_ROOT) {
  const manifests = findManifests(root).map((path) => ({
    path,
    rel: posix(relative(root, path)),
    parsed: parseManifest(readFileSync(path, "utf8")),
  }));
  const byRel = new Map(manifests.map((m) => [m.rel, m]));

  const workspaces = [];
  for (const m of manifests) {
    if (!m.parsed.hasWorkspace) continue;
    const dir = posix(relative(root, dirname(m.path)));
    const members = [];
    for (const spec of m.parsed.members) {
      for (const rel of expandMember(root, dir, spec)) {
        const found = byRel.get(rel);
        members.push({
          spec,
          rel,
          missing: !found,
          packageName: found?.parsed.packageName ?? null,
          frameworkDeps: found ? frameworkDepsOf(found.parsed) : [],
        });
      }
    }
    workspaces.push({
      rel: m.rel,
      dir,
      packageName: m.parsed.packageName,
      frameworkDeps: frameworkDepsOf(m.parsed),
      members,
      // 공유 크레이트 = 프레임워크 의존 0 인 멤버. 이것이 있어야 이 게이트의 대상이다.
      shared: members.filter((x) => !x.missing && x.frameworkDeps.length === 0).map((x) => x.rel),
    });
  }
  return { root, manifests, workspaces };
}

export function verify(root = REPO_ROOT) {
  const { manifests, workspaces } = survey(root);
  const problems = [];

  // 오라클 생존 — 아무것도 못 읽으면 이 게이트는 아무것도 안 지키면서 통과한다.
  if (manifests.length === 0) {
    problems.push("Cargo.toml 을 하나도 못 읽었다 — 못 읽은 게이트는 통과로 위장한다");
  } else if (workspaces.length === 0) {
    problems.push("[workspace] 를 가진 매니페스트가 없다 — 워크스페이스 루트를 못 찾았다");
  }

  for (const ws of workspaces) {
    for (const m of ws.members) {
      if (m.missing) {
        problems.push(
          `${ws.rel}: 멤버 ${m.rel} 를 못 읽었다 — 못 읽은 멤버를 "프레임워크 없음"으로 세지 않는다`,
        );
      }
    }
    if (ws.shared.length === 0) continue;

    const who = ws.packageName ? `루트 패키지 ${ws.packageName}` : "루트 매니페스트";
    if (ws.frameworkDeps.length > 0) {
      const named = ws.frameworkDeps
        .map((d) => `${d.crate}(${d.tables.join(",")})`)
        .join(" · ");
      problems.push(
        `${ws.rel}: ${who} 가 프레임워크를 의존한다 — ${named}. ` +
          `프레임워크 없는 멤버 ${ws.shared.length} 개가 이 빌드 단위에 얹혀 있다` +
          `(${ws.shared.slice(0, 3).join(", ")}${ws.shared.length > 3 ? " …" : ""})`,
      );
    }
    if (ws.dir === FRAMEWORKS_DIR || ws.dir.startsWith(`${FRAMEWORKS_DIR}/`)) {
      problems.push(
        `${ws.rel}: 워크스페이스 루트가 ${FRAMEWORKS_DIR}/ 안에 있다 — ` +
          `프레임워크는 공유 코드의 형제지 부모가 아니다`,
      );
    }
    if (!ALLOWED_WORKSPACE_DIRS.has(ws.dir)) {
      const where = [...ALLOWED_WORKSPACE_DIRS.keys()].map((d) => d || "(최상위)").join(" 또는 ");
      problems.push(
        `${ws.rel}: 워크스페이스 루트가 ${ws.dir}/ 에 있다 — 공유 크레이트의 빌드 단위는 ${where} 에 선다`,
      );
    }
  }
  return { workspaces, problems };
}

function main() {
  const args = process.argv.slice(2);
  const { workspaces, problems } = verify();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ workspaces, problems }, null, 2));
  } else {
    console.log("워크스페이스 루트 — 공유 크레이트가 사는 빌드 단위");
    const shared = workspaces.filter((w) => w.shared.length > 0);
    console.log(`  워크스페이스 ${workspaces.length} · 공유 크레이트를 가진 것 ${shared.length}`);
    for (const ws of workspaces) {
      console.log(
        `  ${ws.rel}: 패키지 ${ws.packageName ?? "(없음)"}` +
          ` · 프레임워크 의존 ${ws.frameworkDeps.length}` +
          ` · 멤버 ${ws.members.length}(프레임워크 없음 ${ws.shared.length})`,
      );
    }
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  if (problems.length > 0) {
    console.log("\nFAIL: 공유 크레이트가 프레임워크의 빌드 단위에 산다");
    console.log("고치는 길은 배치를 옮기는 것 하나다 — docs/REPO-LAYOUT.md 목표 배치.");
    console.log("여기에 예외를 적을 자리는 없다. 옮기면 이 게이트는 손대지 않아도 통과한다.");
    process.exit(1);
  }
  console.log("✓ 공유 크레이트의 워크스페이스 루트가 프레임워크가 아니다");
}

if (process.argv[1] && process.argv[1].endsWith("workspace-root-not-framework.mjs")) main();
