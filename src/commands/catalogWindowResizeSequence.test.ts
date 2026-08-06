// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { currentWindow, recordWindowFrames, sampleWindowResizeProbe, setPhysicalSize } = vi.hoisted(() => ({
  currentWindow: vi.fn(),
  recordWindowFrames: vi.fn(),
  sampleWindowResizeProbe: vi.fn(),
  setPhysicalSize: vi.fn(),
}));

vi.mock("../framework", () => ({
  invoke: vi.fn(),
  currentWindow,
  windowByLabel: vi.fn(),
}));
vi.mock("../i18n", () => ({ tmsg: () => "resize sequence" }));
vi.mock("../lib/projectRoot", () => ({ validateProjectRoot: vi.fn() }));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => `b-${label}-`,
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));
vi.mock("../lib/windowResizeProbe", () => ({ sampleWindowResizeProbe }));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames,
}));

import { registerWindowCatalog } from "./catalogWindow";
import { catalogJson, execute, getSpec, unregister } from "./registry";

let registered: string[] = [];

beforeAll(() => {
  const before = new Set(catalogJson().map(({ name }) => name));
  registerWindowCatalog();
  registered = catalogJson().map(({ name }) => name).filter((name) => !before.has(name));
});

afterAll(() => {
  for (const name of registered) unregister(name);
});

beforeEach(() => {
  setPhysicalSize.mockReset().mockResolvedValue(undefined);
  currentWindow.mockReset().mockReturnValue({ setPhysicalSize });
  sampleWindowResizeProbe.mockReset().mockResolvedValue({ sample: true });
  recordWindowFrames.mockReset().mockImplementation(({ frames }: { frames: number }) =>
    Object.assign(Promise.resolve(frames), { ready: Promise.resolve() }));
});

describe("window.resizeSequence recording contract", () => {
  it("공개 byte budget을 recorder에 그대로 전달하고 녹화 상태를 resize 결과와 분리한다", async () => {
    expect(getSpec("window.resizeSequence")?.params.recordMaxBytes).toMatchObject({ type: "number" });

    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }, { w: 1200, h: 800 }],
      intervalMs: 0,
      recordDir: "/evidence/resize",
      recordFrames: 20,
      recordIntervalMs: 7,
      recordMaxBytes: 4_096,
    }, {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: 2,
        recording: {
          status: "complete",
          mode: "realtime",
          dir: "/evidence/resize",
          requestedFrames: 20,
          frames: 20,
        },
      },
    });
    expect(result).not.toHaveProperty("data.frames");
    expect(recordWindowFrames).toHaveBeenCalledWith(expect.objectContaining({
      dir: "/evidence/resize",
      frames: 20,
      intervalMs: 7,
      maxBytes: 4_096,
      onFrame: expect.any(Function),
    }));
  });

  it.each([
    ["recordFrames", 0],
    ["recordFrames", 601],
    ["recordFrames", 1.5],
    ["recordIntervalMs", -1],
    ["recordIntervalMs", 1_001],
    ["recordIntervalMs", Number.POSITIVE_INFINITY],
    ["recordMaxBytes", 0],
    ["recordMaxBytes", 1_073_741_825],
    ["recordMaxBytes", 1.5],
  ])("잘못된 %s=%s를 clamp하지 않고 producer와 resize 전에 거부한다", async (field, value) => {
    const result = await execute("window.resizeSequence", {
      sizes: [{ w: 800, h: 600 }],
      intervalMs: 0,
      recordDir: "/evidence/resize",
      [field]: value,
    }, {});

    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(recordWindowFrames).not.toHaveBeenCalled();
    expect(setPhysicalSize).not.toHaveBeenCalled();
  });
});
