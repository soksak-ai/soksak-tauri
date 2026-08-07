// @vitest-environment jsdom
// 자극에는 시각과 사유가 있다.
//
// B05(continuous-visible-presentation)는 "클릭 → 배치 거래 → 표시 프레임"을 한 인과 사슬로
// 판정한다. 그러려면 두 사실이 공개면에 있어야 한다.
//
//  1) 자극 시각 — 클릭이 실제로 나간 절대 epoch. 프레임 목록에서 되짚어 추정하면 그 수치는
//     관측이 아니라 해석이다. presentation clock(=배치 장부·native display 원장과 같은 epoch)
//     으로 명령이 직접 답해야 한다.
//  2) 사유 — 이 자극이 연 배치 거래가 무엇인지. 장부를 sequence 창으로 오려내는 것은 "그
//     사이에 다른 거래가 없었다"는 가정이고, 가정은 영수증이 아니다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLayoutTransitionHostForTest,
  prepareLayoutMove,
} from "../lib/layoutTransitionHost";
import {
  __resetLayoutTransitionJournalForTest,
  layoutTransitionJournal,
} from "../lib/layoutTransitionJournal";
import { presentationNowUnixMs } from "../lib/presentationClock";
import { recordWindowFrames } from "./windowRecorder";

vi.mock("../lib/contentViews", () => ({
  CONTENT_VIEW_BODY: "data-content-view-body",
  contentViewSlotVisible: () => true,
  hasContentViewHost: () => false,
  contentViewHost: () => ({ sendInput: async () => {} }),
}));
vi.mock("../lib/webviewLabels", () => ({
  currentWindowLabel: () => "main",
  browserLabel: (viewId: string) => `b-main-${viewId}`,
}));
const shellWin = vi.hoisted(() => ({
  innerPosition: async () => ({ x: 0, y: 0 }),
  scaleFactor: async () => 1,
}));
vi.mock("../framework", () => ({
  invoke: vi.fn(async () => ({})),
  currentWindow: () => shellWin,
}));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames: vi.fn(),
}));

import { __resetMultiDomTraceForTest, registerDomCatalog } from "./catalogDom";
import { catalogJson, execute, getSpec, unregister } from "./registry";

const ADDR = "win/main/content/view/test.v/node/btn";

function mountNode(html: string): void {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="content/view/test.v">${html}</div>`;
}

beforeEach(() => {
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
  __resetMultiDomTraceForTest();
  vi.mocked(recordWindowFrames).mockReset();
  registerDomCatalog();
});
afterEach(() => {
  for (const { name } of catalogJson()) {
    if (name.startsWith("ui.") || name === "webview.emitNative") unregister(name);
  }
  document.body.innerHTML = "";
  __resetLayoutTransitionHostForTest();
  __resetLayoutTransitionJournalForTest();
});

describe("ui.input.click — 자극 시각", () => {
  it("클릭이 나간 절대 epoch를 응답으로 답한다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const before = presentationNowUnixMs();
    const result = await execute("ui.input.click", { address: ADDR }, {});
    const after = presentationNowUnixMs();

    const atUnixMs = (result.data as { atUnixMs?: number }).atUnixMs;
    expect(Number.isFinite(atUnixMs)).toBe(true);
    expect(atUnixMs).toBeGreaterThanOrEqual(before);
    expect(atUnixMs).toBeLessThanOrEqual(after);
    expect(getSpec("ui.input.click")?.returns).toContain("atUnixMs");
  });

  it("phase로 쪼갠 게스처도 각 단계의 자극 시각을 답한다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const down = await execute("ui.input.click", { address: ADDR, phase: "down" }, {});
    const up = await execute("ui.input.click", { address: ADDR, phase: "up" }, {});

    const downAt = (down.data as { atUnixMs?: number }).atUnixMs!;
    const upAt = (up.data as { atUnixMs?: number }).atUnixMs!;
    expect(Number.isFinite(downAt)).toBe(true);
    expect(Number.isFinite(upAt)).toBe(true);
    expect(upAt).toBeGreaterThanOrEqual(downAt);
  });

  it("자극 시각은 배치 장부와 같은 epoch를 쓴다 — 두 시계를 섞지 않는다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const clicked = await execute("ui.input.click", { address: ADDR }, {});
    const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
    await prepared.commit();

    const entry = layoutTransitionJournal()[0]!;
    const atUnixMs = (clicked.data as { atUnixMs?: number }).atUnixMs!;
    expect(entry.preparedAtUnixMs).toBeGreaterThanOrEqual(atUnixMs);
    expect(entry.closedAtUnixMs).toBeGreaterThanOrEqual(entry.preparedAtUnixMs);
  });
});

describe("ui.input.click — 배치 거래의 사유", () => {
  it("자극이 선언한 causeTraceId를 그 자극이 연 배치 거래가 기록한다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR, causeTraceId: "trace-to-left" }, {});
    const prepared = await prepareLayoutMove([{ viewId: "test.v", dx: -160 }]);
    await prepared.commit();

    expect(layoutTransitionJournal()[0]?.causeTraceId).toBe("trace-to-left");
    expect(getSpec("ui.input.click")?.params.causeTraceId).toBeDefined();
  });

  it("사유는 한 거래만 가져간다 — 다음 거래에 흘러가지 않는다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR, causeTraceId: "trace-to-left" }, {});
    await (await prepareLayoutMove([{ viewId: "test.v", dx: -160 }])).commit();
    await (await prepareLayoutMove([{ viewId: "test.v", dx: 160 }])).commit();

    const entries = layoutTransitionJournal();
    expect(entries[0]?.causeTraceId).toBe("trace-to-left");
    expect(entries[1]?.causeTraceId).toBeUndefined();
  });

  it("사유를 선언하지 않은 클릭은 거래에 아무 사유도 심지 않는다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    await execute("ui.input.click", { address: ADDR }, {});
    await (await prepareLayoutMove([{ viewId: "test.v", dx: -160 }])).commit();

    expect(layoutTransitionJournal()[0]?.causeTraceId).toBeUndefined();
  });

  it("빈 causeTraceId는 거절한다 — 조용히 사유 없는 거래로 만들지 않는다", async () => {
    mountNode(`<button data-node="btn">tab</button>`);
    const result = await execute("ui.input.click", { address: ADDR, causeTraceId: "" }, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_PARAMS");
  });
});
