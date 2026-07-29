// 세입자 게이트의 기준.
//
// 보는 것은 **판정 로직**이다 — 어기는 모양을 주면 잡는가, 안 어기는 모양을 통과시키는가.
// "오늘 몇 건이냐"만 단언하면 이관이 한 걸음 나아가는 순간 검사가 통째로 낡는다.
//
// 그 위에 이 저장소 실측 하나를 얹는다.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verify, touchesFramework, DECLARED, REPO_ROOT } from "./framework-free-tenant.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(REPO_ROOT, ".tenant-gate-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 임시 트리에 프레임워크 폴더 하나와 파일 하나. */
function place(framework, rel, body) {
  const p = join(root, "frameworks", framework, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return `frameworks/${framework}/${rel}`;
}

describe("프레임워크를 부르는지 판정한다", () => {
  it("Rust 는 크레이트 경로로 판정한다", () => {
    expect(touchesFramework("fn f() { tauri::Window::x(); }", "tauri")).toBe(true);
    expect(touchesFramework("#[tauri::command]\nfn f() {}", "tauri")).toBe(true);
    expect(touchesFramework("fn f() -> u8 { 1 }", "tauri")).toBe(false);
  });

  it("JS 는 import 로 판정한다", () => {
    expect(touchesFramework('const { app } = require("electron");', "electron")).toBe(true);
    expect(touchesFramework('import { app } from "electron";', "electron")).toBe(true);
    expect(touchesFramework("module.exports = { f: () => 1 };", "electron")).toBe(false);
  });

  /** 모르는 프레임워크를 무관으로 오인하면 그 폴더 전체가 위반으로 쏟아진다. */
  it("모르는 프레임워크는 무관으로 단정하지 않는다", () => {
    expect(touchesFramework("anything", "flutter")).toBe(true);
  });
});

describe("등재를 강제한다", () => {
  it("등재 없는 무관 파일을 잡는다", () => {
    const rel = place("tauri", "src/loose.rs", "pub fn pure() -> u8 { 1 }\n");
    const { violations } = verify(root, new Map());
    expect(violations.map((v) => v.file)).toContain(rel);
  });

  it("등재하면 통과시킨다 — 갈래가 무엇이든", () => {
    const a = place("tauri", "src/a.rs", "pub fn pure() {}\n");
    const b = place("tauri", "src/b.rs", "pub fn also_pure() {}\n");
    const ledger = new Map([
      [a, ["framework", "주입받는다"]],
      [b, ["tenant", "코어로 간다"]],
    ]);
    expect(verify(root, ledger).violations).toEqual([]);
  });

  it("프레임워크를 부르는 파일은 애초에 보지 않는다", () => {
    place("tauri", "src/bound.rs", "#[tauri::command]\nfn f() {}\n");
    expect(verify(root, new Map()).violations).toEqual([]);
  });

  /** 옮기고 장부를 안 지우면 건수가 거짓말이 된다. */
  it("장부에 있는데 트리에 없으면 잡는다", () => {
    place("tauri", "src/bound.rs", "#[tauri::command]\nfn f() {}\n");
    const ledger = new Map([["frameworks/tauri/src/gone.rs", ["tenant", "옮겼다"]]]);
    const { violations } = verify(root, ledger);
    expect(violations.map((v) => v.file)).toEqual(["frameworks/tauri/src/gone.rs"]);
  });

  it("검사 파일은 세지 않는다 — 규칙이 아니라 그 증명이다", () => {
    place("tauri", "src/bound.rs", "#[tauri::command]\nfn f() {}\n");
    place("tauri", "src/bound_tests.rs", "fn t() { assert!(true); }\n");
    expect(verify(root, new Map()).violations).toEqual([]);
  });
});

/** 0의 두 얼굴 — 훑을 것이 없는 것과 위반이 없는 것은 다르다. */
describe("뿌리가 사라지면 통과를 위장하지 않는다", () => {
  it("frameworks 폴더가 없으면 실패한다", () => {
    expect(verify(root, new Map()).violations.length).toBe(1);
  });

  it("프레임워크 폴더가 비어 있으면 실패한다", () => {
    mkdirSync(join(root, "frameworks", "tauri"), { recursive: true });
    const { scanned, violations } = verify(root, new Map());
    expect(scanned).toBe(0);
    expect(violations.length).toBe(1);
  });
});

describe("이 저장소 실측", () => {
  it("전부 등재돼 있고, 남은 이관이 이름으로 나온다", () => {
    const { scanned, violations, tenants } = verify();
    expect(scanned, "훑은 소스").toBeGreaterThan(0);
    expect(violations).toEqual([]);
    // 이관이 끝나면 0이 된다. 그때 이 단언이 실패하고, 그것이 신호다.
    expect(tenants.length, `남은 이관: ${tenants.join(", ")}`).toBeGreaterThan(0);
  });

  it("장부의 갈래는 둘뿐이다", () => {
    for (const [rel, [lane]] of DECLARED) {
      expect(["framework", "tenant"], `${rel}`).toContain(lane);
    }
  });
});
