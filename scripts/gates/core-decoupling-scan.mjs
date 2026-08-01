// C1 결합 스캔 게이트 — 코어(src/·frameworks/tauri/)에서 특정 플러그인 id 문자열을 차단한다.
// 법(C-법, docs/ARCHITECTURE.md 결합 법칙): 코어는 특정 플러그인과 강결합하지 않는다.
// 대상은 실행 경로 코드(핸들러·상수·분기)와 배포 문서(스킬 등 코어와 함께 출하되는 문서)다.
//
// 위반 = "soksak-plugin-" 뒤에 실제 id 문자([a-z0-9])가 이어지는 토큰.
//   위반이 아닌 것(패턴이 애초에 잡지 않는다):
//   - placeholder: soksak-plugin-<id> ("<" 는 id 문자가 아니다)
//   - 접두 문법 메커니즘: "soksak-plugin-" 리터럴, `soksak-plugin-${...}` 합성,
//     /^soksak-plugin-/ 류 정규식 소스 — 명명 문법 자체는 generic 이다.
//
// 구조 제외(스코프 규칙 — allowlist 아님):
//   - *.test.ts / *.test.tsx / *.test.mjs — 테스트 픽스처 영역, 실행 경로가 아니다.
//   - Rust 최상위 #[cfg(test)] mod 블록 — 같은 이유. 위치 무관(말미·중간·복수) 각 모듈만
//     brace 깊이로 건너뛰고, 그 앞뒤 최상위 실행 경로 코드는 계속 스캔한다.
//   - target, frameworks/tauri/gen, node_modules, .git — 산출물·외부물.
//
// ALLOWLIST 는 아래 목록이 전부다. 추가는 C5 절차(명시 문제 제기 → 재입법 커밋)로만 한다.
// 무언 추가 금지. stale 항목(파일은 있는데 매칭 0건)은 실패다 — 죽은 예외를 남기지 마라.
//
// 사용: node scripts/gates/core-decoupling-scan.mjs [--root <dir>]
// exit 0 = 위반 0건, exit 1 = 위반 또는 stale allowlist. blocking 게이트다.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// 위반 후보 토큰: 접두 뒤에 실제 id 가 시작되는 경우만. 스펙 판 접미(@N)까지 토큰에 포함해
// allowlist 판정이 토큰 전체를 보게 한다.
const TOKEN = /soksak-plugin-[a-z0-9][a-z0-9-]*(?:@[0-9]+)?/g;

// 명시 allowlist — 파일+사유 쌍. token/line 정규식이 있으면 그 매칭에만 적용된다(파일 전체 아님).
export const ALLOWLIST = [
  {
    file: "src/state/registry.ts",
    line: /soksak-ai\/soksak-plugin-registry\/main\/registry-signed\.json/,
    token: /^soksak-plugin-registry$/,
    reason:
      "레지스트리 repo URL 상수 — 플러그인 카탈로그의 단일 발견 지점. 코어가 아는 유일한 외부 좌표다." +
      " token 제한으로 같은 줄에 놓인 다른 플러그인 id 는 사면되지 않는다.",
  },
  {
    file: "src/state/windowSnapshot.ts",
    line: /"soksak-plugin-terminal":\s*"soksak-plugin-terminal-xterm"/,
    token: /^soksak-plugin-terminal(?:-xterm)?$/,
    reason:
      "저장 세션 마이그레이션(deserializeView, LEGACY_PLUGIN_IDS) — 터미널 seam 정규화 rename(NAMING §4)" +
      " 전에 저장된 스냅샷의 옛 pluginId 를 새 id 로 번역하는 1회성 데이터 훅. 실행 분기가 아니라 레거시" +
      " 데이터 번역이며 rename 양끝 id 를 문법상 요구한다. line·token 제한으로 그 map 항목에만 적용된다." +
      " 옛 스냅샷 소멸 시 제거(제거 조건은 코드 주석).",
  },
];

// crates 는 프레임워크 밖으로 나온 Rust 다 — 뿌리에서 빠지면 그 코드가 스캔 밖이 된다.
const SCAN_ROOTS = ["src", "frameworks/tauri", "crates"];
const SKIP_DIRS = new Set(["target", "gen", "node_modules", ".git"]);
const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".toml", ".json", ".md", ".html", ".css",
]);
const TEST_FILE = /(\.test\.(ts|tsx|mjs)|_tests?\.rs)$/;

