// 홈 격리 게이트의 기준.
//
// 보는 것은 **판정 로직**이다 — 어기는 모양을 주면 잡는가, 안 어기는 모양을 통과시키는가.
// "오늘 이 저장소가 어긴다/안 어긴다"만 단언하면 고치는 순간 검사가 낡는다.
//
// 그 위에 이 저장소 실측 하나를 얹는다.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanDir, verify, REPO_ROOT } from "./test-home-isolation.mjs";

let sandbox;
let rel;
beforeEach(() => {
  // 게이트가 REPO_ROOT 기준으로 읽으므로, 저장소 안에 임시 자리를 만든다.
  sandbox = mkdtempSync(join(REPO_ROOT, ".home-iso-gate-"));
  rel = sandbox.slice(REPO_ROOT.length + 1);
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

const write = (name, text) => {
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, name), text);
};

describe("어댑터를 적재하면서 홈을 안 돌려놓으면 잡는다", () => {
  it("적재만 하고 격리가 없으면 위반", () => {
    write("bad.test.mjs", 'const MAIN = join(root, "frameworks/electron/main.cjs");\nrequireCjs(MAIN);\nit("t",()=>{});\n');
    const { violations } = scanDir(rel);
    expect(violations.map((v) => v.file)).toEqual([`${rel}/bad.test.mjs`]);
  });

  it("homedir 을 교체하면 통과", () => {
    write("ok.test.mjs", 'const MAIN = join(root, "frameworks/electron/main.cjs");\nosModule.homedir = () => root;\nrequireCjs(MAIN);\n');
    expect(scanDir(rel).violations).toEqual([]);
  });

  it("homedir 을 인자로 주입해도 통과", () => {
    write("ok2.test.mjs", 'const MAIN = join(root, "frameworks/electron/main.cjs");\nframeworkIdentity({ homedir: "/H" });\nrequireCjs(MAIN);\n');
    expect(scanDir(rel).violations).toEqual([]);
  });

  it("어댑터를 적재하지 않는 검사는 보지 않는다", () => {
    write("pure.test.mjs", 'import { x } from "./y.mjs";\nit("t",()=>{});\n');
    expect(scanDir(rel).violations).toEqual([]);
  });

  /** 상수 이름만 믿으면 홈을 안 만드는 다른 파일까지 센다 — 고칠 수 없는 위반이 된다. */
  it("MAIN 이 그 어댑터가 아니면 보지 않는다", () => {
    write("other.test.mjs", 'const MAIN = join(root, "frameworks/electron/backend.cjs");\nrequireCjs(MAIN);\n');
    expect(scanDir(rel).violations).toEqual([]);
  });
});

/** 0의 두 얼굴 — 훑을 것이 없는 것과 위반이 없는 것은 다르다. */
describe("뿌리가 사라지면 통과를 위장하지 않는다", () => {
  it("검사 파일이 하나도 없으면 실패한다", () => {
    const { scanned, violations } = scanDir(rel);
    expect(scanned).toBe(0);
    expect(violations.length).toBe(1);
  });

  it("없는 경로도 실패한다", () => {
    expect(scanDir("no/such/dir").violations.length).toBe(1);
  });
});

describe("이 저장소 실측", () => {
  it("Electron 검사 전부가 홈을 돌려놓는다", () => {
    const { scanned, violations } = verify();
    expect(scanned, "훑은 검사 수").toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
