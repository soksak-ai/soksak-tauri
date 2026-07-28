// @vitest-environment jsdom
// ui.* 투명성 완성 계약 — 노드의 "유효 시각/상호작용 상태"(보이나·눌리나·무엇이 가리나)를
// 코어가 노출한다. 지금까지 ui.tree(존재)·ui.measure(기하)는 있었으나, 그 사이의 반쪽
// (effective state)이 빠져 플러그인이 private DOM 을 재발명했다(db-studio probe-clickpath).
//
// 두 축을 검증한다:
//  1) deepElementFromPoint — shadow DOM 을 관통하는 히트테스트(ui.tree/nodeScan 과 대칭).
//     ui.hit 이 document.elementFromPoint 얕은 호출이라 shadow host 에서 멈추던 비대칭 결함.
//  2) ui.measure — style 에 상호작용/가시성 축(pointerEvents/opacity/visibility) 상시 포함,
//     props[] 로 임의 computed prop 요청(하드코딩 필드 한계 제거), occlusion 도달성 판정.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "main" }));
// 셸은 경계 하나로 mock 한다. 창 기하는 테스트가 갈아끼울 수 있게 홀더로 둔다 —
// 정적 import 는 모듈 적재 시점에 묶이므로 doMock(뒤늦은 대체)으로는 닿지 않는다.
const shellWin = vi.hoisted(() => ({
  innerPosition: async () => ({ x: 0, y: 0 }),
  scaleFactor: async () => 1,
}));
vi.mock("../framework", () => ({
  invoke: vi.fn(async () => ({})),
  currentWindow: () => shellWin,
}));

import { registerDomCatalog, deepElementFromPoint, deepActiveElement, viewContainerOf } from "./catalogDom";
import { catalogJson, execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  registerDomCatalog();
});
afterEach(() => {
  // 카탈로그가 등록한 것을 전부 회수한다 — 손으로 적은 목록은 새 명령이 하나 늘 때마다
  // 다음 beforeEach 를 "중복 등록"으로 죽인다(실측: ui.input.key 추가에 23건 실패).
  for (const { name } of catalogJson()) {
    if (name.startsWith("ui.") || name === "webview.emitNative") unregister(name);
  }
  document.body.innerHTML = "";
});

describe("deepElementFromPoint — shadow 관통 히트테스트", () => {
  it("중첩 shadow root 를 관통해 최심 요소를 반환한다", () => {
    const host1 = document.createElement("div");
    const sr1 = host1.attachShadow({ mode: "open" });
    const host2 = document.createElement("div");
    const sr2 = host2.attachShadow({ mode: "open" });
    const leaf = document.createElement("button"); // shadowRoot 없음 → 재귀 종료
    Object.defineProperty(sr1, "elementFromPoint", { value: () => host2, configurable: true });
    Object.defineProperty(sr2, "elementFromPoint", { value: () => leaf, configurable: true });
    const doc = { elementFromPoint: () => host1 } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(5, 5, doc)).toBe(leaf);
  });

  it("shadow 가 없으면 최상단 요소를 그대로 반환한다", () => {
    const el = document.createElement("span");
    const doc = { elementFromPoint: () => el } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(el);
  });

  it("shadow 가 자기 host 를 반환하면 멈춘다(무한 루프 방지)", () => {
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    Object.defineProperty(sr, "elementFromPoint", { value: () => host, configurable: true });
    const doc = { elementFromPoint: () => host } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBe(host);
  });

  it("좌표에 아무것도 없으면 null", () => {
    const doc = { elementFromPoint: () => null } as unknown as DocumentOrShadowRoot;
    expect(deepElementFromPoint(1, 1, doc)).toBeNull();
  });
});

// ui.measure 는 resolveElement(collectExposed) 를 거친다 — .tab-viewer[data-view-addr]
// 안의 [data-node] 를 절대 주소로 수집. 테스트는 그 구조를 세팅하고 주소로 호출한다.
function mountNode(html: string): void {
  document.body.innerHTML =
    `<div class="tab-viewer" data-view-addr="content/view/test.v">${html}</div>`;
}
const ADDR = "win/main/content/view/test.v/node/btn";

