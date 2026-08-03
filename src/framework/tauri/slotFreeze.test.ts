// @vitest-environment jsdom
// Tauri 자식 표면 기하 거래 — 제품 플러그인과 코어에 프레임워크 합성 정책을 넣지 않고,
// Tauri 어댑터가 공개 홀-슬롯과 모션 위상을 소비해 DOM 스탠드인/veil 교대를 시행한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlotFreeze, type SlotFreeze } from "./slotFreeze";

const PNG = "data:image/png;base64,x";

function makeSlot(viewId: string): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "tab-body";
  frame.dataset.tauriHoleFrame = "";
  frame.setAttribute("data-node", `layout/tab/${viewId}`);
  const el = document.createElement("div");
  el.dataset.tauriHole = "content";
  el.setAttribute("data-content-view-body", `cv-${viewId}`);
  frame.appendChild(el);
  document.body.appendChild(frame);
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

describe("slotFreeze — Tauri 자식 표면 기하 거래", () => {
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
    expect(veils).toEqual([["cv-v1", true, false]]);
    flushRaf();
    flushRaf();
    expect(veils).toEqual([["cv-v1", true, false], ["cv-v1", true, true]]);
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

  it("파킹된 뷰(비활성 탭)는 활강 전제를 죽이지 않는다 — 보이지 않는 것은 덮을 필요가 없다", async () => {
    // 한 패널에 브라우저 탭이 둘 이상이면 비활성 탭은 DOM 가시성이 꺼진다. 그 뷰의 스냅은
    // 굽히지도 않고 낡아 가는데, 활강 전제가 그것까지 물으면 **탭이 둘 이상인 패널은 영원히
    // 활강하지 못한다**(사용자 실측: 브라우저 탭 3개 패널에서 여정이 통째로 순간이동).
    // 보이지 않는 표면은 옛 자리를 드러낼 수 없으므로 스탠드인이 필요 없다.
    const shown = makeSlot("v1");
    const parked = makeSlot("v2");
    const f = build();
    f.captureSettled();
    await microtasks();
    parked.style.visibility = "hidden";
    // 파킹된 슬롯의 스냅이 낡았더라도 전제를 깨지 않는다 — 그 표면은 보이지 않는다.
    f.invalidate("cv-v2");
    expect(f.canFreezeAll(["v1", "v2"])).toBe(true);

    // 그리고 파킹된 슬롯은 동결 대상도 아니다. 동결하면 해동 에지에 veil(false) 가 가고,
    // 표면 소유자는 그 신호에 좌표를 쓰고 **다시 보이게** 한다 — 비활성 탭의 페이지가 여정마다
    // 한 번씩 번쩍인다(사용자 실측: 브라우저 탭 여럿인 패널에서 깜빡임).
    f.onMotion(true, ["move"]);
    expect(shown.querySelector("img.slot-freeze-frame")).not.toBeNull();
    expect(parked.querySelector("img.slot-freeze-frame")).toBeNull();
    expect(veils.map((v) => v[0])).toEqual(["cv-v1"]);
  });

  it("크기가 어긋난 스냅은 버려진다 — 낡은 크기가 활강을 영구히 막지 못한다", async () => {
    // 실측 결함: 분할 전(454px)에 구운 스냅이 분할 후(221px) 슬롯에 남아 canFreezeAll 이
    // 매번 no:size 로 거부했고, 그 뷰가 비활성(dim)이면 재캡처는 셰이드 박제 금지로 건너뛰어져
    // 스냅이 영원히 갱신되지 않았다 — 모든 여정이 통째로 순간이동했다. 버려야 회복한다.
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
    // 분할 — 슬롯이 좁아진다.
    slot.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 160, bottom: 210, width: 150, height: 200 }) as DOMRect;
    expect(f.canFreezeAll(["v1"])).toBe(false); // 이 여정은 활강하지 않는다(정당)
    expect(slot.dataset.freezeSnapAt).toBeUndefined(); // 그리고 낡은 스냅은 남지 않는다
    // 청정해진 다음 정착 에지가 맞는 크기로 굽고 전제가 회복된다.
    f.captureSettled();
    await microtasks();
    expect(f.canFreezeAll(["v1"])).toBe(true);
  });

  it("resize 동안 네이티브 표면 대신 슬롯 크기를 따르는 스탠드인을 합성한다", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["resize"]);
    const standin = slot.querySelector<HTMLElement>("img.slot-freeze-frame")!;
    expect(standin).not.toBeNull();
    expect(standin.style.width).toBe("100%");
    expect(standin.style.height).toBe("100%");
    expect(veils).toEqual([["cv-v1", true, false]]);
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
      ["cv-v1", true, false],
      ["cv-v1", true, true],
      ["cv-v1", false, false],
    ]);
    // 시간이 흘러도 착지가 오지 않았으면 스탠드인은 서 있는다 — 홀이 표면보다 먼저 열리면
    // 그 프레임은 빈 구멍이다(느린 사이드카 경로의 실제 위험).
    vi.advanceTimersByTime(200);
    expect(slot.querySelector("img")).not.toBeNull();
    // 재입법(2026-08-02, 사용자 실측): 옛 기준은 "쓰기가 도착하면 즉시 걷는다"였다. 그 즉시가
    // 정확히 한 프레임을 만든다 — 이 신호는 "소유자가 좌표를 쓰고 보이게 했다"까지이고, 그
    // 표면이 새 자리에 그려졌다는 말이 아니다. 곧장 걷으면 렌더러는 다음 페인트에 홀을 열고,
    // 표면의 표시가 그보다 늦으면 배경이 한 프레임 드러난다("교체가 끝나고 딱 한 프레임에서
    // 사라졌다 다음 프레임에서 나타난다" — 경로와 무관하게 공통).
    //
    // 동결 에지는 이미 같은 규율을 지킨다: 사진을 붙이고 페인트가 커밋된 뒤 표면을 숨긴다.
    // 해동은 그 거울이다.
    f.noteSurfaceWrite("cv-v1");
    expect(slot.querySelector("img"), "쓰기 신호만으로 걷으면 안 된다").not.toBeNull();
    flushRaf();
    expect(slot.querySelector("img"), "한 프레임으로는 부족하다 — 커밋을 확인한다").not.toBeNull();
    flushRaf();
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
    f.invalidate("cv-vB");
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

  it("활성 중 resize가 합쳐져도 네이티브 합성 거래가 끝날 때까지 동결을 유지한다", async () => {
    const slot = makeSlot("v1");
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"]);
    flushRaf();
    flushRaf();
    f.onMotion(true, ["move", "resize"]);
    // 종류 재발화는 같은 기하 거래다. 중간 해동은 네이티브 표면을 다시 한 프레임 늦게 만든다.
    expect(veils).toEqual([
      ["cv-v1", true, false],
      ["cv-v1", true, true],
    ]);
    expect(slot.dataset.freeze).toBe("1");
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
      expect(veils).toEqual([["cv-v1", true, false], ["cv-v1", true, true]]);
      f.dispose();
      expect(veils).toEqual([
        ["cv-v1", true, false],
        ["cv-v1", true, true],
        ["cv-v1", false, false],
      ]);
      expect(slot.querySelector("img")).toBeNull();
    });
  });
});

