import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HOLE_SLOT_SELECTOR } from "./railHoleClip";
import {
  __resetRailHoleClipHostForTest,
  registerRailPlane,
  requestRailHoleClipSync,
} from "./railHoleClipHost";
import { __resetLayoutMotionForTest, beginLayoutMotion, endLayoutMotion } from "./layoutMotion";

// 홀 슬롯은 창의 DOM 에 살고 모션 신호도 창 단위인데, 클립을 프로젝트 pane 이 소유했다.
// 프로젝트 N 개가 동시에 마운트돼 있으므로(세션 보존) 커밋 한 번에 문서 전체 스캔이 N 회,
// 모션 위상에는 rAF 루프가 N 개 돌았다. 같은 불일치를 slotFreezeHost 는 이미 창으로 올렸다.

function plane(): HTMLElement {
  const p = document.createElement("div");
  p.className = "rail-plane";
  for (const cls of ["sidebar", "sidebar"]) {
    const layer = document.createElement("div");
    layer.className = cls;
    p.appendChild(layer);
  }
  document.body.appendChild(p);
  return p;
}

function hole(): HTMLElement {
  const h = document.createElement("div");
  h.className = "egroup-body-slot hole-slot";
  document.body.appendChild(h);
  return h;
}

let scans: number;
let realQSA: typeof document.querySelectorAll;

beforeEach(() => {
  __resetRailHoleClipHostForTest();
  __resetLayoutMotionForTest();
  document.body.innerHTML = "";
  scans = 0;
  realQSA = document.querySelectorAll.bind(document);
  vi.spyOn(document, "querySelectorAll").mockImplementation(((sel: string) => {
    if (sel === HOLE_SLOT_SELECTOR) scans += 1;
    return realQSA(sel);
  }) as typeof document.querySelectorAll);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetRailHoleClipHostForTest();
  __resetLayoutMotionForTest();
});

test("커밋 패스 하나가 문서를 한 번만 스캔한다 — plane 수와 무관", async () => {
  hole();
  for (let i = 0; i < 6; i++) registerRailPlane(plane());

  // 한 React 커밋에서 pane 6 개가 각자 layout effect 를 돌린다.
  for (let i = 0; i < 6; i++) requestRailHoleClipSync();

  await Promise.resolve();
  expect(scans).toBe(1);
});

// React 는 컴포넌트별로 [등록, 동기요청] 을 번갈아 돌린다. 첫 요청에서 즉시 훑으면
// 그 뒤에 등록되는 pane 들이 그 프레임에 클립을 못 받는다 — 첫 페인트에 사이드바가
// 홀 위에 비친다. 합치는 지점은 그 커밋의 등록이 전부 끝난 뒤여야 한다.
test("같은 커밋에서 늦게 등록된 plane 도 그 패스에 클립을 받는다", async () => {
  hole();
  const first = plane();
  const late = plane();

  registerRailPlane(first);
  requestRailHoleClipSync(); // pane1 의 layout effect
  registerRailPlane(late);
  requestRailHoleClipSync(); // pane2 의 layout effect — 억제된다

  await Promise.resolve();
  expect(scans).toBe(1);
  expect(late.querySelector<HTMLElement>(".sidebar")!.style.clipPath).not.toBe("");
});

test("클립은 그 패스에서 등록된 모든 plane 에 걸린다 — 스캔을 아끼려고 빠뜨리지 않는다", async () => {
  hole();
  const planes = [plane(), plane(), plane()];
  for (const p of planes) registerRailPlane(p);

  requestRailHoleClipSync();
  await Promise.resolve();

  for (const p of planes) {
    for (const layer of Array.from(p.querySelectorAll<HTMLElement>(".sidebar"))) {
      expect(layer.style.clipPath).toMatch(/^path\("M0 0H/);
    }
  }
});

test("다음 마이크로태스크 뒤의 커밋은 다시 스캔한다 — 억제는 한 패스 안에서만", async () => {
  hole();
  registerRailPlane(plane());

  requestRailHoleClipSync();
  requestRailHoleClipSync();
  await Promise.resolve();
  expect(scans).toBe(1);

  requestRailHoleClipSync();
  await Promise.resolve();
  expect(scans).toBe(2);
});

test("모션 위상의 rAF 루프는 창에 하나뿐이다 — plane 6 개여도 프레임당 스캔 1회", () => {
  hole();
  for (let i = 0; i < 6; i++) registerRailPlane(plane());

  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});

  beginLayoutMotion("resize");
  expect(frames.length).toBe(1); // 루프 하나만 무장됐다

  scans = 0;
  frames.pop()!(0); // 한 프레임 진행
  expect(scans).toBe(1); // plane 6 개인데 스캔은 1회
  expect(frames.length).toBe(1); // 다음 프레임 재무장도 하나

  endLayoutMotion("resize");
});

test("등록 해제한 plane 은 더 이상 클립을 받지 않는다", async () => {
  hole();
  const kept = plane();
  const gone = plane();
  registerRailPlane(kept);
  const off = registerRailPlane(gone);
  off();
  gone.querySelector<HTMLElement>(".sidebar")!.style.clipPath = "";

  requestRailHoleClipSync();
  await Promise.resolve();

  expect(kept.querySelector<HTMLElement>(".sidebar")!.style.clipPath).not.toBe("");
  expect(gone.querySelector<HTMLElement>(".sidebar")!.style.clipPath).toBe("");
});

test("plane 이 하나도 없으면 문서를 스캔하지 않는다", async () => {
  hole();
  requestRailHoleClipSync();
  await Promise.resolve();
  expect(scans).toBe(0);
});
