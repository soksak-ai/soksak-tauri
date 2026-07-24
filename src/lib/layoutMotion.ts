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
import { invoke } from "@tauri-apps/api/core";
import { emitPluginEvent } from "../plugins/hooks";

export type LayoutMotionKind = "move" | "resize";

const counts: Record<LayoutMotionKind, number> = { move: 0, resize: 0 };
let lastEmittedKey: string | null = null; // 마지막 발화 상태(active+kinds) — 중복 발화 억제
type MotionListener = (active: boolean) => void;
const listeners = new Set<MotionListener>();

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
function syncEmit(): void {
  const active = depth() > 0;
  const kinds = activeKinds();
  const key = `${active}:${kinds.join(",")}`;
  if (key === lastEmittedKey) return;
  const wasActive = lastEmittedKey?.startsWith("true") ?? false;
  lastEmittedKey = key;
  emitPluginEvent("layout.resize-gesture", { active, kinds });
  void invoke("webview_resize_gesture", { active }).catch(() => {
    // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됨.
  });
  if (active !== wasActive) for (const l of listeners) l(active);
}

/** 모션 위상 활성 여부(레퍼카운트 > 0). */
export function isLayoutMotionActive(): boolean {
  return depth() > 0;
}

export function beginLayoutMotion(kind: LayoutMotionKind): void {
  counts[kind] += 1;
  syncEmit();
}

export function endLayoutMotion(kind: LayoutMotionKind): void {
  if (counts[kind] === 0) return; // 잉여 end 무시 — 음수 카운트 금지
  counts[kind] -= 1;
  syncEmit();
}

export function __resetLayoutMotionForTest(): void {
  counts.move = 0;
  counts.resize = 0;
  lastEmittedKey = null;
  listeners.clear();
}
