// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strayInstances } from "./single-instance.mjs";

const proc = (pid, startedAtUnixMs) => ({ pid, startedAtUnixMs });

// 규칙 — 한 홈에 한 인스턴스.
//
// `restart-dev` 는 **소켓을 쥔** 프로세스를 죽인다. 소켓을 놓친 인스턴스는 그 판정을 빠져나가
// 계속 산다 — 실측 2026-08-08: 8월 6일부터 이틀째 떠 있던 인스턴스가 남아 있었고, 하니스가 한
// 인스턴스의 창을 잡고 다른 인스턴스에 물어 `WINDOW_NOT_FOUND` 로 실행이 죽었다. 그 뒤 판정은
// 전부 후폭풍이었다(green 3 / not-run 21).
//
// 소켓 소유는 살아 있음의 증거이지 유일함의 증거가 아니다.
describe("strayInstances", () => {
  it("소켓 주인만 있으면 유령이 없다", () => {
    expect(strayInstances({ processes: [proc(1, 100)], socketOwnerPid: 1 })).toEqual([]);
  });

  it("소켓을 안 쥔 같은 앱 프로세스는 유령이다", () => {
    expect(strayInstances({
      processes: [proc(1, 200), proc(2, 100)],
      socketOwnerPid: 1,
    })).toEqual([2]);
  });

  it("여럿이면 전부 이름을 낸다 — 하나만 세면 나머지가 조용히 남는다", () => {
    expect(strayInstances({
      processes: [proc(1, 300), proc(2, 200), proc(3, 100)],
      socketOwnerPid: 1,
    })).toEqual([2, 3]);
  });

  // 소켓 주인을 못 읽은 것을 "주인이 없다" 로 읽으면 살아 있는 주인을 유령으로 죽인다.
  it("소켓 주인을 못 읽었으면 아무도 유령으로 지목하지 않는다", () => {
    expect(strayInstances({ processes: [proc(1, 100), proc(2, 200)], socketOwnerPid: null })).toEqual([]);
    expect(strayInstances({ processes: [proc(1, 100)], socketOwnerPid: Number.NaN })).toEqual([]);
  });

  it("프로세스가 하나도 없으면 빈 목록이다", () => {
    expect(strayInstances({ processes: [], socketOwnerPid: 1 })).toEqual([]);
  });
});
