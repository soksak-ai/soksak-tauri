// 활강의 전제는 "덮을 수 있는가"이지 "장치가 걸렸는가"가 아니다.
//
// RED 근거(2026-08-03): `canGlideViews` 가 엔진 미설치를 **false** 로 답했다. 그 값은
// `phase.glide` 로 굳고 → `railTraveling` 이 거짓이 되고 → 배치 전환이 활강 대신 **즉시 스냅**
// 으로 떨어지며 `beginLayoutMotion` 조차 뜨지 않는다. 콘텐츠가 문서 안에 사는 프레임워크에는
// 덮을 표면이 애초에 없으므로 그 전제는 이미 성립인데, 답 하나가 "못 덮는다"와 "덮을 게 없다"를
// 함께 담아 멀쩡한 전환을 통째로 죽였다("0 의 두 얼굴").
//
// 스탠드인 장치를 건 프레임워크에서는 판정이 그대로 엔진의 답이어야 한다 — 덮을 수 없는 표면이
// 끼면 그 표면만 샘플링으로 끌려가 스터터가 난다.
import { beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  const m = await import("./slotFreezeHost");
  m.disposeSlotFreezeHost();
  return m;
}

/** 최소 엔진 대역 — 판정만 답하고 나머지는 부르지 않는다. */
function engineDeps(canFreezeAll: boolean) {
  return {
    root: () => document,
    capture: async () => "data:image/png;base64,",
    emitVeil: () => {},
    __canFreezeAll: canFreezeAll,
  };
}

describe("활강의 전제", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("덮을 것이 없으면 전제는 이미 성립이다 — 안 걸렸다고 활강을 막지 않는다", async () => {
    const m = await load();
    expect(m.slotFreezeHost()).toBeNull();
    expect(m.canGlideViews(["v1", "v2"])).toBe(true);
  });

  it("장치가 걸렸으면 판정은 그 엔진의 답이다", async () => {
    const m = await load();
    const engine = m.ensureSlotFreezeHost(engineDeps(true));
    vi.spyOn(engine, "canFreezeAll").mockReturnValue(false);
    expect(m.canGlideViews(["v1"])).toBe(false);
    vi.spyOn(engine, "canFreezeAll").mockReturnValue(true);
    expect(m.canGlideViews(["v1"])).toBe(true);
    m.disposeSlotFreezeHost();
  });
});
