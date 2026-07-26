// 모션 관측 설정의 단일 소유자 — 명령(ui.motion)과 개발 UI 가 같은 상태를 쓴다.
//
// 왜 하나여야 하나: 사람이 UI 로 멈춰 두고 "지금 DOM 을 봐 달라" 고 말하는 순간, 명령이 읽는
// 값과 화면이 따르는 값이 다르면 서로 다른 순간을 보게 된다. 이 결함들은 전부 움직이는 도중에만
// 존재하므로(표면이 옛 자리에 좌초해 사이드바가 두 벌, 탭 복귀 시 깜빡임, 패널이 잠깐 좁아짐),
// 멈춘 그 순간이 정확히 같아야 관측이 성립한다.
//
// 적용면은 :root 하나다 — --motion-scale 이 전이/애니메이션 길이를 곱하고, data-motion-hold 가
// 그 자리에 세운다. 기본값(1, hold 없음)은 프로덕션 경로에 아무 영향이 없다.
const listeners = new Set<() => void>();

export interface MotionDebugState {
  scale: number;
  hold: boolean;
}

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function motionDebugState(): MotionDebugState {
  const r = root();
  if (!r) return { scale: 1, hold: false };
  const raw = Number(r.style.getPropertyValue("--motion-scale"));
  return {
    scale: Number.isFinite(raw) && raw > 0 ? raw : 1,
    hold: r.hasAttribute("data-motion-hold"),
  };
}

/** 배수와 정지를 적용한다. 둘 다 선택 — 준 것만 바뀐다. 범위 밖 배수는 무시(호출자가 판정). */
export function setMotionDebug(next: { scale?: number; hold?: boolean }): MotionDebugState {
  const r = root();
  if (!r) return motionDebugState();
  if (typeof next.scale === "number" && next.scale > 0 && next.scale <= 200) {
    r.style.setProperty("--motion-scale", String(next.scale));
  }
  if (typeof next.hold === "boolean") r.toggleAttribute("data-motion-hold", next.hold);
  for (const cb of listeners) cb();
  return motionDebugState();
}

/** 설정 변화 구독 — 개발 UI 가 자기 표시를 맞춘다. */
export function onMotionDebugChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
