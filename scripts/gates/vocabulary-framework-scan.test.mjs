// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REAL_SHELL_PATHS, REAL_SHELL_TOKENS, REPO_ROOT, saysRealShell, scanRoot } from "./vocabulary-framework-scan.mjs";

let root;

function write(rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** 픽스처 루트의 위반만 골라 본다 — 장부 항목은 이 루트에 없으니 제외한다. */
function planted() {
  return scanRoot(root).filter((v) => !/장부에 있는데 실측 0건|IDENTIFIER_RESIDUE/.test(v));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-vocabulary-gate-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("어휘 게이트 — shell 은 명령 해석기의 말이다", () => {
  it("프레임워크를 framework 라 부르는 코드는 통과한다", () => {
    write("src/framework/electron.ts", 'export type FrameworkEvent = { framework: "electron" };\n');
    expect(planted()).toEqual([]);
  });

  it("프레임워크 뜻의 타입 이름을 잡는다", () => {
    write("src/framework/contract.ts", "export type ShellEvent = { name: string };\n");
    expect(planted().join("\n")).toContain("식별자 `ShellEvent`");
  });

  it("프레임워크 뜻의 와이어 문자열을 잡는다", () => {
    write("frameworks/electron/preload.cjs", 'ipcRenderer.on("shell:event", (_e, p) => p);\n');
    expect(planted().join("\n")).toContain("식별자 `shell:event`");
  });

  it("옛 게이트 이름(no_shell)이 되살아나면 잡는다", () => {
    write("crates/soksak-core/tests/no_framework.rs", "fn the_tree_carries_no_shell_crate() {}\n");
    expect(planted().join("\n")).toContain("식별자 `the_tree_carries_no_shell_crate`");
  });

  it("파일명이 shell 을 쓰면 잡는다", () => {
    write("scripts/e2e/shell-binding.json", "{}\n");
    const out = planted().join("\n");
    expect(out).toContain("scripts/e2e/shell-binding.json: 파일명이 shell 을 쓴다");
  });

  it("프레임워크 뜻의 산문이 새로 생기면 장부에 없다고 잡는다", () => {
    write("src/lib/newSeam.ts", "// 셸 경계 뒤에서 구독한다.\n");
    expect(planted().join("\n")).toContain("src/lib/newSeam.ts: 프레임워크 뜻으로 읽히는 줄 1건이 장부에 없다");
  });

  it("진짜 셸을 말하는 줄은 세지 않는다", () => {
    write("frameworks/tauri/src/new_spawn.rs", "// 로그인 셸을 인자로 받는다. `$SHELL` 은 계정 속성이다.\nfn f(login_shell: &str) {}\n");
    expect(planted()).toEqual([]);
  });

  it("진짜 셸 토큰과 프레임워크 잔여를 가른다", () => {
    expect(saysRealShell("// 로그인 셸을 값으로 받는다")).toBe(true);
    expect(saysRealShell("// 셸 통합(OSC 133)이 명령 시작을 보고한다")).toBe(true);
    expect(saysRealShell("// 셸 경계 뒤에서 구독한다")).toBe(false);
    expect(saysRealShell("// 셸 타입 없이 선다")).toBe(false);
  });

  it("허용 목록의 진짜 셸 경로는 통째로 뺀다", () => {
    write("frameworks/tauri/src/pty.rs", "// 셸을 소유한다\nfn spawn_shell_thing() {}\n");
    expect(planted()).toEqual([]);
  });

  it("허용 목록의 모든 항목이 사유를 단다", () => {
    for (const [path, why] of REAL_SHELL_PATHS) {
      expect(why, `${path} 에 사유가 없다`).toBeTruthy();
    }
    for (const [token, why] of REAL_SHELL_TOKENS) {
      expect(why, `${token} 에 사유가 없다`).toBeTruthy();
    }
  });

  it("이 저장소가 게이트를 통과한다", () => {
    expect(scanRoot(REPO_ROOT)).toEqual([]);
  });
});