// Rust 테스트 모듈 제거 — 최상위(#열0) #[cfg(test)] 직후 mod 만 도려낸다.
// 파일 어디에 있든(말미·중간·복수) 각 모듈만 도려내고, 그 앞뒤 최상위 실행 경로 코드는 남긴다.
// 모듈 줄은 빈 줄로 대체한다(삭제 아님) — 뒤따르는 실행 경로 코드의 줄 번호를 보존해
// 위반 보고 위치가 원본 파일과 일치하게 한다.
//
// **모양이 둘이다.** 블록(`mod tests { … }`)과 선언(`mod tests;` — 몸이 형제 파일에 있다).
// 선언을 블록으로 착각해 중괄호를 찾아 나서면 **다음에 나오는 아무 블록이나** 삼키고, 그 안의
// 실행 경로는 스캔 밖으로 나간다. 위반 0건은 그때도 나오므로 통과를 위장한다(실측 2026-07-29:
// lib.rs:30 의 `#[cfg(test)] mod cored_ledger;` 가 뒤 50줄을 삼켰다).
//
// 검사를 형제 파일로 분리하는 것이 배치의 법이므로(REPO-LAYOUT 법 4) 선언 모양은 늘어난다.
// `#[path = "…"]` 같은 속성이 사이에 끼는 것도 같은 선언이다.
//
// **같은 판정이 두 벌 있다.** Rust 짝은 `crates/soksak-core/src/ambient_gate.rs` 의
// `production_lines` 다. 한 벌로 못 만드는 이유는 언어다 — 이 게이트는 node 로 돌고 그 게이트는
// cargo 로 돈다. 한쪽을 고치면 다른 쪽도 같이 고쳐라. 동기 확인 방법: 두 벌 다 같은 세 경우를
// 픽스처로 갖는다(선언 한 줄 / 속성이 낀 선언 / 블록 통째). 한쪽에만 있는 경우가 생기면 그때부터
// 두 게이트의 답이 갈리고, 갈린 쪽은 위반 0건으로 보인다.
export function stripRustTestModule(content) {
  const lines = content.split("\n");
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    if (/^#\[cfg\(test\)\]\s*$/.test(lines[i])) {
      let j = i + 1;
      // 빈 줄과 속성(#[path = "…"] 등)은 건너뛴다 — 선언과 mod 사이에 낄 수 있다.
      while (j < lines.length && (lines[j].trim() === "" || /^#\[/.test(lines[j]))) j++;
      if (j < lines.length && /^(pub\s+)?mod\b/.test(lines[j])) {
        // 선언(`mod x;`)은 그 줄에서 끝난다. 블록을 찾아 나서면 남의 블록을 삼킨다.
        const end = /;\s*$/.test(lines[j]) ? j + 1 : skipBraceBlock(lines, j);
        for (let k = i; k < end; k++) out[k] = "";
        i = end;
        continue;
      }
    }
    i++;
  }
  return out.join("\n");
}

// mod 선언 줄(modLine)부터 brace 가 균형을 되찾는 줄 다음 인덱스를 돌려준다.
// 문자열("...", raw r#"..."#)·문자 리터럴·라인/블록 주석 안의 중괄호는 세지 않는다.
function skipBraceBlock(lines, modLine) {
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  let inString = false; // 일반 "..."
  let rawHashes = -1; // raw 문자열 r#"..."# 이면 여는 # 개수, 아니면 -1.
  for (let k = modLine; k < lines.length; k++) {
    const line = lines[k];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inBlockComment) {
        if (ch === "*" && line[c + 1] === "/") {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (rawHashes >= 0) {
        if (ch === '"') {
          let h = 0;
          while (line[c + 1 + h] === "#") h++;
          if (h >= rawHashes) {
            c += rawHashes;
            rawHashes = -1;
          }
        }
        continue;
      }
      if (inString) {
        if (ch === "\\") c++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === "/" && line[c + 1] === "/") break; // 라인 주석 — 줄 끝까지.
      if (ch === "/" && line[c + 1] === "*") {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === "r" && !/[A-Za-z0-9_]/.test(line[c - 1] ?? "")) {
        let h = 0;
        while (line[c + 1 + h] === "#") h++;
        if (line[c + 1 + h] === '"') {
          rawHashes = h;
          c += h + 1;
          continue;
        }
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "'") {
        // 문자 리터럴('\?.')만 건너뛴다 — 라이프타임('a)은 그냥 진행.
        const m = /^'(\\.|[^'\\])'/.exec(line.slice(c));
        if (m) {
          c += m[0].length - 1;
          continue;
        }
      }
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return k + 1;
  }
  return lines.length;
}

