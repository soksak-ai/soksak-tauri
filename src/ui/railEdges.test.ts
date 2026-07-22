// ground 레일의 경계선 소유권 — 바닥(ground)은 자기 세로 경계선을 긋지 않는다. 경계 표현은
// 이웃(pane 카드 윤곽·디바이더)의 것이라, 레일이 선을 더하면 이중선이 된다. pane 모드는
// 기존 규칙(내부 스테이션에서만 양측 1px) 유지.
import { describe, expect, it } from "vitest";
import { railEdgeWidths } from "./railEdges";

describe("railEdgeWidths", () => {
  it("ground: 열려 있어도 양측 0 — 바닥은 선이 없다", () => {
    expect(railEdgeWidths("ground", true, 50)).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", true, 0)).toEqual({ left: 0, right: 0 });
  });

  it("pane: 내부 스테이션은 양측 1px, 가장자리는 바깥쪽 0", () => {
    expect(railEdgeWidths("pane", true, 50)).toEqual({ left: 1, right: 1 });
    expect(railEdgeWidths("pane", true, 0)).toEqual({ left: 0, right: 1 });
    expect(railEdgeWidths("pane", true, 100)).toEqual({ left: 1, right: 0 });
  });

  it("닫힘: 모드 무관 양측 0", () => {
    expect(railEdgeWidths("pane", false, 50)).toEqual({ left: 0, right: 0 });
    expect(railEdgeWidths("ground", false, 50)).toEqual({ left: 0, right: 0 });
  });
});
