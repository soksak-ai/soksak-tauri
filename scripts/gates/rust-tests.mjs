// Rust 검사도 게이트다 — "게이트 전부 통과"가 절반만 본 통과이면 안 된다.
//
// 실측(2026-07-31): 새 커맨드를 하나 세우고 이식 장부에 등재하지 않아 `cored_ledger` 검사 둘이
// RED 였는데, 그 상태로 커밋하고 "게이트 18개 PASS"라고 보고했다. `run-all` 이 .mjs 게이트만
// 돌기 때문이다 — Rust 검사는 `make test` 에만 있었고, 그 둘이 갈려 있는 한 어느 쪽을 돌려도
// "전부 통과"라는 말은 참이 아니다.
//
// 목록을 손으로 맞추지 않는다. 이 파일이 게이트로 있으면 run-all 의 발견이 자동으로 집어간다.
//
// 워크스페이스는 둘이다: 루트(crates/*)와 frameworks/tauri(sok). 한쪽만 돌면 다른 쪽 회귀가
// 그대로 지나간다 — 실제로 놓친 것이 프레임워크 쪽이었다.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** cargo 는 PATH 에 없을 수 있다(GUI·훅 환경) — 발견해서 쓴다. */
function cargoBin() {
  const home = process.env.HOME ?? "";
  const candidates = [join(home, ".cargo/bin/cargo"), "/usr/local/bin/cargo", "cargo"];
  for (const c of candidates) {
    if (c === "cargo" || existsSync(c)) return c;
  }
  return "cargo";
}

const CARGO = cargoBin();

/** 검사할 워크스페이스 — 손목록이 아니라 트리에 있는 사실이다(Cargo.toml 이 있는 곳). */
const WORKSPACES = [
  { dir: ROOT, why: "코어 크레이트(crates/*)" },
  { dir: join(ROOT, "frameworks/tauri"), why: "프레임워크(sok)" },
].filter((w) => existsSync(join(w.dir, "Cargo.toml")));

if (WORKSPACES.length === 0) {
  console.error("rust-tests: Cargo.toml 을 하나도 못 찾았다 — 판정 불가");
  process.exit(1);
}

let failed = 0;
for (const ws of WORKSPACES) {
  const r = spawnSync(CARGO, ["test", "--workspace", "--lib", "--quiet"], {
    cwd: ws.dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}` },
  });
  if (r.error) {
    console.error(`rust-tests: cargo 를 실행하지 못했다(${ws.why}): ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    failed += 1;
    console.error(`rust-tests: FAIL — ${ws.why}`);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    for (const line of out.split("\n")) {
      if (/^(error|thread|---- |assertion|test result: FAILED|failures:)/.test(line)) {
        console.error(`  ${line}`);
      }
    }
  } else {
    console.log(`rust-tests: OK — ${ws.why}`);
  }
}

if (failed > 0) process.exit(1);
