// 레일 세로 경계선의 소유권 — 누가 선을 긋는가는 railLook 과 테마 paneStyle 의 합성이다.
// ground(바닥)는 원칙적으로 자기 선을 긋지 않는다: 경계 표현은 이웃(pane 카드 윤곽·디바이더)
// 의 것이라 레일이 더하면 이중선이 된다. 단 **flat 테마는 이웃이 아무 윤곽도 그리지 않으므로**
// 그 위임이 성립하지 않는다 — 실측(Bare light): 사이드바-기능 경계가 무선으로 소실. flat 에선
// ground 레일이 자기 경계를 소유한다(양측 1px). pane 모드는 기존 규칙 유지.
import { describe, expect, it } from "vitest";
import { railEdgeWidths } from "./railEdges";

describe("railEdgeWidths", () => {
  it("ground + card/floating: 이웃(카드 윤곽)에 위임 — 양측 0", () => {
    expect(railEdgeWidths("ground", true, 50, "card")).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", true, 0, "floating")).toEqual({ left: 0, right: 0 });
  });

  it("ground + flat: 이웃이 안 그리므로 레일이 소유 — 양측 1px(경계 스테이션 포함)", () => {
    expect(railEdgeWidths("ground", true, 50, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("ground", true, 0, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("ground", true, 100, "flat")).toEqual({ left: 1, right: 1 });
  });

  it("pane: 내부 스테이션은 양측 1px, 가장자리는 바깥쪽 0 — paneStyle 무관", () => {
    expect(railEdgeWidths("pane", true, 50, "flat")).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 0, "card")).toEqual({ left: 0, right: 1 });
    expect(railEdgeWidths("pane", true, 100, "flat")).toEqual({ left: 1, right: 0 });
  });

  it("닫힘: 모드·테마 무관 양측 0", () => {
    expect(railEdgeWidths("pane", false, 50, "flat")).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", false, 50, "card")).toEqual({ left: 0, right: 0 });
  });
});
