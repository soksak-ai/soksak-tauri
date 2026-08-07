// 부르는 이름은 이 파일이 들여온 이름이어야 한다.
//
// `node --check` 는 구문만 본다. 정의 안 된 이름은 그 줄이 실제로 실행돼야 드러나므로 라이브
// 실행에서만 죽는다 — 실측 2026-08-08: `readProvision is not defined` 로 B12 세 사이클이 전부
// 죽었고 인수 집계가 읽을 보고서 자체가 없었다. 같은 부류를 그 전날 한 번 더 했다.
//
// 완전한 스코프 해석이 아니다. 이 저장소의 하니스가 실제로 겪은 한 부류만 센다 — 다른 모듈이
// 내보내는 이름을 부르면서 들여오지 않은 자리. 지역 선언·인자·전역은 세지 않는다.

/** 이 저장소의 하니스 라이브러리가 내보내는 이름을 모은다(그 이름을 부르면 들여와야 한다). */
function exportedNames(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const [, name] of source.matchAll(/^export (?:async )?function\s+([A-Za-z_$][\w$]*)/gm)) {
      names.add(name);
    }
    for (const [, name] of source.matchAll(/^export const\s+([A-Za-z_$][\w$]*)/gm)) names.add(name);
  }
  return names;
}

function importedNames(source) {
  const names = new Set();
  for (const [, block] of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const piece of block.split(",")) {
      const named = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (named) names.add(named);
    }
  }
  for (const [, name] of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(name);
  return names;
}

function locallyDeclared(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(name);
  }
  for (const [, name] of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(name);
  }
  return names;
}

let libraryExports = null;

/**
 * 이 소스가 부르지만 들여오지도 선언하지도 않은 라이브러리 이름.
 *
 * @param {string} source
 * @param {Set<string>} [known] 라이브러리가 내보내는 이름(테스트가 주입할 수 있다)
 * @returns {string[]}
 */
export function undeclaredImports(source, known = null) {
  if (known === null && libraryExports === null) {
    // 라이브러리 표면은 실제 소스에서 읽는다 — 목록을 손으로 적으면 반드시 하나 빠진다.
    const { readFileSync, globSync } = require$fs();
    const root = new URL("../../../", import.meta.url).pathname;
    const sources = globSync("scripts/e2e/lib/*.mjs", { cwd: root })
      .filter((file) => !file.endsWith(".test.mjs"))
      .map((file) => readFileSync(`${root}${file}`, "utf8"));
    libraryExports = exportedNames(sources);
  }
  const surface = known ?? libraryExports;
  const imported = importedNames(source);
  const declared = locallyDeclared(source);
  const missing = new Set();
  for (const name of surface) {
    if (imported.has(name) || declared.has(name)) continue;
    // 호출로 쓰인 자리만 센다 — 주석·문자열 안의 이름은 부른 것이 아니다.
    const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`);
    for (const line of source.split("\n")) {
      const code = line.replace(/\/\/.*$/, "");
      if (called.test(code)) { missing.add(name); break; }
    }
  }
  return [...missing];
}

function require$fs() {
  // 동기 읽기만 쓴다 — 이 게이트는 소스를 세는 자리라 런타임 부수효과가 없다.
  // eslint-disable-next-line no-undef
  return { readFileSync: fsReadFileSync, globSync: fsGlobSync };
}

import { readFileSync as fsReadFileSync, globSync as fsGlobSync } from "node:fs";
