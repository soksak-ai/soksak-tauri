// 정지(hold) 중의 레이아웃 변화는 **그 자리에서** 멈춘다 — 한 프레임도 새면 번쩍임이다.
//
// RED 근거(실측 2026-07-28, 살아있는 앱 · motion-slow 하니스): hold 를 걸고 pane.resize 를
// 하면 rect 시계열이 [678.3, 678.3, 678.3, 678.3, **290.7**, 678.3, …] 이었다. 시작과 끝은
// 같은데 딱 한 표본이 새 레이아웃 값이다. 화면에서는 한 프레임 번쩍임이고, "정지"라는 말이
// 지키기로 한 것을 정확히 어긴다.
//
// 원인은 고정 수단의 타이밍이다. `el.animate()` 의 효과는 다음 프레임 타임라인 갱신에야
// 붙는다 — useLayoutEffect(페인트 전)에서 만들어도 그 프레임의 페인트는 이미 새 레이아웃이다.
// 반대로 인라인 style 은 즉시 서지만 React 의 후속 커밋이 지운다(모듈 머리말의 실측).
//
// 그래서 둘 다다: 인라인이 **그 프레임**을 세우고, 애니메이션이 **그 뒤**를 지킨다. 하나만
// 두면 각자의 실패 모드로 돌아간다 — 어느 쪽도 지우지 마라.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRectMotionTracker, registerRectMotionExclusion } from "./layoutRectMotion";
import { setMotionDebug } from "./motionDebug";

function rectOf(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    width: w,
    height: h,
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 레이아웃을 손으로 정하는 요소 — jsdom 은 배치를 계산하지 않는다. */
function laidOut(w: number, h: number) {
  const el = document.createElement("div");
  let cur = rectOf(0, 0, w, h);
  el.getBoundingClientRect = () => cur;
  // WAAPI 가 없는 환경도 있다 — 있으면 그대로, 없으면 인라인만으로 서야 한다.
  document.body.appendChild(el);
  return { el, move: (nw: number, nh: number) => (cur = rectOf(0, 0, nw, nh)) };
}

describe("정지 중의 레이아웃 변화", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setMotionDebug({ hold: false, scale: 1 });
  });

  it("옛 rect 가 그 자리에서 인라인으로 선다 — 다음 프레임을 기다리지 않는다", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush(); // 기준 잡기

    setMotionDebug({ hold: true });
    move(300, 50); // 명령이 레이아웃을 바꿨다
    t.flush();

    expect(el.style.width, "정지 중인데 새 폭이 한 프레임 샜다").toBe("100px");
    expect(el.style.height).toBe("50px");
  });

  it("정지가 아니면 인라인으로 박지 않는다 — 그 자리는 보간의 것이다", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    move(300, 50);
    t.flush();

    expect(el.style.width).toBe("");
  });

  /** 변화가 없으면 아무것도 박지 않는다 — 안 바뀐 값을 박으면 다음 비교의 출발점이 오염된다. */
  it("정지 중이라도 변화가 없으면 손대지 않는다", () => {
    const t = createRectMotionTracker();
    const { el } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    setMotionDebug({ hold: true });
    t.flush();

    expect(el.style.width).toBe("");
  });

  /**
   * 해제는 인라인을 **걷고** 그 자리에서 활강을 시작한다.
   *
   * 안 걷으면 요소의 실제 rect 가 옛 값 그대로라, 해제 시점의 측정이 "안 움직였다"로 나오고
   * 활강이 서지 않는다 — 정지가 영구가 된다. 정지의 반대말은 영구가 아니다.
   */
  it("해제하면 인라인이 걷힌다", () => {
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    t.ref(el);
    t.flush();

    setMotionDebug({ hold: true });
    move(300, 50);
    t.flush();
    expect(el.style.width).toBe("100px");

    setMotionDebug({ hold: false });

    expect(el.style.width, "해제했는데 옛 rect 가 박힌 채다").toBe("");
    expect(el.style.height).toBe("");
  });
});

