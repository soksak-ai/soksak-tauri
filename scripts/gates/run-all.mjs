// 게이트를 **발견해서** 전부 돌린다.
//
// 손으로 나열한 목록은 드리프트한다. 실측(2026-07-29): Makefile 의 `gates` 가 열 개를 손으로
// 적고 있었고 그 사이 새로 난 게이트 둘이 목록 밖이었다. 그리고 그 목록이 맞았대도 문제는
// 남는다 — 통과 여부를 **출력 문자열**로 보면 게이트마다 말투가 달라 놓친다(실사고: baseline-gate 는
// "FAIL" 이라는 낱말을 쓰지 않아, 실패하는 동안 "게이트 전부 통과"로 보고됐다).
//
// 그래서 둘을 고친다. ① 목록은 디렉터리에서 나온다. ② 판정은 **종료코드**다.
//
// 등재를 강제한다: 발견된 게이트는 아래 표 중 하나에 있어야 한다. 새 게이트가 나면 그 순간
// 실패하고, 그 실패가 "이것을 로컬에서 돌릴 것인가, 네트워크 전용인가"를 묻는다. 묻지 않으면
// 새 게이트는 아무도 안 도는 파일이 된다.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/** 로컬에서 도는 게이트가 인자를 요구하면 여기 적는다. 값이 `[]` 면 인자 없음. */
export const LOCAL = new Map([
  ["baseline-gate.mjs", []],
  ["command-ownership.mjs", []],
  ["c2-transparency-scan.mjs", ["--plugins", process.env.SOKSAK_PLUGINS || `${process.env.HOME}/.soksak-dev/plugins`]],
  ["core-decoupling-scan.mjs", []],
  ["core-git-scan.mjs", []],
  ["core-terminal-scan.mjs", []],
  ["delegated-shape-scan.mjs", []],
  ["distribution-invariants-scan.mjs", []],
  ["framework-folder-vocabulary.mjs", []],
  ["framework-free-placement.mjs", []],
  ["framework-free-tenant.mjs", []],
  ["framework-thin-binding.mjs", []],
  ["module-state-scan.mjs", []],
  ["platform-boundary-scan.mjs", ["--artifacts"]],
  ["product-name-scan.mjs", []],
  ["rust-tests.mjs", []],
  ["ui-through-commands-scan.mjs", []],
  ["test-home-isolation.mjs", []],
  ["vocabulary-framework-scan.mjs", []],
  ["workspace-root-not-framework.mjs", []],
]);

/** 네트워크를 타는 게이트 — 발행 전에 따로 돈다(`make gates-registry`). 사유를 적는다. */
export const NETWORK = new Map([
  ["dependency-graph-scan.mjs", "라이브 registry.json 의 의존 그래프 — 발행 대상이 카탈로그에 함께 있는가"],
  ["contract-sync-scan.mjs", "발행된 doctor 와 코어 contract 의 동기"],
  ["deploy-catalog.mjs", "라이브 registry.json 이 실은 플러그인의 GitHub 실측 — 배포 모집단"],
]);

/** 이 러너 자신과 검사 파일은 게이트가 아니다. */
const NOT_A_GATE = (n) => n === "run-all.mjs" || n.endsWith(".test.mjs") || !n.endsWith(".mjs");

export function discover(dir = HERE) {
  return readdirSync(dir).filter((n) => !NOT_A_GATE(n)).sort();
}

/** 발견된 것 중 어느 표에도 없는 것 — 등재되지 않은 게이트다. */
export function unenrolled(names, local = LOCAL, network = NETWORK) {
  return names.filter((n) => !local.has(n) && !network.has(n));
}

/** 표에 있는데 파일이 없는 것 — 지워졌거나 개명됐다. 장부가 거짓말하면 곧 무시된다. */
export function ghosts(names, local = LOCAL, network = NETWORK) {
  const have = new Set(names);
  return [...local.keys(), ...network.keys()].filter((n) => !have.has(n));
}

function run(name, args) {
  const r = spawnSync("node", [join(HERE, name), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { name, code: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}`.trimEnd() };
}

if (basename(process.argv[1] || "") === "run-all.mjs") {
  const names = discover();
  // 0의 두 얼굴 — 훑을 게이트가 없으면 통과가 아니라 실패다.
  if (names.length === 0) {
    console.log("run-all: FAIL — 게이트를 하나도 못 찾았다(경로가 바뀌었다)");
    process.exit(1);
  }
  const strays = unenrolled(names);
  const gone = ghosts(names);
  const failures = [];
  for (const n of names) {
    if (NETWORK.has(n)) continue;
    if (!LOCAL.has(n)) continue;
    const { code, out } = run(n, LOCAL.get(n));
    if (code === 0) {
      console.log(`  ✓ ${n}`);
    } else {
      failures.push(n);
      console.log(`  ✗ ${n} (exit ${code})`);
      for (const l of out.split("\n").slice(0, 6)) console.log(`      ${l}`);
    }
  }
  for (const n of strays) console.log(`  ✗ ${n} — 어느 표에도 없다. 로컬인지 네트워크인지 등재하라`);
  for (const n of gone) console.log(`  ✗ ${n} — 표에 있는데 파일이 없다. 지웠으면 표에서도 지워라`);
  const bad = failures.length + strays.length + gone.length;
  console.log(
    bad === 0
      ? `run-all: PASS (로컬 ${names.length - NETWORK.size}개 · 네트워크 ${NETWORK.size}개는 gates-registry 에서)`
      : `run-all: FAIL (${bad})`,
  );
  process.exit(bad === 0 ? 0 : 1);
}
