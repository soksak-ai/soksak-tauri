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

let veils: [string, boolean, boolean][] = [];
let sf: SlotFreeze | null = null;

function build(over: Partial<Parameters<typeof createSlotFreeze>[0]> = {}): SlotFreeze {
  sf = createSlotFreeze({
    root: () => document,
    capture: () => Promise.resolve(PNG),
    emitVeil: (viewId, veiled, hidden) => veils.push([viewId, veiled, hidden]),
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
  it("정착 캡처 후 move 위상: 스탠드인 부착 → 페인트 커밋 뒤에야 veil(true)", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
    f.onMotion(true, ["move"]);
    const standin = slot.querySelector<HTMLElement>("img.slot-freeze-frame")!;
    expect(standin).not.toBeNull();
    // 피복은 관측 가능해야 한다 — 주소가 없으면 "덮고 있다"를 잴 방법이 없다.
    expect(standin.dataset.node).toBe("layout/standin/v1");
    expect(slot.dataset.freeze).toBe("1");
    // 순서 계약(§5-2): 스탠드인 페인트가 커밋되기 전에는 표면을 건드리지 않는다 — 반대 순서는
    // 투명 홀이 배경을 노출한다. 이중 rAF 뒤에 비로소 veil(true).
    // 추종 정지는 즉시, 감춤은 페인트 커밋 뒤 — 다른 에지다.
    expect(veils).toEqual([["v1", true, false]]);
    flushRaf();
    flushRaf();
    expect(veils).toEqual([["v1", true, false], ["v1", true, true]]);
  });

  it("스탠드인은 표면이 서 있던 정수 rect 에 1:1 로 선다(분수 슬롯에서도 늘리지 않는다)", async () => {
    // 홀 슬롯 rect 는 분수다(실측 340 / 632.2 / 866.42 / 416.78). 네이티브 표면은 창 좌표의
    // 정수 픽셀에만 설 수 있어 소유자는 ceil/floor 로 접는다(340,633,866,415). 스탠드인을
    // 슬롯 rect 에 꽉 채우면(inset:0 + 100%) 표면이 없던 0.8px 위에서 1.78px 늘어난 사진이
    // 서고, 패널 하단에서 콘텐츠가 2.6px 밀린다 — 동결 에지와 착지 에지에 각각 한 번씩 보인다.
    const slot = makeSlot("v1");
    slot.getBoundingClientRect = () =>
      ({
        left: 340,
        top: 632.2,
        right: 1206.42,
        bottom: 1048.98,
        width: 866.42,
        height: 416.78,
      }) as DOMRect;
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    const standin = slot.querySelector<HTMLElement>("img.slot-freeze-frame")!;
    expect(standin.style.left).toBe("0px"); // ceil(340) - 340
    expect(standin.style.top).toBe("0.8px"); // ceil(632.2) - 632.2
    expect(standin.style.width).toBe("866px"); // floor(1206.42) - 340
    expect(standin.style.height).toBe("415px"); // floor(1048.98) - 633
    // 늘림이 남아 있으면 리샘플이 일어난다 — 스탠드인은 캡처 픽셀을 그대로 되돌려 놓는다.
    expect(standin.style.inset).toBe("");
  });

  it("착지 에지에 스탠드인을 도착 자리의 접힘으로 다시 놓는다(교대 프레임 정합)", async () => {
    // 스탠드인은 동결 시점의 접힘(ceil 잔차)을 들고 미끄러진다. 표면은 도착 자리의 접힘으로
    // 되살아난다 — 슬롯의 분수부가 여정 중에 바뀌면 교대하는 그 한 프레임에서 둘이 1px 어긋난다.
    // 사용자가 보는 순간이 정확히 그 순간이므로, 걷기 직전에 도착 접힘으로 다시 놓는다.
    const slot = makeSlot("v1");
    slot.getBoundingClientRect = () =>
      ({ left: 10.6, top: 10, right: 310.6, bottom: 210, width: 300, height: 200 }) as DOMRect;
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    const standin = slot.querySelector<HTMLElement>("img.slot-freeze-frame")!;
    expect(standin.style.left).toBe("0.4px"); // ceil(10.6) - 10.6
    // 도착 자리는 분수부가 다르다 — 표면은 여기서 ceil(120.2)=121 에 선다.
    slot.getBoundingClientRect = () =>
      ({ left: 120.2, top: 10, right: 420.2, bottom: 210, width: 300, height: 200 }) as DOMRect;
    f.onMotion(false, []);
    expect(standin.style.left).toBe("0.8px"); // ceil(120.2) - 120.2
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

  it("위상 끝: veil(false)=착지 신호, 스탠드인은 '착지 쓰기가 도착한 뒤' 물러난다", async () => {
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
      ["v1", true, false],
      ["v1", true, true],
      ["v1", false, false],
    ]);
    // 시간이 흘러도 착지가 오지 않았으면 스탠드인은 서 있는다 — 홀이 표면보다 먼저 열리면
    // 그 프레임은 빈 구멍이다(느린 사이드카 경로의 실제 위험).
    vi.advanceTimersByTime(200);
    expect(slot.querySelector("img")).not.toBeNull();
    f.noteSurfaceWrite("v1");
    expect(slot.querySelector("img")).toBeNull();
  });

  it("착지가 끝내 오지 않으면 상한에서 걷는다 — 스탠드인이 영구히 남지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const slot = makeSlot("v1");
    const f = build({ landingTimeoutMs: 400 });
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    f.onMotion(false, []);
    vi.advanceTimersByTime(401);
    expect(slot.querySelector("img")).toBeNull();
  });

  it("활강의 전제 — 스탠드인을 세울 수 없는 홀이 있으면 canFreezeAll 이 거절한다", async () => {
    const a = makeSlot("vA");
    makeSlot("vB");
    const f = build();
    f.captureSettled();
    await microtasks();
    // 둘 다 스냅이 구워졌다.
    expect(f.canFreezeAll(["vA", "vB"])).toBe(true);
    // 항행 등 내용 변화로 하나가 버려지면 그 위상은 활강 대상이 아니다(스냅이 정답).
    f.invalidate("vB");
    expect(f.canFreezeAll(["vA", "vB"])).toBe(false);
    expect(f.canFreezeAll(["vA"])).toBe(true);
    // 홀이 아닌 뷰(스냅 없음·슬롯 없음)는 스탠드인이 필요 없다 — 거절 사유가 아니다.
    expect(f.canFreezeAll(["vA", "terminal-view"])).toBe(true);
    void a;
  });

  it("낡은 스냅은 세우지 않는다 — 항행 없이 바뀌는 내용(영상·피드)의 유일한 방어", async () => {
    // 사용자 확정 규칙(§5-3): kinds 미탑재·스냅 부재·낡은 스냅은 라이브 폴백. 항행 무효화만으로는
    // 부족하다 — 영상·피드·SPA 는 항행 없이 픽셀이 바뀐다. 낡아서 못 세우면 활강 자체를 포기하고
    // 스냅하므로(활강 전제) 폴백이 샘플링 추종으로 끌려가지 않는다.
    const slot = makeSlot("v1");
    let clock = 0;
    const f = build({ now: () => clock });
    f.captureSettled();
    await microtasks();
    clock = 60 * 60 * 1000; // 한 시간 뒤
    expect(f.canFreezeAll(["v1"])).toBe(false); // 활강 전제 불성립 → 활강 대신 스냅
    f.onMotion(true, ["move"]);
    expect(slot.dataset.freeze).not.toBe("1");
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
    // resize 가 끼면 즉시 해동 — 변하는 크기 밑 정지 사진은 박제다(§4.6-1). 착지 신호도 간다.
    expect(veils).toEqual([
      ["v1", true, false],
      ["v1", true, true],
      ["v1", false, false],
    ]);
    expect(slot.dataset.freeze).toBe("0");
  });

  it("회수(dispose)도 착지 신호를 보낸다 — veil 을 켠 채 사라지면 표면이 영구히 안 따라온다", () => {
    // 위상 중 프로젝트 pane 이 언마운트되면 동결만 걷히고 veil(true) 이 남는다. 소비자는
    // "따라가지 마라"를 계속 지키므로 이후 어떤 리사이즈에도 bounds 를 보내지 않는다.
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    return microtasks().then(() => {
      f.onMotion(true, ["move"]);
      flushRaf();
      flushRaf();
      expect(veils).toEqual([["v1", true, false], ["v1", true, true]]);
      f.dispose();
      expect(veils).toEqual([
        ["v1", true, false],
        ["v1", true, true],
        ["v1", false, false],
      ]);
      expect(slot.querySelector("img")).toBeNull();
    });
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

describe("slotFreeze — scope 축(영향 범위 밖 표면 불가침)", () => {
  it("scope 밖 슬롯은 동결하지 않는다 — 남의 스왑에 베일 펄스 금지", async () => {
    const a = makeSlot("vA");
    const b = makeSlot("vB");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"], new Set(["vA"]));
    expect(a.querySelector("img")).not.toBeNull();
    expect(b.querySelector("img")).toBeNull(); // 범위 밖 — 라이브 유지
    expect(veils.filter(([v]) => v === "vB")).toEqual([]);
    f.onMotion(false, []);
  });
  it("scope=null(전역)은 전 홀 동결(레일 주행)", async () => {
    const a = makeSlot("vA");
    const b = makeSlot("vB");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"], null);
    expect(a.querySelector("img")).not.toBeNull();
    expect(b.querySelector("img")).not.toBeNull();
    f.onMotion(false, []);
  });
});