describe("viewport resize는 레이아웃 모션이 아니다", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setMotionDebug({ hold: false, scale: 1 });
  });

  it("창 경계가 바뀐 flush는 요소별 FLIP을 만들지 않는다", () => {
    let viewportWidth = 1200;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      get: () => viewportWidth,
    });
    const t = createRectMotionTracker();
    const { el, move } = laidOut(600, 400);
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      currentTime: 0,
      playbackRate: 1,
    }));
    Object.defineProperty(el, "animate", { configurable: true, value: animate });
    t.ref(el);
    t.flush();

    viewportWidth = 900;
    move(450, 400);
    t.flush();

    expect(animate, "viewport reflow를 요소별 모션으로 승격했다").not.toHaveBeenCalled();
  });
});

describe("보간 제외는 코어의 것이 아니다", () => {
  // 재입법 2026-08-03 — 옛 기준은 "홀 제외를 프레임워크 축에 걸지 마라"였고, 그 근거는
  // 2026-08-02 실측이었다: DOM 안 게스트가 보간 끝에 옛 픽셀을 남겼다.
  //
  // **그 근거가 사라졌다.** 그때 게스트는 전역 층에 달려 좌표로 밀리고 있었다(domHost 가 문서
  // 밖 모델을 문서 안에 베낀 상태). 지금 게스트는 자기 자리의 자식이라 조상의 transform 을
  // 그대로 타고 간다 — 재레이아웃이 아니라 합성이므로 못 따라갈 일 자체가 없다.
  //
  // 남은 사유는 하나뿐이고 그것은 보편이 아니다: "그 자리 아래의 표면이 슬롯의 transform 을
  // 안 따라온다"는 콘텐츠가 문서 밖일 때만 참이다. 코어가 그것을 들고 있으면, 그럴 일이 없는
  // 프레임워크에서 그 판만 혼자 즉시 도착하고 이웃은 미끄러진다 — 없던 결함을 제외가 만든다.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "layoutRectMotion.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("코어는 홀을 알지 않는다 — 뺄 자리는 건 쪽이 답한다", () => {
    expect(src, "코어가 홀을 직접 뺀다").not.toMatch(/classList\.contains\("hole"\)/);
    expect(src, "코어가 프레임워크 축을 묻는다").not.toMatch(/nativeChildWebview/);
    // 걸 자리는 있어야 한다 — 없으면 뺄 방법 자체가 사라진 것이고, 그것은 다른 결함이다.
    expect(src).toMatch(/registerRectMotionExclusion/);
  });

  it("안 걸면 홀 자리도 보간된다 — 그럴 일이 없는 프레임워크에서 없던 결함을 만들지 않는다", () => {
    setMotionDebug({ hold: true }); // 인라인으로 옛 rect 를 세우는 경로 — 관측이 확실하다
    const t = createRectMotionTracker();
    const { el, move } = laidOut(100, 50);
    el.classList.add("hole");
    t.ref(el);
    t.flush();
    move(300, 50);
    t.flush();
    // 보간 대상이면 옛 폭이 그 자리에 선다. 빠졌다면 아무것도 안 선다.
    expect(el.style.width, "홀 자리가 코어에서 빠졌다").toBe("100px");
  });

  it("걸면 그 자리가 빠진다 — 판정은 건 쪽의 것이다", () => {
    setMotionDebug({ hold: true });
    const off = registerRectMotionExclusion((e) => e.classList.contains("hole"));
    try {
      const t = createRectMotionTracker();
      const { el, move } = laidOut(100, 50);
      el.classList.add("hole");
      t.ref(el);
      t.flush();
      move(300, 50);
      t.flush();
      expect(el.style.width, "걸었는데 홀 자리가 그대로 보간됐다").toBe("");
      // 오라클 생존 — 홀이 아닌 자리는 여전히 보간된다(제외가 전부를 삼키지 않는다).
      const other = laidOut(100, 50);
      t.ref(other.el);
      t.flush();
      other.move(300, 50);
      t.flush();
      expect(other.el.style.width).toBe("100px");
    } finally {
      off();
    }
  });
});
