// 세입자 게이트의 기준.
//
// 보는 것은 **판정 로직**이다 — 어기는 모양을 주면 잡는가, 안 어기는 모양을 통과시키는가.
// "오늘 몇 건이냐"만 단언하면 이관이 한 걸음 나아가는 순간 검사가 통째로 낡는다.
//
// 그 위에 이 저장소 실측 하나를 얹는다.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  verify,
  touchesFramework,
  isThinlyBound,
  contactCount,
  codeLines,
  DECLARED,
  REPO_ROOT,
} from "./framework-free-tenant.mjs";

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


describe("얇은 결속도 등재를 요구한다", () => {
  /** 600줄 중 한 줄이 프레임워크인 파일은 프레임워크 파일이 아니다. */
  it("실코드가 크고 접촉이 손에 꼽으면 얇은 결속이다", () => {
    const body = Array.from({ length: 80 }, (_, i) => `fn f${i}() {}`).join("\n");
    expect(isThinlyBound(`${body}\nfn g() { tauri::x(); }`, "tauri")).toBe(true);
  });

  it("접촉이 잦으면 얇지 않다", () => {
    const many = Array.from({ length: 80 }, (_, i) => `fn f${i}() { tauri::x(); }`).join("\n");
    expect(isThinlyBound(many, "tauri")).toBe(false);
  });

  it("작은 파일은 얇은 결속으로 세지 않는다 — 한 줄짜리 결속은 그것이 몸이다", () => {
    expect(isThinlyBound("fn f() { tauri::x(); }", "tauri")).toBe(false);
  });

  /** 검사가 큰 파일이 밀도를 왜곡한다 — 실코드만 센다. */
  it("검사 줄은 실코드로 세지 않는다", () => {
    const src = ["fn f() {}", "#[cfg(test)]", "mod t {", ...Array(200).fill("  let x = 1;"), "}"].join("\n");
    expect(codeLines(src)).toBeLessThan(5);
  });

  it("접촉을 줄 수로 센다", () => {
    expect(contactCount("a\ntauri::x();\nb\ntauri::y();", "tauri")).toBe(2);
  });

  it("얇게 묶인 파일이 등재 없으면 잡는다", () => {
    const body = Array.from({ length: 80 }, (_, i) => `fn f${i}() {}`).join("\n");
    const rel = place("tauri", "src/thin.rs", `${body}\nfn g() { tauri::x(); }\n`);
    expect(verify(root, new Map()).violations.map((v) => v.file)).toContain(rel);
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
    // 이관이 끝났다 — tenant 는 0이다. 다시 늘면 그것이 신호다: 프레임워크 무관 코드가
    // 또 프레임워크 폴더 안에서 자랐다는 뜻이고, 그때 이 단언이 잡는다.
    expect(tenants, `세입자가 다시 생겼다: ${tenants.join(", ")}`).toEqual([]);
  });

  it("장부의 갈래는 둘뿐이다", () => {
    for (const [rel, [lane]] of DECLARED) {
      expect(["framework", "tenant"], `${rel}`).toContain(lane);
    }
  });
});
