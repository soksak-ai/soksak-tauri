// 게이트 러너의 기준.
//
// 러너가 틀리면 그 아래 게이트 전부가 무의미해진다 — 안 돌거나, 실패했는데 통과로 읽힌다.
// 그래서 여기서 보는 것은 **등재 판정**과 **발견**이지 오늘의 게이트 목록이 아니다.

import { describe, expect, it } from "vitest";

import { discover, unenrolled, ghosts, LOCAL, NETWORK } from "./run-all.mjs";

describe("등재를 강제한다", () => {
  it("어느 표에도 없는 게이트를 잡는다", () => {
    const local = new Map([["a.mjs", []]]);
    const network = new Map([["b.mjs", "원격"]]);
    expect(unenrolled(["a.mjs", "b.mjs", "c.mjs"], local, network)).toEqual(["c.mjs"]);
  });

  /** 표에 있는데 파일이 없으면 그 표는 거짓말이고, 거짓말하는 표는 곧 무시된다. */
  it("표에 있는데 사라진 게이트를 잡는다", () => {
    const local = new Map([["a.mjs", []], ["gone.mjs", []]]);
    expect(ghosts(["a.mjs"], local, new Map())).toEqual(["gone.mjs"]);
  });
});

describe("발견", () => {
  it("러너 자신과 검사 파일은 게이트가 아니다", () => {
    const found = discover();
    expect(found).not.toContain("run-all.mjs");
    expect(found.filter((n) => n.endsWith(".test.mjs"))).toEqual([]);
  });

  /** 0의 두 얼굴 — 하나도 못 찾는 것과 위반이 없는 것은 다르다. */
  it("이 저장소에서 게이트를 실제로 찾는다", () => {
    expect(discover().length).toBeGreaterThan(5);
  });
});

describe("이 저장소 실측", () => {
  it("발견된 게이트가 전부 등재돼 있다", () => {
    const found = discover();
    expect(unenrolled(found), "등재 안 된 게이트").toEqual([]);
    expect(ghosts(found), "표에만 있는 게이트").toEqual([]);
  });

  /** 네트워크 게이트는 로컬에서 돌지 않는다 — 한쪽에만 있어야 한다. */
  it("한 게이트가 두 표에 동시에 들지 않는다", () => {
    for (const n of LOCAL.keys()) expect(NETWORK.has(n), n).toBe(false);
  });

  it("네트워크 게이트는 왜 원격인지 사유를 단다", () => {
    for (const [n, why] of NETWORK) expect(String(why).length, n).toBeGreaterThan(10);
  });
});
