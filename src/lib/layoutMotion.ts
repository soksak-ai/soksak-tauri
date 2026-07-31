// 레이아웃 모션 신호(단일 진실) — "네이티브 child 위 표면이 움직이는 중"이라는 사실을
// 세 소비자 계층에 에지로 알린다: ① 플러그인 events(layout.resize-gesture — 브라우저가
// 매 프레임 native bounds 추종 루프를 살린다) ② Rust 릴레이(webview_resize_gesture — CEF)
// ③ 코어 로컬 리스너(onLayoutMotion — 레일-홀 클립 등 DOM 측 동조자).
// 디바이더 드래그·레일 주행·FLIP 이 겹칠 수 있으므로 레퍼카운트로 시작/끝 짝을 보장한다.
// 근거(실측): 주행 애니메이션 중 DOM 은 미끄러지는데 child 는 끝에서 점프해 이질감(영상).
//
// kind 축 — 위상의 종별을 페이로드로 실어 소비자가 대응을 가른다:
//   move   = 표면 크기는 그대로고 위치만 활강한다(레일 주행·FLIP 스왑·스테이션 드래그).
//            브라우저가 freeze-frame 스탠드인을 세워도 콘텐츠 박제가 아니다(내용 불변 구간).
//   resize = 표면 크기가 프레임마다 변한다(디바이더·폭 드래그). 반드시 라이브 추종이어야
//            하며 freeze 는 금지다(과거 freeze-frame 이 제거된 이유 — 콘텐츠 박제·잔상).
// 페이로드 { active, kinds }: kinds = 그 순간 활성인 종별들. active 인 채 종별 구성이
// 바뀌면 active:true 를 재발화한다 — 소비자는 재평가한다(예: 주행 중 디바이더 개입 → 해동).
import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { emitPluginEvent } from "../plugins/hooks";

export type LayoutMotionKind = "move" | "resize";

const counts: Record<LayoutMotionKind, number> = { move: 0, resize: 0 };
// 진행 중 위상들의 영향 범위(viewId 집합) — null 요소 = 전역(전 슬롯 이동: 레일 주행 등).
// 소비자(슬롯 동결)는 합집합만 동결한다: 관련 없는 표면이 남의 스왑에 베일 펄스를 맞는
// 결함(실사고)의 근치 — 움직이지 않는 슬롯은 위상 내내 라이브로 남는다.
const scopes: (Set<string> | null)[] = [];

