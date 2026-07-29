// 검사는 사용자의 실 홈에 쓰지 않는다.
//
// 프레임워크 어댑터는 적재되는 것만으로 자기 홈을 파생하고 거기에 쓴다(요구 원장
// `invoke-demand.jsonl`). 그래서 `main.cjs` 를 적재하는 검사가 `os.homedir` 를 픽스처로
// 돌려놓지 않으면, 그 검사는 **도는 순간** 사용자 홈에 파일을 만든다.
//
// 실측(2026-07-29): 홈 규칙이 프레임워크 축에서 env 축으로 바뀌자, 그때까지 버려도 되는
// `~/.soksak-electron-dev` 에 쓰던 검사 둘이 곧바로 `~/.soksak-dev`(플러그인 47개가 사는
// 사용자 정본)에 `invoke-demand.jsonl` 을 만들었다. 규칙이 바뀌기 전에는 아무도 못 봤다 —
// 잘못된 자리에 쓰고 있었는데 그 자리가 무해했을 뿐이다.
//
// 그래서 판정은 "어느 홈에 썼는가"가 아니라 **"홈을 돌려놓았는가"** 다. 결과를 보고 세면
// 홈 규칙이 바뀔 때마다 같은 사고가 되돌아온다.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/**
 * **적재만으로** 홈에 쓰는 어댑터. 오늘은 하나다 — `main.cjs:34` 가 모듈 스코프에서
 * `mkdirSync(SPIKE_HOME)` 하고, 그 뒤 모든 invoke 가 `invoke-demand.jsonl` 에 붙는다.
 *
 * `backend.cjs` 와 `cored.cjs` 는 여기 없다: 전자는 소켓만 다루고 홈을 모르며, 후자는
 * 파생 함수를 **내주기만** 하고 스스로 부르지 않는다. 쓰지 않는 것을 세면 그 게이트는
 * 고칠 수 없는 위반을 만들고, 고칠 수 없는 위반은 곧 무시된다.
 */
export const HOME_WRITING_ON_LOAD = ["frameworks/electron/main.cjs"];

/** 검사가 홈을 돌려놓았다고 인정하는 모양. 어느 하나라도 있으면 통과다. */
const ISOLATION = [
  /\bhomedir\s*=\s*\(\)\s*=>/, // os.homedir 교체
  /\bhomedir:\s*/, // 인자로 홈을 주입(frameworkIdentity({ homedir }))
  /SOKSAK_HOME\s*[=:]/, // 홈을 환경으로 지목
];

/** 그 어댑터를 적재하는 모양. `MAIN` 상수가 그것을 가리킨다는 것은 아래에서 확인한다. */
const LOADS = [/requireCjs\(\s*MAIN\s*\)/, /require\(\s*MAIN\s*\)/];

/** `MAIN` 이 정말 그 어댑터를 가리키는가. 상수 이름만 믿으면 다른 파일을 세게 된다. */
const NAMES_MAIN = /const\s+MAIN\s*=[^;]*electron\/main\.cjs/s;

export function scanDir(dir) {
  const abs = join(REPO_ROOT, dir);
  let names;
  try {
    names = readdirSync(abs).filter((n) => n.endsWith(".test.mjs"));
  } catch {
    return { scanned: 0, violations: [{ file: dir, why: "스캔할 자리가 없다 — 경로가 바뀌었다" }] };
  }
  // 0의 두 얼굴: 훑을 것이 없으면 통과가 아니라 실패다. 뿌리가 사라진 게이트는
  // 위반 0건으로 통과를 위장한다.
  if (names.length === 0) {
    return { scanned: 0, violations: [{ file: dir, why: "검사 파일이 하나도 없다 — 뿌리가 사라졌다" }] };
  }
  const violations = [];
  for (const n of names) {
    const src = readFileSync(join(abs, n), "utf8");
    if (!LOADS.some((r) => r.test(src))) continue;
    if (!NAMES_MAIN.test(src)) continue;
    if (ISOLATION.some((r) => r.test(src))) continue;
    violations.push({
      file: `${dir}/${n}`,
      why: "프레임워크 어댑터를 적재하면서 홈을 돌려놓지 않는다 — 도는 순간 사용자 홈에 쓴다",
    });
  }
  return { scanned: names.length, violations };
}

export function verify() {
  return scanDir("scripts/electron");
}

if (basename(process.argv[1] || "") === "test-home-isolation.mjs") {
  const { scanned, violations } = verify();
  if (violations.length === 0) {
    console.log(`test-home-isolation: PASS (${scanned}벌 훑음)`);
  } else {
    console.log(`test-home-isolation: FAIL (${violations.length})`);
    for (const v of violations) console.log(`  - ${v.file}: ${v.why}`);
    process.exitCode = 1;
  }
}
