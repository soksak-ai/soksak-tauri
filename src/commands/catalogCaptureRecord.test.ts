// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordWindowFrames } = vi.hoisted(() => ({
  recordWindowFrames: vi.fn(async ({ frames }: { frames: number }) => frames),
}));

vi.mock("../framework", () => ({
  invoke: vi.fn(),
  frameworkPath: { tempDir: vi.fn(), join: vi.fn() },
}));
vi.mock("../i18n", () => ({ tmsg: () => "record" }));
vi.mock("../lib/contentViews", () => ({
  contentViewHost: vi.fn(),
  hasContentViewHost: () => false,
}));
vi.mock("../lib/layoutMotion", () => ({
  isLayoutMotionActive: () => false,
  onLayoutMotion: vi.fn(),
}));
vi.mock("./catalogDom", () => ({ resolveExposed: vi.fn() }));
vi.mock("../lib/surfaceRect", () => ({ surfaceRectOf: vi.fn() }));
vi.mock("./address", () => ({ formatAddress: vi.fn() }));
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "main" }));
vi.mock("./catalog", () => ({ locateTab: vi.fn() }));
vi.mock("../state/sessions", () => ({ useSessions: { getState: vi.fn() } }));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames,
}));
vi.mock("./captureCalibration", () => ({
  CAPTURE_CALIBRATION_ID: "capture-calibration",
  setCaptureCalibration: vi.fn(),
}));
vi.mock("./captureMotionAnchors", () => ({ setCaptureMotionAnchors: vi.fn() }));

import { registerCaptureCatalog } from "./catalogCapture";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeEach(() => {
  recordWindowFrames.mockClear();
  const before = new Set(catalogJson().map(({ name }) => name));
  registerCaptureCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
});

afterEach(() => {
  for (const name of registered) unregister(name);
  registered = [];
});

describe("window.record maxBytes", () => {
  it("공개 스키마와 응답에 요청 저장 budget을 숨기지 않는다", async () => {
    expect(getSpec("window.record")?.params.maxBytes).toMatchObject({ type: "number" });

    const result = await execute("window.record", {
      dir: "/tmp/budget-record",
      frames: 3,
      intervalMs: 7,
      maxBytes: 4_096,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: { dir: "/tmp/budget-record", frames: 3, maxBytes: 4_096 },
    });
    expect(recordWindowFrames).toHaveBeenCalledOnce();
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "/tmp/budget-record",
      frames: 3,
      intervalMs: 7,
      maxBytes: 4_096,
    });
  });

  it.each([1, 1_073_741_824])("경계값 %d bytes를 그대로 허용한다", async (maxBytes) => {
    const result = await execute("window.record", {
      dir: "/tmp/budget-boundary",
      frames: 1,
      maxBytes,
    }, {});

    expect(result).toMatchObject({ ok: true, data: { maxBytes } });
    expect(recordWindowFrames).toHaveBeenCalledWith(expect.objectContaining({ maxBytes }));
  });

  it("budget 생략도 응답에 null로 명시하고 producer에는 가짜 제한을 만들지 않는다", async () => {
    const result = await execute("window.record", {
      dir: "/tmp/unbudgeted-record",
      frames: 1,
    }, {});

    expect(result).toMatchObject({ ok: true, data: { maxBytes: null } });
    expect(recordWindowFrames).toHaveBeenCalledWith({
      dir: "/tmp/unbudgeted-record",
      frames: 1,
      intervalMs: 40,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    1_073_741_825,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("잘못된 budget %s를 producer 호출 전에 INVALID_PARAMS로 거부한다", async (maxBytes) => {
    const result = await execute("window.record", {
      dir: "/tmp/rejected-budget",
      frames: 1,
      maxBytes,
    }, {});

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
  });
});
