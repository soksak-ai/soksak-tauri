// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  B05_POST_SETTLE_HOLD_MS,
  awaitPostSettleHold,
  resolveB05Settlement,
} from "./browser-gate-b05-hold.mjs";

const surfaces = (x) => [
  {
    viewId: "left",
    surfaceId: "surface-left",
    generation: 1,
    live: true,
    visible: true,
    painted: true,
    domFrame: { x, y: 0, w: 100, h: 100 },
    surfaceFrame: { x, y: 0, w: 100, h: 100 },
  },
];

const receipt = (times) => ({
  presentationEvents: times.map((presentedAtUnixMs, sequence) => ({
    sequence,
    presentedAtUnixMs,
    surfaces: surfaces(sequence < 3 ? sequence * 10 : 30),
  })),
});

describe("B05 정착·유지 결합", () => {
  it("정착 epoch 이전의 마지막 표시 프레임을 정착 프레임으로 고른다", () => {
    const value = resolveB05Settlement({
      settleReceipt: { settledAtUnixMs: 1035, syncPending: false },
      presentationReceipt: receipt([1000, 1016, 1032, 1300, 1316]),
    });
    expect(value.settled).toEqual({ atUnixMs: 1035, frameSequence: 2, syncPending: false });
  });

  it("유지 창은 정착에서 시작해 마지막 관측 프레임까지이며 그 프레임의 표면을 싣는다", () => {
    const value = resolveB05Settlement({
      settleReceipt: { settledAtUnixMs: 1035, syncPending: false },
      presentationReceipt: receipt([1000, 1016, 1032, 1300, 1316]),
    });
    expect(value.hold.startedAtUnixMs).toBe(1035);
    expect(value.hold.endedAtUnixMs).toBe(1316);
    expect(value.hold.surfaces).toEqual(surfaces(30));
  });

  it("정착 epoch가 없으면 null로 남긴다 — 프레임에서 되짚어 만들지 않는다", () => {
    const value = resolveB05Settlement({
      settleReceipt: { waitedMs: 12 },
      presentationReceipt: receipt([1000, 1016]),
    });
    expect(value.settled).toEqual({ atUnixMs: null, frameSequence: null, syncPending: null });
    expect(value.hold).toEqual({ startedAtUnixMs: null, endedAtUnixMs: 1016, surfaces: surfaces(10) });
  });

  it("표시 프레임이 없으면 유지 창도 없다", () => {
    const value = resolveB05Settlement({
      settleReceipt: { settledAtUnixMs: 1035, syncPending: false },
      presentationReceipt: { presentationEvents: [] },
    });
    expect(value.settled.frameSequence).toBeNull();
    expect(value.hold).toEqual({ startedAtUnixMs: 1035, endedAtUnixMs: null, surfaces: null });
  });

  it("정착보다 이른 프레임에서 관측이 끝나면 그 사실을 그대로 답한다", () => {
    const value = resolveB05Settlement({
      settleReceipt: { settledAtUnixMs: 2000, syncPending: false },
      presentationReceipt: receipt([1000, 1016]),
    });
    expect(value.hold.endedAtUnixMs).toBe(1016);
    expect(value.hold.endedAtUnixMs - value.hold.startedAtUnixMs).toBeLessThan(B05_POST_SETTLE_HOLD_MS);
  });

  it("유지 대기는 선언한 창과 표시 여유를 합한 유한 값이다", async () => {
    const waits = [];
    await awaitPostSettleHold({ sleep: async (ms) => waits.push(ms) });
    expect(waits).toEqual([B05_POST_SETTLE_HOLD_MS + 60]);
  });

  it("유지 대기 창은 호출자가 선언할 수 있다", async () => {
    const waits = [];
    await awaitPostSettleHold({ holdMs: 400, slackMs: 16, sleep: async (ms) => waits.push(ms) });
    expect(waits).toEqual([416]);
  });
});
