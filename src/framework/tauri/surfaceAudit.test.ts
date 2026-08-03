// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { visibleAnchorFacts } from "./surfaceAudit";

describe("Tauri 표면 감사의 DOM 정본", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("실제 data-content-view-body 홀 자체를 앵커로 읽고 탭 identity는 공개 조상에서 얻는다", () => {
    const frame = document.createElement("div");
    frame.dataset.node = "layout/tab/v1";
    frame.dataset.projectId = "t1";
    const slot = document.createElement("div");
    slot.dataset.tauriHole = "content";
    slot.dataset.contentViewBody = "b-v1";
    slot.getBoundingClientRect = () =>
      ({ x: 10, y: 20, left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200 }) as DOMRect;
    frame.appendChild(slot);
    document.body.appendChild(frame);

    expect(visibleAnchorFacts()).toEqual([
      {
        label: "b-v1",
        viewId: "v1",
        projectId: "t1",
        rect: { x: 10, y: 20, w: 300, h: 200 },
      },
    ]);
  });
});
