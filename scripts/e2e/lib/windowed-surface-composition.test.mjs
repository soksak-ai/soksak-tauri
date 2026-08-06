import { describe, expect, it } from "vitest";
import { windowedSurfaceCompositionVerdict } from "./windowed-surface-composition.mjs";

const input = () => ({
  viewIds: ["tab-left", "tab-right"],
  labels: ["chromium-tab-left", "chromium-tab-right"],
  scaleFactor: 2,
  stats: {
    idMap: { "chromium-tab-left": 3, "chromium-tab-right": 4 },
    ledger: [3, 4],
    surfaces: [
      {
        id: 3,
        surfaceKey: "chromium-tab-left",
        bounds: { x: 0, y: 28, w: 281, h: 421 },
        coordinateSpace: {
          logical: "css-px", origin: "presenter-local", referenceId: "chromium-tab-left",
        },
      },
      {
        id: 4,
        surfaceKey: "chromium-tab-right",
        bounds: { x: 0, y: 28, w: 281, h: 421 },
        coordinateSpace: {
          logical: "css-px", origin: "presenter-local", referenceId: "chromium-tab-right",
        },
      },
    ],
  },
  paneComposition: {
    matches: [
      {
        memberMatches: [{
          label: "chromium-tab-left",
          domFrame: { x: 0, y: 28, w: 281, h: 421 },
          coordinateSpace: {
            logical: "css-px", origin: "presenter-local", referenceId: "chromium-tab-left",
          },
          ok: true,
        }],
      },
      {
        memberMatches: [{
          label: "chromium-tab-right",
          domFrame: { x: 0, y: 28, w: 281, h: 421 },
          coordinateSpace: {
            logical: "css-px", origin: "presenter-local", referenceId: "chromium-tab-right",
          },
          ok: true,
        }],
      },
    ],
  },
});

describe("windowed engine ↔ PaneSurfaceHost composition", () => {
  it("engine bounds를 같은 presenter-local member frame과만 비교한다", () => {
    expect(windowedSurfaceCompositionVerdict(input())).toEqual({ ok: true, errors: [] });
  });

  it("좌표 선언이 없거나 reference가 다른 상태를 창 좌표로 추측하지 않는다", () => {
    const missing = input();
    delete missing.stats.surfaces[0].coordinateSpace;
    expect(windowedSurfaceCompositionVerdict(missing)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining("coordinate-space")]),
    });

    const mixed = input();
    mixed.stats.surfaces[0].coordinateSpace.referenceId = "window-a";
    mixed.stats.surfaces[0].coordinateSpace.origin = "window-absolute";
    expect(windowedSurfaceCompositionVerdict(mixed)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("coordinate-origin"),
        expect.stringContaining("coordinate-reference"),
      ]),
    });
  });

  it("같은 좌표계라도 반올림을 넘는 기하 차이와 소유 장부 오염은 RED다", () => {
    const drift = input();
    drift.stats.surfaces[0].bounds.x = 2;
    drift.stats.ledger.push(91);
    expect(windowedSurfaceCompositionVerdict(drift)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("ownership"),
        expect.stringContaining("frame"),
      ]),
    });
  });
});
