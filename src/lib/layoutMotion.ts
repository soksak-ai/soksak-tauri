// 레이아웃 모션 신호(단일 진실) — "네이티브 child 위 표면이 움직이는 중"이라는 사실을
// 두 소비자 계층에 에지로 알린다: ① 플러그인 events(layout.resize-gesture — 브라우저가
// bounds 커밋 유예 + freeze-frame 스탠드인) ② Rust 릴레이(webview_resize_gesture — CEF).
// 디바이더 드래그·레일 주행·FLIP 이 겹칠 수 있으므로 레퍼카운트로 시작/끝 짝을 보장한다.
// 근거(실측): 주행 애니메이션 중 DOM 은 미끄러지는데 child 는 끝에서 점프해 이질감(영상).
import { invoke } from "@tauri-apps/api/core";
import { emitPluginEvent } from "../plugins/hooks";

let depth = 0;

function emit(active: boolean): void {
  emitPluginEvent("layout.resize-gesture", { active });
  void invoke("webview_resize_gesture", { active }).catch(() => {
    // 비-macOS 등 릴레이 미지원은 무해 — 플러그인 채널은 이미 전달됨.
  });
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
}