describe("slotFreeze — 흐림은 사진을 막지 않는다(재입법 2026-08-02)", () => {
  // 옛 기준: "흐린 슬롯은 안 찍는다 — 베일이 사진에 구워지니까".
  // 그 기준은 동결을 **굶겼다.** 청정한 슬롯은 포커스 판 하나뿐인데, 움직이는 것은 포커스 판과
  // 자리를 바꾸는 상대다. 상대는 늘 흐리니 사진이 없고, 하나라도 못 덮으면 활강을 포기한다 —
  // 즉 교체는 구조적으로 절대 동결될 수 없었다. 실측: 교체 정점에서 브라우저 둘이 통째로 비었다
  // (홀은 애니메이션을 타는데 표면은 안 타므로, 덮을 사진이 없으면 배경이 드러난다).
  //
  // 새 기준: 찍는다. 사진은 그때의 흐림과 한 몸이고, 단계가 달라지면 크기 드리프트와 같은
  // 규칙으로 버린다. 여정 중에는 흐림이 바뀌지 않는다(흐림도 화면이 그리는 해를 따른다).
  it("흐린 슬롯도 찍는다 — 안 찍으면 활강에서 덮을 것이 없다", async () => {
    const area = document.createElement("div");
    area.className = "space";
    document.body.appendChild(area);
    const slot = makeSlot("v1");
    slot.dataset.dim = "idle";
    area.appendChild(slot);
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
    expect(slot.dataset.freezeSnapSkip).toBeUndefined();
  });

  it("낀 슬롯도 찍는다", async () => {
    const area = document.createElement("div");
    area.className = "space";
    document.body.appendChild(area);
    const slot = makeSlot("v2");
    slot.dataset.dim = "blocked";
    area.appendChild(slot);
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
  });

  it("프레임의 흐림이 바뀌어도 raw 표면 스냅을 세운다 — dim은 살아 있는 DOM 베일의 책임", async () => {
    const area = document.createElement("div");
    area.className = "space";
    document.body.appendChild(area);
    const slot = makeSlot("v3");
    const frame = slot.closest<HTMLElement>(".tab-body")!;
    frame.dataset.dim = "idle";
    area.appendChild(slot);
    const f = build();
    f.captureSettled();
    await microtasks();
    expect(slot.dataset.freezeSnapAt).toBeDefined();

    frame.dataset.dim = "clear";
    f.onMotion(true, ["move"], null);
    expect(slot.querySelector("img")).not.toBeNull();
    expect(slot.dataset.freezeSnapAt).toBeDefined();
    expect(slot.dataset.freezeReject).toBeUndefined();
  });

  it("캡처는 창 crop이 아니라 슬롯이 선언한 네이티브 표면 label을 요청한다", async () => {
    const capture = vi.fn(async () => PNG);
    makeSlot("v-native");
    const f = build({ capture });
    f.captureSettled();
    await microtasks();
    expect(capture).toHaveBeenCalledWith(
      "cv-v-native",
      { x: 10, y: 10, w: 300, h: 200 },
    );
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

describe("스탠드인과 라이브 DOM 베일의 합성 순서", () => {
  it("raw 표면 스탠드인은 베일(z4) 아래 z3에 선다", async () => {
    const area = document.createElement("div");
    area.className = "space";
    document.body.appendChild(area);
    const slot = makeSlot("v9");
    slot.dataset.dim = "idle";
    area.appendChild(slot);
    const f = build();
    f.captureSettled();
    await microtasks();
    f.onMotion(true, ["move"], null);
    const img = slot.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("style")).toContain("z-index: 3");
  });
});
