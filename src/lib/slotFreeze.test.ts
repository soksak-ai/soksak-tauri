// @vitest-environment jsdom
// 코어 소유 이동-동결(§4.6 시행) — transparent 선언(홀-슬롯) 하나로 모든 네이티브 표면이
// move 위상 동결을 얻는다. RED 근거: 판정된 동결 기계는 플러그인(browser-native)에만
// 배선돼 있었다 — 다른 네이티브 표면은 같은 이질감을 그대로 가진다. 코어가 슬롯 계층에서
// 시행하면 소비자 의무는 선언 + (사이드카 표면의) veil 릴레이뿐이다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlotFreeze, type SlotFreeze } from "./slotFreeze";

const PNG = "data:image/png;base64,x";

function makeSlot(viewId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "egroup-body-slot hole-slot";
  el.setAttribute("data-node", `layout/slot/${viewId}`);
  document.body.appendChild(el);
  // jsdom 은 레이아웃이 없다 — 가시 슬롯 rect 를 명시 주입한다.
  el.getBoundingClientRect = () =>
    ({ left: 10, top: 10, right: 310, bottom: 210, width: 300, height: 200 }) as DOMRect;
  return el;
}

let rafQ: FrameRequestCallback[] = [];
function flushRaf(): void {
  const q = rafQ;
  rafQ = [];
  for (const cb of q) cb(0);
}
async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let veils: [string, boolean][] = [];
let sf: SlotFreeze | null = null;

function build(over: Partial<Parameters<typeof createSlotFreeze>[0]> = {}): SlotFreeze {
  sf = createSlotFreeze({
    root: () => document,
    capture: () => Promise.resolve(PNG),
    emitVeil: (viewId, veiled) => veils.push([viewId, veiled]),
    imageFactory: () => {
      const im = document.createElement("img");
      (im as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
      return im;
    },
    ...over,
  });
  return sf;
}

beforeEach(() => {
  document.body.innerHTML = "";
  veils = [];
  rafQ = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQ.push(cb);
    return rafQ.length;
  });
});
afterEach(() => {
  sf?.dispose();
  sf = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("slotFreeze — 코어 소유 이동-동결", () => {
  it("정착 캡처 후 move 위상: 스탠드인 부착 → 이중 rAF 뒤 veil(true)", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
    f.onMotion(true, ["move"]);
    expect(slot.querySelector("img.slot-freeze-frame")).not.toBeNull();
    expect(slot.dataset.freeze).toBe("1");
    expect(veils).toEqual([]); // 페인트 커밋 전 — 표면은 아직 보인다
    flushRaf();
    flushRaf();
    expect(veils).toEqual([["v1", true]]);
  });

  it("resize 가 끼면(단독·혼합) 동결하지 않는다", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["resize"]);
    f.onMotion(true, ["move", "resize"]);
    expect(slot.querySelector("img")).toBeNull();
    expect(veils).toEqual([]);
  });

  it("스냅 없는 슬롯은 건너뛴다(폴백 = 라이브 추종)", () => {
    const slot = makeSlot("v1");
    const f = build();
    f.onMotion(true, ["move"]);
    expect(slot.querySelector("img")).toBeNull();
  });

  it("스냅 이후 슬롯 크기가 변했으면 건너뛴다(늘어난 정지 사진 금지)", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    slot.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 510, bottom: 210, width: 500, height: 200 }) as DOMRect;
    f.onMotion(true, ["move"]);
    expect(slot.querySelector("img")).toBeNull();
  });

  it("위상 끝: veil(false) 즉시, 스탠드인은 한 박자 뒤 제거", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] }); // rAF 스텁은 수동 큐 유지
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    flushRaf();
    flushRaf();
    f.onMotion(false, []);
    expect(veils).toEqual([
      ["v1", true],
      ["v1", false],
    ]);
    expect(slot.querySelector("img")).not.toBeNull(); // 복귀 프레임 아래 잠시 유지
    vi.advanceTimersByTime(120);
    expect(slot.querySelector("img")).toBeNull();
  });

  it("활성 중 resize 개입(종별 재발화)이면 즉시 해동한다", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    flushRaf();
    flushRaf();
    f.onMotion(true, ["move", "resize"]);
    expect(veils).toEqual([
      ["v1", true],
      ["v1", false],
    ]);
    expect(slot.dataset.freeze).toBe("0");
  });
});

describe("slotFreeze — dim 상태 캡처 배제(포커스 장식 박제 금지)", () => {
  it("focus-dim 이 걸린(비활성) 슬롯은 정착 캡처를 건너뛴다 — 청정 스냅만 굽는다", async () => {
    const area = document.createElement("div");
    area.className = "egroup-area";
    area.setAttribute("data-focus-dim", "1");
    document.body.appendChild(area);
    const slot = makeSlot("v1");
    area.appendChild(slot); // dim 대상(스팟 아님)
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeUndefined();
    slot.classList.add("spot-clear"); // 활성(청정) — 이제 캡처된다
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
  });
});