// 합산 범위 — 하나라도 전역(null)이면 전역. 아니면 viewId 합집합.
function activeScope(): Set<string> | null {
  if (scopes.some((s) => s === null)) return null;
  const u = new Set<string>();
  for (const s of scopes) for (const v of s ?? []) u.add(v);
  return u;
}
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화·구독
// 해지 자리가 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
/** 중복 발화 억제 — 마지막으로 내보낸 상태(active+kinds). */
const emitted = moduleState("lib/layoutMotion#emitted", () => ({
  lastEmittedKey: null as string | null,
}));
type MotionListener = (
  active: boolean,
  kinds: LayoutMotionKind[],
  scope: Set<string> | null,
) => void;
// 갈아끼우기 경계 밖 — 이 표가 새것이 되면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않는다.
const listeners = moduleState("lib/layoutMotion#listeners", () => new Set<MotionListener>());
/** 모션 에지(시작/끝) 구독. 반환 함수로 해지한다. */
export function onLayoutMotion(listener: MotionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function depth(): number {
  return counts.move + counts.resize;
}

function activeKinds(): LayoutMotionKind[] {
  const kinds: LayoutMotionKind[] = [];
  if (counts.move > 0) kinds.push("move");
  if (counts.resize > 0) kinds.push("resize");
  return kinds;
}

// 에지·종별변화 발화 — 로컬 리스너는 active 에지에서만 부르고(기존 계약 유지), 플러그인
// 채널은 종별 구성 변화도 받는다(active:true 재발화 — freeze 재평가의 근거).
/** 명령발 레이아웃 변화(분할·최대화·닫기·비율)의 보간 길이 — JS 소유 보간
 *  (layoutRectMotion)의 단일 원천. 위상(드래그·활강) 중에는 기존 시스템이 이동을
 *  소유하므로 보간하지 않는다(isLayoutMotionActive 로 같은 모듈이 판단). */
export const LAYOUT_MOTION_MS = 160;

function syncEmit(): void {
  const active = depth() > 0;
  const kinds = activeKinds();
  const scopeViews = activeScope();
  // 중복 억제 키는 범위까지 본다 — 범위가 바뀌면 그것은 다른 사실이다. 키가 범위를 모르면
  // 스코프 위상이 연달아 시작될 때 두 번째 통지가 삼켜지고, 실제로 움직이는 표면이 자기
  // 위상을 통보받지 못한다(실사고).
  const key = `${active}:${kinds.join(",")}:${scopeViews ? [...scopeViews].sort().join("+") : "*"}`;
  if (key === emitted.lastEmittedKey) return;
  emitted.lastEmittedKey = key;

  // 플러그인 채널은 사실만 싣는다(active·kinds). 어느 표면이 이 위상의 대상인지는 브로드캐스트
  // 로 추측할 일이 아니다 — 코어가 동결한 슬롯에 view.veiled 로 정확히 통지한다(§4.6).
  emitPluginEvent("layout.resize-gesture", { active, kinds });
  void invoke("webview_resize_gesture", { active }).catch(() => {
    // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됨.
  });
  // 로컬 리스너: 에지에서 부르되(기존 계약), 활성 중 종별 변화도 전달한다 — 코어 소비자
  // (슬롯 동결)가 kinds·scope 재평가를 해야 하므로 플러그인 채널과 같은 조건으로 부른다.
  for (const l of listeners) l(active, kinds, scopeViews);
}

/** 모션 위상 활성 여부(레퍼카운트 > 0). */
export function isLayoutMotionActive(): boolean {
  return depth() > 0;
}

/** 현재 위상의 사실 — JS 보간(layoutRectMotion)의 스킵 판정용.
 *  kinds 는 활성 종류, scope 는 이 위상이 움직이는 viewId 집합(null=전역). */
export function layoutMotionFacts(): { active: boolean; kinds: LayoutMotionKind[]; scope: Set<string> | null } {
  return { active: depth() > 0, kinds: activeKinds(), scope: activeScope() };
}

/** scope: 이 위상이 움직이는 뷰들의 viewId. 생략(undefined)=전역(모든 슬롯 이동).
 *  sender: 발신자 식별(진단) — 전역 위상이 잘못 열릴 때 어느 begin 인지 즉답한다. */
export function beginLayoutMotion(
  kind: LayoutMotionKind,
  scope?: Iterable<string>,
  sender?: string,
): void {
  counts[kind] += 1;
  scopes.push(scope ? new Set(scope) : null);
  if (import.meta.env?.DEV && !scope && sender) lastSender.lastGlobalSender = sender;
  syncEmit();
}

// 마지막 전역 begin 의 발신자(진단 관측면) — window.__lastGlobalMotionSender 로 노출.
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화가
// 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
/** 관측면 — 마지막 발신자(디버그 창이 읽는다). 발화 억제와 수명도 뜻도 다르다. */
const lastSender = moduleState("lib/layoutMotion#sender", () => ({
  lastGlobalSender: "",
}));
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__lastGlobalMotionSender", {
    get: () => lastSender.lastGlobalSender,
    configurable: true,
  });
}

export function endLayoutMotion(kind: LayoutMotionKind): void {
  if (counts[kind] === 0) return; // 잉여 end 무시 — 음수 카운트 금지
  counts[kind] -= 1;
  scopes.pop();
  syncEmit();
}

export function __resetLayoutMotionForTest(): void {
  counts.move = 0;
  counts.resize = 0;
  scopes.length = 0;
  emitted.lastEmittedKey = null;
  listeners.clear();
}