function allowMatch(entry, relPath, token, lineText) {
  if (entry.file !== "*" && entry.file !== relPath) return false;
  if (entry.token && !entry.token.test(token)) return false;
  if (entry.line && !entry.line.test(lineText)) return false;
  return true;
}

// 한 파일 스캔 — 위반 목록과 allowlist 사용 횟수를 돌려준다. 순수 함수(테스트 짝이 직접 부른다).
export function scanFile(relPath, content, allowUse) {
  const violations = [];
  if (TEST_FILE.test(relPath)) return violations;
  const text = relPath.endsWith(".rs") ? stripRustTestModule(content) : content;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(TOKEN)) {
      const token = m[0];
      const hit = ALLOWLIST.findIndex((e) => allowMatch(e, relPath, token, lines[i]));
      if (hit >= 0) {
        if (allowUse) allowUse[hit] = (allowUse[hit] ?? 0) + 1;
        continue;
      }
      violations.push({ file: relPath, line: i + 1, token, text: lines[i].trim() });
    }
  }
  return violations;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(p);
    } else if (SCAN_EXTS.has(extname(name))) {
      yield p;
    }
  }
}

// 루트 전체 스캔 — { violations, staleAllowlist } 를 돌려준다.
export function scanRoot(rootDir) {
  // 오라클 생존 — 뿌리가 하나도 안 보이면 이 게이트는 **아무것도 안 지키면서 통과**한다.
  // 배치가 바뀌면 이 자리가 조용히 0건이 되고, 그 0 은 "위반 없음"과 구분되지 않는다.
  // 있는 뿌리를 세고, 하나도 없으면 사유를 달고 실패한다(0 의 두 얼굴).
  const seenRoots = SCAN_ROOTS.filter((n) => existsSync(join(rootDir, n)));
  if (seenRoots.length === 0) {
    throw new Error(
      `스캔 뿌리가 하나도 없다(${SCAN_ROOTS.join(", ")}) — 배치가 바뀌었으면 SCAN_ROOTS 를 함께 옮겨라. ` +
        "뿌리 없이 도는 스캔은 위반 0건을 답하지만 그것은 통과가 아니다",
    );
  }
  const violations = [];
  const allowUse = {};
  for (const scanRootName of SCAN_ROOTS) {
    const dir = join(rootDir, scanRootName);
    if (!existsSync(dir)) continue;
    for (const p of walk(dir)) {
      const rel = relative(rootDir, p);
      violations.push(...scanFile(rel, readFileSync(p, "utf8"), allowUse));
    }
  }
  // stale 검출 — 파일 지정 항목만: 그 파일이 실존하는데 매칭 0건이면 죽은 예외다.
  const staleAllowlist = ALLOWLIST.filter(
    (e, i) => e.file !== "*" && existsSync(join(rootDir, e.file)) && !(allowUse[i] > 0),
  ).map((e) => e.file);
  return { violations, staleAllowlist };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root =
    rootIdx >= 0 ? args[rootIdx + 1] : join(fileURLToPath(import.meta.url), "..", "..", "..");
  const { violations, staleAllowlist } = scanRoot(root);
  console.log(`C1 결합 스캔 — 대상 ${SCAN_ROOTS.join("·")} (root: ${root})`);
  if (violations.length) {
    console.log(`\n위반 ${violations.length}건:`);
    for (const v of violations) console.log(`  ✗ ${v.file}:${v.line} ${v.token} — ${v.text}`);
    console.log(
      "\n코어는 특정 플러그인 id 와 결합할 수 없다. placeholder(soksak-plugin-<id>)로 교체하라." +
        " 기능이 실 id 에 의존하면 C5 재입법 커밋으로만 allowlist 에 등재한다.",
    );
  }
  if (staleAllowlist.length) {
    console.log(`\nstale allowlist ${staleAllowlist.length}건 — 매칭 0건 예외는 제거하라:`);
    for (const f of staleAllowlist) console.log(`  ✗ ${f}`);
  }
  if (violations.length || staleAllowlist.length) process.exit(1);
  console.log("\nPASS: C1 위반 0건");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
