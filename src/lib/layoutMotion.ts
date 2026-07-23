// 레이아웃 모션 신호(단일 진실) — "네이티브 child 위 표면이 움직이는 중"이라는 사실을
// 세 소비자 계층에 에지로 알린다: ① 플러그인 events(layout.resize-gesture — 브라우저가
// 매 프레임 native bounds 추종 루프를 살린다) ② Rust 릴레이(webview_resize_gesture — CEF)
// ③ 코어 로컬 리스너(onLayoutMotion — 레일-홀 클립 등 DOM 측 동조자).
// 디바이더 드래그·레일 주행·FLIP 이 겹칠 수 있으므로 레퍼카운트로 시작/끝 짝을 보장한다.
// 근거(실측): 주행 애니메이션 중 DOM 은 미끄러지는데 child 는 끝에서 점프해 이질감(영상).
import { invoke } from "@tauri-apps/api/core";
import { emitPluginEvent } from "../plugins/hooks";

let depth = 0;
type MotionListener = (active: boolean) => void;
const listeners = new Set<MotionListener>();

/** 모션 에지(시작/끝) 구독. 반환 함수로 해지한다. */
export function onLayoutMotion(listener: MotionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(active: boolean): void {
  emitPluginEvent("layout.resize-gesture", { active });
  void invoke("webview_resize_gesture", { active }).catch(() => {
    // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됨.
  });
  for (const l of listeners) l(active);
}

export function beginLayoutMotion(): void {
  depth += 1;
  if (depth === 1) emit(true);
}

export function endLayoutMotion(): void {
  if (depth === 0) return; // 잉여 end 무시 — 음수 카운트 금지
  depth -= 1;
  if (depth === 0) emit(false);
}

export function __resetLayoutMotionForTest(): void {
  depth = 0;
  listeners.clear();
}
