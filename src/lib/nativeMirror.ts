// 네이티브 미러(단일 기계) — "DOM 앵커를 네이티브 표면이 따라간다"의 유일한 구현.
// 근거: 디바이더 강조바(NSBox)가 같은 파이프라인(rect 측정 → IPC → setFrame)으로 완벽하게
// 동작함을 실측으로 증명했다. 그 방식을 계약으로 승격해 모든 네이티브 추종(강조바·브라우저
// child·엔진 서피스)이 이 기계 하나를 소비한다. 흩어진 추종 루프 재구현 금지.
//
// 구동 시점 계약(에지 굶주림 근치 — 실측: 위상 에지 rAF 침묵 100~240ms):
//   ① 매 React 커밋(레이아웃 이펙트) 동기 틱 — 기하가 바뀌는 순간은 커밋이고, 커밋 틱은
//      rAF 와 달리 굶지 않는다(같은 태스크에서 실행).
//   ② 모션 위상(layoutMotion) 동안 rAF 루프 — FLIP/드래그의 프레임 보간을 따른다.
//   ③ rect 무변화 프레임은 IPC 0(동일-rect 스킵), 루프는 안정 N프레임 후 자기 종료.
export type MirrorRect = { x: number; y: number; w: number; h: number };

type Entry = {
  measure: () => MirrorRect | null; // null = 지금은 적용하지 않음(숨김/미부착)
  apply: (r: MirrorRect) => void;
  lastKey: string;
};

const mirrors = new Map<string, Entry>();

const keyOf = (r: MirrorRect) => `${r.x},${r.y},${r.w},${r.h}`;

/** 정수 스냅 — 네이티브 반올림과 홀 경계가 어긋나지 않게(ceil 원점/floor 끝). */
export function snapRect(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): MirrorRect {
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return {
    x,
    y,
    w: Math.max(1, Math.floor(r.right) - x),
    h: Math.max(1, Math.floor(r.bottom) - y),
  };
}

/** 미러 등록 — 반환 함수로 해지. 같은 key 재등록은 교체다. */
export function registerMirror(
  key: string,
  measure: () => MirrorRect | null,
  apply: (r: MirrorRect) => void,
): () => void {
  mirrors.set(key, { measure, apply, lastKey: "" });
  tickOne(key);
  return () => {
    mirrors.delete(key);
  };
}

function tickOne(key: string): void {
  const e = mirrors.get(key);
  if (!e) return;
  const r = e.measure();
  if (!r) return;
  const k = keyOf(r);
  if (k === e.lastKey) return;
  e.lastKey = k;
  e.apply(r);
}

/** 모든 미러 1틱 — 매 커밋 레이아웃 이펙트와 rAF 루프가 호출한다. 변화 없으면 IPC 0. */
export function tickMirrors(): boolean {
  let changed = false;
  for (const [key, e] of mirrors) {
    const r = e.measure();
    if (!r) continue;
    const k = keyOf(r);
    if (k === e.lastKey) continue;
    e.lastKey = k;
    e.apply(r);
    changed = true;
    void key;
  }
  return changed;
}

// rAF 추종 루프 — 모션 위상 동안 + 변화가 이어지는 동안. 안정 STABLE_STOP 프레임이면
// 자기 종료(무한 감시 금지). 위상 begin/커밋이 다시 arm 한다.
const STABLE_STOP = 4;
let rafId = 0;
let stableFrames = 0;
let phaseActive = false;

export function setMirrorPhase(active: boolean): void {
  phaseActive = active;
  if (active) armMirrors();
  else tickMirrors(); // 종료 에지 정확 스냅(드래그바의 gesture-end 스냅과 동형)
}

export function armMirrors(): void {
  stableFrames = 0;
  if (rafId) return;
  const tick = () => {
    const changed = tickMirrors();
    stableFrames = changed ? 0 : stableFrames + 1;
    if (phaseActive || stableFrames < STABLE_STOP) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  };
  rafId = requestAnimationFrame(tick);
}

export function __resetMirrorsForTest(): void {
  mirrors.clear();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  stableFrames = 0;
  phaseActive = false;
}