describe("ui.measure — 상호작용/가시성 축", () => {
  it("노출 노드의 data-* 상태를 함께 반환해 private DOM 추측을 없앤다", async () => {
    mountNode(`<div data-node="btn" data-projection="focus-near" data-traveling="true">x</div>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { dataset: Record<string, string> }).dataset).toMatchObject({
      node: "btn",
      projection: "focus-near",
      traveling: "true",
    });
  });

  it("style 에 pointerEvents/opacity/visibility 를 상시 포함한다", async () => {
    mountNode(`<button data-node="btn" style="pointer-events:none;opacity:0.5;visibility:hidden">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    // 기존 레이아웃 필드(하위호환) + 새 상호작용/가시성 축.
    expect(style.display).toBeDefined();
    expect(style.pointerEvents).toBe("none");
    expect(style.opacity).toBe("0.5");
    expect(style.visibility).toBe("hidden");
  });

  it("props[] 로 임의 computed 속성을 추가 조회한다(하드코딩 한계 제거)", async () => {
    mountNode(`<button data-node="btn" style="z-index:7;background-color:rgb(1,2,3)">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, props: ["zIndex", "backgroundColor"] }, {});
    expect(r.ok).toBe(true);
    const style = (r.data as { style: Record<string, string> }).style;
    expect(style.zIndex).toBe("7");
    expect(style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("screen:true 면 전역 논리(스크린) 좌표를 함께 반환한다 — OS 포인터 도구가 그대로 소비", async () => {
    // 합성 dispatch 는 히트테스팅·기본동작(포커스)을 재현하지 못한다 — 실포인터 검증은
    // OS 좌표가 필요하다. 그 환산(물리 innerPosition/scale + viewport rect)을 소비자가
    // 재발명하지 않도록 코어가 한 경로로 노출한다.
    shellWin.innerPosition = async () => ({ x: 100, y: 200 });
    shellWin.scaleFactor = async () => 2;
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]') as HTMLElement;
    el.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 30, height: 40 } as DOMRect);
    const r = await execute("ui.measure", { address: ADDR, screen: true }, {});
    expect(r.ok).toBe(true);
    const screen = (r.data as { screen?: Record<string, number> }).screen;
    // 창 논리 원점 (100/2, 200/2) + viewport rect. cx/cy 는 중심 — 클릭 도구가 바로 쓴다.
    expect(screen).toEqual({ x: 60, y: 120, cx: 75, cy: 140 });
  });

  it("occlusion:true 면 도달성 판정을 함께 반환한다", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR, occlusion: true }, {});
    expect(r.ok).toBe(true);
    const occ = (r.data as { occlusion?: Record<string, unknown> }).occlusion;
    // 형태 계약 — reachable(boolean) 과 topTag 를 보고한다(실제 히트 결과는 레이아웃 의존).
    expect(occ).toBeDefined();
    expect(typeof occ!.reachable).toBe("boolean");
    expect("topTag" in occ!).toBe(true);
  });

  it("occlusion 생략 시 도달성 필드는 없다(측정만)", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const r = await execute("ui.measure", { address: ADDR }, {});
    expect((r.data as Record<string, unknown>).occlusion).toBeUndefined();
  });
});

describe("ui.measure/ui.hit — 스펙 선언", () => {
  it("ui.measure 가 props/occlusion 을 선언한다", () => {
    const spec = getSpec("ui.measure");
    expect(spec!.params.props).toBeDefined();
    expect(spec!.params.occlusion).toBeDefined();
  });
});

describe("ui.input.drag — 실시간 재현 표면", () => {
  it("steps/durationMs를 공개하고 지정 단계마다 mousemove를 보낸다", async () => {
    const spec = getSpec("ui.input.drag");
    expect(spec?.params.steps).toBeDefined();
    expect(spec?.params.durationMs).toBeDefined();
    mountNode(`<div data-node="btn">drag</div>`);
    const node = document.querySelector<HTMLElement>("[data-node=btn]")!;
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, left: 10, top: 10, right: 30, bottom: 30,
      width: 20, height: 20, toJSON: () => ({}),
    });
    const xs: number[] = [];
    const onMove = (event: MouseEvent) => xs.push(event.clientX);
    window.addEventListener("mousemove", onMove);
    const result = await execute(
      "ui.input.drag",
      { from: ADDR, dx: 100, steps: 5, durationMs: 0 },
      {},
    );
    window.removeEventListener("mousemove", onMove);
    expect(result.ok).toBe(true);
    expect(xs).toHaveLength(5);
    expect(xs[0]).toBe(40);
    expect(xs[4]).toBe(120);
  });
});

describe("deepActiveElement — shadow 관통 포커스", () => {
  it("shadow root 안 활성 요소를 관통해 반환한다", () => {
    const leaf = document.createElement("input"); // shadowRoot 없음 → 종료
    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    Object.defineProperty(sr, "activeElement", { value: leaf, configurable: true });
    const root = { activeElement: host } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBe(leaf);
  });

  it("shadow 가 없으면 활성 요소를 그대로 반환한다", () => {
    const el = document.createElement("button");
    const root = { activeElement: el } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBe(el);
  });

  it("활성 요소가 없으면 null", () => {
    const root = { activeElement: null } as unknown as DocumentOrShadowRoot;
    expect(deepActiveElement(root)).toBeNull();
  });
});

describe("viewContainerOf — shadow 관통 뷰 판정", () => {
  it("shadow 안 요소의 뷰 컨테이너를 shadow 경계 너머로 찾는다", () => {
    const container = document.createElement("div");
    container.className = "tab-viewer";
    container.dataset.tabId = "tab-v9";
    document.body.appendChild(container);
    const sr = container.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    sr.appendChild(input);
    // light DOM closest 는 shadow 경계에서 막힌다 → host 로 올라가 재시도.
    expect(viewContainerOf(input)).toBe(container);
  });

  it("뷰 컨테이너 밖 요소는 null", () => {
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(viewContainerOf(loose)).toBeNull();
  });
});

describe("ui.input.click — 합성 이벤트가 Shadow DOM 경계를 넘는다(composed, 실클릭 등가)", () => {
  it("shadow 안 노드 클릭이 경계 밖 캡처 리스너(본문 클릭 활성화 경로)에 닿는다", async () => {
    // 실구조 등가: 뷰 컨테이너(스캔 스코프) > shadow host > shadow 안 data-node.
    // 바깥 캡처 리스너 = GroupArea 본문 슬롯의 클릭 활성화 경로와 같은 위치 관계다.
    const container = document.createElement("div");
    container.className = "tab-viewer";
    container.dataset.viewAddr = "content/view/tplug.v";
    container.dataset.tabId = "tab-p1";
    document.body.appendChild(container);
    const host = document.createElement("div");
    container.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.setAttribute("data-node", "sbtest/leaf");
    sr.appendChild(btn);
    const seen: boolean[] = [];
    container.addEventListener("mousedown", (e) => seen.push(e.composed), true);

    const tree = (await execute("ui.tree", {}, {})) as unknown as {
      ok: boolean;
      data: { nodes: { address: string }[] };
    };
    const addr = tree.data.nodes.map((n) => n.address).find((a) => a.includes("sbtest/leaf"));
    expect(addr).toBeTruthy(); // 노드 스캔이 shadow 를 관통해 노출해야 한다
    const r = (await execute("ui.input.click", { address: addr }, {})) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(seen).toEqual([true]); // 경계를 넘어 도달했고 composed 다
  });
});

describe("ui.focus.state — 위젯 수준 포커스 판별 축", () => {
  // 실측 결함: settled=true(activeElement 포함 검사)인데 터미널 커서가 안 그려졌다 —
  // 사용자 판정 기준은 "포커스 착지=검은 커서". DOM activeElement 만으론 위젯(xterm)이
  // 자신을 포커스로 아는지(focus 이벤트 수신·focus 클래스·커서 페인트)와 창이 key 인지
  // (document.hasFocus — 미key 창은 위젯이 커서를 안 그린다)를 가를 수 없다. 두 축을
  // 관측면으로 노출한다: windowFocused + activeElement 조상 클래스 체인.
  it("windowFocused(document.hasFocus)와 activeElement.ancestors 클래스 체인을 보고한다", async () => {
    mountNode(
      `<div data-node="btn" class="terminal xterm focus"><textarea class="xterm-helper-textarea"></textarea></div>`,
    );
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    const orig = document.hasFocus;
    Object.defineProperty(document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
    try {
      const r = await execute("ui.focus.state", {}, {});
      expect(r.ok).toBe(true);
      const d = r.data as {
        windowFocused?: boolean;
        activeElement?: { ancestors?: { tag: string; className: string }[] };
      };
      expect(d.windowFocused).toBe(true);
      const chain = (d.activeElement?.ancestors ?? [])
        .map((a) => a.className)
        .join("|");
      expect(chain).toContain("focus"); // 위젯 포커스 클래스가 체인으로 드러난다
    } finally {
      Object.defineProperty(document, "hasFocus", {
        value: orig,
        configurable: true,
      });
    }
  });
});

describe("ui.focus.trace — 클릭 순간의 포커스 인과 타임라인", () => {
  // 사후 상태 읽기는 오염된다(사용자가 창을 떠나면 blur 로 activeElement 가 body 로 돌아감).
  // 실기기 클릭의 "그 순간"에 무엇이 포커스를 받고 무엇이 빼앗는지는 이벤트 타임라인만이
  // 증언한다. start 는 focusin/focusout/mousedown/mouseup 리스너를 달고 ms 후 스스로 멈춘다
  // (무한 감시 금지) — read 는 기록을 반환한다.
  it("상한은 3분 — 사용자 실조작 왕복(간헐 재현 다회 시도)을 한 타임라인에 담는다", async () => {
    const r = await execute("ui.focus.trace.start", { ms: 999_999_999 }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { ms: number }).ms).toBe(180_000);
  });

  it("start→이벤트 기록→read, ms 경과 후 자기종료한다", async () => {
    vi.useFakeTimers();
    try {
      const s = await execute("ui.focus.trace.start", { ms: 500 }, {});
      expect(s.ok).toBe(true);
      mountNode(`<button data-node="btn">x</button>`);
      const el = document.querySelector('[data-node="btn"]') as HTMLElement;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      const r1 = await execute("ui.focus.trace.read", {}, {});
      expect(r1.ok).toBe(true);
      const d1 = r1.data as { recording: boolean; events: { type: string; dataNode: string | null }[] };
      expect(d1.recording).toBe(true);
      expect(d1.events.map((e) => e.type)).toEqual(["mousedown", "focusin"]);
      expect(d1.events[0].dataNode).toBe("btn");
      vi.advanceTimersByTime(600);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); // 종료 후 이벤트는 무기록
      const r2 = await execute("ui.focus.trace.read", {}, {});
      const d2 = r2.data as { recording: boolean; events: unknown[] };
      expect(d2.recording).toBe(false);
      expect(d2.events.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ui.input.click — phase 분해(게스처 중간 상태의 검증 가능화)", () => {
  // 한 호출로 down→up→click 을 묶으면 게스처 '중간'(mousedown 이후, mouseup 이전)을
  // 바깥에서 관찰할 수 없다 — 게스처 중간의 히트 가능성·활성화 이연처럼 그 중간 상태가 계약인
  // 기능은 검증 불가가 된다. phase 로 시퀀스를 쪼개 down 후 ui.hit/ui.measure 로 중간
  // 상태를 실검증하고 up 으로 마무리한다.
  it('phase:"down" 은 mousedown 만, phase:"up" 은 mouseup+click 만 보낸다', async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]')!;
    const seen: string[] = [];
    for (const t of ["mousedown", "mouseup", "click"])
      el.addEventListener(t, () => seen.push(t));
    const down = await execute("ui.input.click", { address: ADDR, phase: "down" }, {});
    expect(down.ok).toBe(true);
    expect(seen).toEqual(["mousedown"]);
    const up = await execute("ui.input.click", { address: ADDR, phase: "up" }, {});
    expect(up.ok).toBe(true);
    expect(seen).toEqual(["mousedown", "mouseup", "click"]);
  });

  it("ui.hit 결과에 tag/rect 가 살아서 돌아온다 — 봉투 예약키 'data' 와 충돌 금지", async () => {
    // 실측 결함: 핸들러 페이로드 필드명이 봉투 예약키 data 라서 정규화가 그 값만 남기고
    // tag/className/rect 를 전부 버렸다 — 모든 좌표가 "요소 없음"으로 보고됐다(라이브
    // w-d9683c0c, 터미널 center 히트가 canvas 인데 null 보고). 도메인 페이로드는 예약키
    // (ok/code/message/data/media)를 쓰지 않는다 — dataset 명명은 ui.measure 와 정렬.
    const btn = document.createElement("button");
    btn.dataset.node = "hit-target";
    document.body.appendChild(btn);
    const orig = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      value: () => btn,
      configurable: true,
    });
    try {
      const r = await execute("ui.hit", { x: 5, y: 5 }, {});
      expect(r.ok).toBe(true);
      const d = r.data as { tag?: string; dataset?: Record<string, string> };
      expect(d.tag).toBe("button");
      expect(d.dataset).toMatchObject({ node: "hit-target" });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        value: orig,
        configurable: true,
      });
    }
  });

  it("phase 를 생략하면 종전과 동일한 3종 시퀀스다(하위호환)", async () => {
    mountNode(`<button data-node="btn">x</button>`);
    const el = document.querySelector('[data-node="btn"]')!;
    const seen: string[] = [];
    for (const t of ["mousedown", "mouseup", "click"])
      el.addEventListener(t, () => seen.push(t));
    await execute("ui.input.click", { address: ADDR }, {});
    expect(seen).toEqual(["mousedown", "mouseup", "click"]);
  });
});

describe("ui.input.key — 키보드로만 닿는 경로의 구동면", () => {
  // 팔레트 화살표·Esc·Ctrl+R 같은 경로는 클릭 주입으로 검증할 수 없다. 그 자리에 표면이
  // 없으면 "키보드 경로는 확인 못 했다"가 남는다. 그래서 키를 넣고, 핸들러가 그 키를
  // 집었는지(defaultPrevented)까지 돌려준다 — 삼켜졌는지 흘렀는지 밖에서 갈린다.
  it("노출 노드에 keydown·keyup 을 넣고 수정자와 소진 여부를 보고한다", async () => {
    mountNode(`<div data-node="btn" tabindex="0">x</div>`);
    const el = document.querySelector("[data-node=btn]") as HTMLElement;
    const seen: string[] = [];
    el.addEventListener("keydown", (e) => {
      seen.push(`down:${e.key}:${e.ctrlKey ? "ctrl" : ""}`);
      if (e.key === "r") e.preventDefault(); // 핸들러가 집었다
    });
    el.addEventListener("keyup", (e) => seen.push(`up:${e.key}`));

    const r = await execute("ui.input.key", { address: ADDR, key: "r", ctrl: true }, {});
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["down:r:ctrl", "up:r"]);
    expect((r.data as { defaultPrevented: boolean }).defaultPrevented).toBe(true);

    const fell = await execute("ui.input.key", { address: ADDR, key: "ArrowDown" }, {});
    expect((fell.data as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
  });

  it("노출되지 않은 주소는 NOT_EXPOSED, 빈 key 는 INVALID_PARAMS — 추측하지 않는다", async () => {
    mountNode(`<div data-node="btn">x</div>`);
    const ghost = await execute("ui.input.key", { address: "win/main/content/view/test.v/node/nope", key: "Enter" }, {});
    expect(ghost.ok).toBe(false);
    expect(ghost.code).toBe("NOT_EXPOSED");
    const empty = await execute("ui.input.key", { address: ADDR, key: "" }, {});
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("INVALID_PARAMS");
  });
});

// ui.verify 의 tab.sized — 진단이 "무엇을 훑었는지" 를 스스로 말해야 한다.
//
// (실측 결함) 탭 본문의 DOM 주소가 layout/slot/ → layout/tab/ 로 옮겨진 뒤에도 이 검사는 옛
// 접두를 훑고 있었다. 대상 0건이면 위반 0건이라 검사는 언제나 통과한다 — 통과가 아니라 눈이
// 감긴 것이다. 그래서 여기서 두 가지를 함께 못박는다: ① 무너진 본문을 실제로 잡는다,
// ② 통과할 때도 훑은 개수를 답에 싣는다(0 을 훑고 통과하면 그 수가 0 으로 드러난다).
type VerifyRes = { passed: boolean; failed: number; checks: { name: string; ok: boolean; detail: string }[] };

function mountTabBody(id: string, rect: { width: number; height: number }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-node", `layout/tab/${id}`);
  document.body.appendChild(el);
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      x: 0, y: 0, top: 0, left: 0,
      width: rect.width,
      height: rect.height,
      right: Math.max(rect.width, 1), // 화면 안(onScreen) 판정을 통과시킨다
      bottom: Math.max(rect.height, 1),
      toJSON: () => ({}),
    }),
    configurable: true,
  });
  return el;
}

describe("ui.verify — tab.sized 는 실제로 탭 본문을 훑는다", () => {
  const sized = (r: VerifyRes) => r.checks.find((c) => c.name === "tab.sized")!;

  it("크기 있는 본문은 통과하고, 훑은 개수를 답에 싣는다", async () => {
    mountTabBody("tab-a", { width: 800, height: 600 });
    const r = (await execute("ui.verify", {}, {})).data as unknown as VerifyRes;
    const check = sized(r);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("1개"); // 0 을 훑고 통과하면 여기가 0개다
  });

  it("보이는데 크기가 0 인 본문을 잡는다 — 그 칸은 빈 화면이다", async () => {
    mountTabBody("tab-a", { width: 800, height: 600 });
    mountTabBody("tab-collapsed", { width: 0, height: 600 });
    const r = (await execute("ui.verify", {}, {})).data as unknown as VerifyRes;
    const check = sized(r);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("layout/tab/tab-collapsed");
    // 판정은 payload 의 passed 다(ok 는 봉투 예약키 — 여기 실리면 삼켜진다).
    expect(r.passed).toBe(false);
    expect(r.failed).toBe(1);
  });
});

// ui.input.pointer 의 골 강조 — 무장과 해제가 같은 표면에서 관측돼야 한다.
//
// (실측 결함) 골 요소의 앵커가 data-divider-key → data-gutter-key 로 옮겨진 뒤에도 이 명령은
// 옛 이름을 읽고 있었다. 그러면 강조가 한 번도 켜지지 않는데 답은 그저 gutterHover: null 이라
// "그 자리는 골이 아니다" 와 구별되지 않는다 — 실패가 정상 응답으로 위장한다.
describe("ui.input.pointer — 골 강조는 상태로 무장되고 해제된다", () => {
  const GUTTER = "gutter/pan-a/right";

  function mountGutter(): void {
    document.body.innerHTML = "";
    const el = document.createElement("div");
    el.setAttribute("data-node", GUTTER);
    el.dataset.gutterKey = GUTTER; // GroupArea 가 심는 그 앵커
    document.body.appendChild(el);
  }

  it("골 위로 들어가면 그 골 주소로 무장하고, 답이 무장된 키를 말한다", async () => {
    mountGutter();
    const r = await execute("ui.input.pointer", { address: `win/main/chrome/${GUTTER}` }, {});
    expect(r.ok).toBe(true);
    expect((r.data as { gutterHover: string | null }).gutterHover).toBe(GUTTER);
  });

  it("주소 없이 부르면(이탈) 해제되고, 답이 해제를 말한다", async () => {
    mountGutter();
    await execute("ui.input.pointer", { address: `win/main/chrome/${GUTTER}` }, {});
    const r = await execute("ui.input.pointer", {}, {});
    expect(r.ok).toBe(true);
    expect((r.data as { gutterHover: string | null }).gutterHover).toBeNull();
  });
});
