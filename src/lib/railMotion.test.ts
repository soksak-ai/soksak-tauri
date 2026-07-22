import { describe, expect, it } from "vitest";
import { railPresentationLayers } from "./railMotion";

describe("FLOW 레일 영역 인계", () => {
  it("도착 레일은 처음부터 최종선에 있고 출발 레일은 pane 수축이 끝날 때까지 남는다", () => {
    expect(
      railPresentationLayers(
        { generation: 7, station: 64 },
        20,
        true,
      ),
    ).toEqual([
      {
        key: 7,
        station: 64,
        role: "source",
        commitProjection: false,
        interactive: false,
      },
      {
        key: 8,
        station: 20,
        role: "target",
        commitProjection: true,
        interactive: true,
      },
    ]);
  });

  it("수축이 끝나면 도착 레일 하나만 남긴다", () => {
    expect(
      railPresentationLayers(
        { generation: 8, station: 20 },
        20,
        false,
      ),
    ).toEqual([
      {
        key: 8,
        station: 20,
        role: "resting",
        commitProjection: true,
        interactive: true,
      },
    ]);
  });
});
