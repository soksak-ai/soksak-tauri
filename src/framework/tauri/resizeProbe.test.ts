import { describe, expect, it, vi } from "vitest";
import { createTauriResizeProbe } from "./resizeProbe";

/**
 * 문서 밖 pane renderer 는 자기 ResizeObserver/`resize` 로만 새 크기를 알게 되고, 비전면
 * WKWebView 에서 그 사건은 미뤄진다. 그래서 host frame 만 바꾼 거래는 renderer 평면이 직전
 * 거래를 그대로 들고 있는 채로 끝난다 — 이 세계는 그 사실을 지우지 않고 그대로 둔다.
 * 정착(measure 요청 + native commit 대기)을 부른 거래에서만 보고가 현재 크기를 따른다.
 */
function laggingRenderer() {
  let host = { w: 800, h: 600 };
  let committed = { w: 800, h: 600 };
  let revision = 1;
  const calls: string[] = [];
  return {
    calls,
    resizeTo(w: number, h: number) {
      host = { w, h };
    },
    /** 정착을 부르지 않으면 renderer 는 영영 직전 거래에 머문다. */
    settle: vi.fn(async () => {
      calls.push("settle");
      committed = { ...host };
      revision += 1;
    }),
    /** 정착 없이도 답은 하되, 답하는 renderer 평면은 직전 거래의 것이다. */
    stall: vi.fn(async () => {
      calls.push("settle");
    }),
    readComposition: vi.fn(async () => {
      calls.push("readComposition");
      return {
        matches: [{
          pane: "pane-w-1-v1",
          viewId: "v1",
          domFrame: { x: 0, y: 0, w: host.w, h: host.h },
          nativeFrame: { x: 0, y: 0, w: host.w, h: host.h },
          memberMatches: [{
            label: "b-w-1-v1",
            topologyPath: "window/w-1/view/v1/content/b-w-1-v1",
            viewport: { w: committed.w, h: committed.h, revision },
            ok: committed.w === host.w && committed.h === host.h,
          }],
        }],
      };
    }),
  };
}

function probeOver(
  world: ReturnType<typeof laggingRenderer>,
  settle: (timeoutMs: number) => Promise<void>,
  eventGeneration: () => number,
) {
  return createTauriResizeProbe({
    windowLabel: () => "w-1",
    scaleFactor: () => 2,
    eventGeneration,
    settle,
    readComposition: world.readComposition,
  });
}

describe("Tauri resize 거래 정착", () => {
  it("단계를 완료로 세기 전에 거래를 정착시켜 renderer 평면이 현재 거래를 따른다", async () => {
    const world = laggingRenderer();
    let events = 0;
    const observe = probeOver(world, world.settle, () => events);

    await observe({ kind: "baseline" });
    // baseline 은 아직 아무 거래도 없던 자리라 정착시킬 거래가 없다.
    expect(world.settle).not.toHaveBeenCalled();

    world.resizeTo(1_280, 922);
    events += 1;
    const step = await observe({ kind: "step", step: 0 });

    expect(world.settle).toHaveBeenCalledTimes(1);
    expect(step.renderers[0].logicalFrame).toMatchObject({ w: 1_280, h: 922 });
    expect(step.presentations[0]).toMatchObject({ presented: true, live: true, visible: true });
    expect(step.continuity.countersAfter).toEqual({
      replacements: 0, gaps: 0, disappearances: 0, unpresented: 0,
    });
  });

  it("정착이 끝난 뒤에 합성을 읽는다", async () => {
    const world = laggingRenderer();
    let events = 0;
    const observe = probeOver(world, world.settle, () => events);

    world.resizeTo(1_440, 1_362);
    events += 1;
    await observe({ kind: "step", step: 0 });

    expect(world.calls).toEqual(["settle", "readComposition"]);
  });

  it("정착이 시간 안에 못 닫으면 그 사실이 수치로 남는다", async () => {
    const world = laggingRenderer();
    let events = 0;
    const observe = probeOver(world, world.stall, () => events);

    await observe({ kind: "baseline" });
    world.resizeTo(1_280, 922);
    events += 1;
    const step = await observe({ kind: "step", step: 0 });

    // 정착을 불렀다는 사실이 관측을 통과시키지 않는다 — 안 따라온 renderer 는 그대로 red 다.
    expect(world.stall).toHaveBeenCalledTimes(1);
    expect(step.presentations[0].presented).toBe(false);
    expect(step.continuity.countersAfter).toMatchObject({ gaps: 1, unpresented: 1 });
  });
});
