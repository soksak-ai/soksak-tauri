// 모션 관측 설정의 단일 소유자 — 명령(ui.motion)과 개발 UI 가 같은 상태를 쓴다.
//
// 왜 하나여야 하나: 사람이 UI 로 멈춰 두고 "지금 DOM 을 봐 달라" 고 말하는 순간, 명령이 읽는
// 값과 화면이 따르는 값이 다르면 서로 다른 순간을 보게 된다. 이 결함들은 전부 움직이는 도중에만
// 존재하므로(표면이 옛 자리에 좌초해 사이드바가 두 벌, 탭 복귀 시 깜빡임, 패널이 잠깐 좁아짐),
// 멈춘 그 순간이 정확히 같아야 관측이 성립한다.
//
// 어떻게 실제로 느려지나: CSS 변수로는 이미 선언된 duration 을 곱할 수 없다 — 커스텀 프로퍼티를
// 하나 두는 것만으로는 아무 전이도 늘어나지 않는다(실측: 변수만 세우고 소비처가 없어 정지만
// 듣고 배수는 무효였다). 속도를 실제로 바꾸는 축은 Web Animations 의 playbackRate 다. 그것은
// CSS 전이와 키프레임 애니메이션 양쪽을 덮고, 선언을 한 줄도 고치지 않는다.
//
// 이미 도는 것과 앞으로 시작할 것 둘 다 잡아야 한다 — transitionrun/animationstart 가 새로 태어난
// 애니메이션의 유일한 신호다. 기본값(1배속, 정지 없음)에서는 리스너가 아무것도 만지지 않는다.
const listeners = new Set<() => void>();

export interface MotionDebugState {
  /** 지속 배수 — 1 = 보통, 20 = 스무 배 느리게. 화면에는 속도(1/20)로 적는다. */
  scale: number;
  hold: boolean;
  /** 마지막 적용에서 실제로 시간이 다시 매겨진 애니메이션 수(효과의 증거). */
  applied?: number;
}

let scale = 1;
let hold = false;
let wired = false;
/** 이 모듈이 판 예약들. 브라우저 목록에 잡히기를 기대하지 않고 직접 들고 있는다 —
 *  기대가 어긋나면 정지가 예약에 안 걸리고, 얼어붙은 순간을 착지가 지운다. */
const scheduled = new Set<Retimable>();
/** 진단: 갓 태어난 애니메이션을 몇 번 붙잡았는지. */
let births = 0;
/** 위상 예약이 세기 시작한 시각과, 화면이 실제로 움직이기 시작한 시각의 차(ms).
 *  이 시차만큼 활강이 앞에서 잘린다 — 예약은 이미 세는데 화면은 아직 안 움직인다. */
let armedAt: number | null = null; // null = 재는 중이 아님(0 은 유효한 시각이다)
let lagMs = 0;

/**
 * 화면이 실제로 움직이기 시작한 순간 — 위상 시계의 진짜 0 이다.
 *
 * 예약은 React 이펙트에서 세기 시작하지만 화면은 다음 스타일 반영·페인트 뒤에 움직인다.
 * 그 사이(실측 평시 5~44ms, 최대 13%)만큼 위상이 앞서 있으면 활강 끝머리가 잘린 채 착지가
 * 선언된다. 여기서 그 시차만큼 예약을 뒤로 물려 둘의 0 을 맞춘다.
 */
function noteVisualStart(): void {
  if (armedAt === null) return;
  lagMs = Math.round(nowMs() - armedAt);
  armedAt = null; // 이 여정의 첫 움직임만 센다
  if (lagMs > 0) deferBy(lagMs);
}

/** 달리고 있는 위상 예약을 ms 만큼 뒤로 물린다. 예약은 이 모듈이 소유하므로 되감기가 남는다
 *  (스타일 엔진이 소유하는 CSS 애니메이션은 되감아도 제자리로 돌아온다 — 실측). */
function deferBy(ms: number): void {
  for (const a of scheduled) {
    const t = a.currentTime;
    if (typeof t === "number") {
      try {
        a.currentTime = Math.max(0, t - ms);
      } catch {
        /* 되감기를 거부하는 구현 */
      }
    }
  }
  for (const w of [...waiting]) {
    clearTimeout(w.timer);
    const left = Math.max(0, w.wallMs - (nowMs() - w.startedAt)) + ms;
    w.startedAt = nowMs();
    w.wallMs = left;
    w.timer = setTimeout(() => {
      waiting.delete(w);
      w.cb();
    }, left) as unknown as number;
  }
}

function root(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** playbackRate·정지를 실제로 쥐는 최소 표면 — 테스트가 이 규칙을 직접 단언한다. */
export interface Retimable {
  playbackRate: number;
  readonly playState: string;
  currentTime?: number | null;
  pause(): void;
  play(): void;
}

/** 이 애니메이션 하나에 현재 설정을 적용한다. 멱등 — 같은 값이면 브라우저가 무시한다. */
export function applyMotionTo(a: Retimable): void {
  try {
    a.playbackRate = motionPlaybackRate();
    if (hold) a.pause();
    else if (a.playState === "paused") a.play();
  } catch {
    /* 이미 끝났거나 분리된 애니메이션 — 무해 */
  }
}

/** 지금 살아 있는 애니메이션 전부에 적용하고, 몇 개에 걸렸는지 답한다.
 *  개수가 곧 효과의 증거다 — 설정이 세워졌다는 말은 느려졌다는 말을 대신하지 못한다. */
function applyAll(): number {
  const d = typeof document === "undefined" ? null : document;
  const live = new Set<Retimable>(scheduled);
  if (d?.getAnimations) for (const a of d.getAnimations()) live.add(a as unknown as Retimable);
  for (const a of live) applyMotionTo(a);
  return live.size;
}

/** 새로 시작하는 전이/애니메이션도 같은 설정으로 태어나게 한다. 1회 배선. */
function ensureWired(): void {
  if (wired || typeof document === "undefined") return;
  wired = true;
  const onStart = (e: Event) => {
    noteVisualStart(); // 평시에도 재는 유일한 것 — 위상 시계와 화면의 시차
    if (scale === 1 && !hold) return; // 기본값 — 그 밖에는 아무것도 만지지 않는다
    const t = e.target;
    if (!(t instanceof Element) || !t.getAnimations) return;
    for (const a of t.getAnimations()) {
      births++;
      applyMotionTo(a as unknown as Retimable);
    }
  };
  document.addEventListener("transitionrun", onStart, true);
  document.addEventListener("animationstart", onStart, true);
}

/** 지금 살아 있는 애니메이션의 수와 실제 재생 속도 — 효과의 직접 증거.
 *  설정값(scale)은 의도이고 이것은 결과다. 둘을 같이 봐야 "느려졌다"가 확인된다. */
export function motionLiveRates(): {
  running: number;
  births: number;
  lagMs: number;
  rates: number[];
  wallMs: number[];
} {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.getAnimations) return { running: 0, births, lagMs, rates: [], wallMs: [] };
  const rates = new Set<number>();
  const wall = new Set<number>();
  let running = 0;
  for (const a of d.getAnimations()) {
    running++;
    const rate = a.playbackRate ?? 1;
    rates.add(Number(rate.toFixed(4)));
    wall.add(effectiveWallMs(a as unknown as Timed, rate));
  }
  return {
    running,
    births,
    lagMs,
    rates: [...rates].sort((x, y) => x - y),
    wallMs: [...wall].filter((n) => n > 0).sort((x, y) => x - y),
  };
}

/** 지금 도는 것 하나 — 이름·자리·길이·진행률. 수만으로는 무엇이 어긋났는지 못 읽는다. */
export interface LiveAnimation {
  /** 가장 가까운 노출 노드 주소 + 자기 클래스. "어디가 움직이나"의 답. */
  at: string;
  /** 키프레임 이름 또는 전이 프로퍼티. "무엇이 움직이나"의 답. */
  what: string;
  /** 선언된 길이. 배수를 여기에 곱하면 안 된다 — 늘리는 축은 playbackRate 하나다. */
  declaredMs: number;
  /** 화면이 실제로 쓰는 시간(선언/재생속도). 위상 타이머와 이 수가 맞아야 안 튄다. */
  wallMs: number;
  /** 0..1 — 멈춰 세운 순간이 여정의 어디인지. */
  progress: number;
  state: string;
}

/** 도는 것들의 목록. 멈춰 둔 채 이걸 읽으면 그 찰나가 좌표로 남는다. */
export function motionLiveList(limit = 24): LiveAnimation[] {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.getAnimations) return [];
  const out: LiveAnimation[] = [];
  for (const a of d.getAnimations()) {
    if (out.length >= limit) break;
    const rate = a.playbackRate ?? 1;
    const eff = a.effect as (KeyframeEffect & { target?: Element | null }) | null;
    const timing = eff?.getComputedTiming?.();
    const dur = typeof timing?.duration === "number" ? timing.duration : 0;
    const anim = a as unknown as { animationName?: string; transitionProperty?: string };
    out.push({
      at: describeTarget(eff?.target ?? null),
      what: a.id || anim.animationName || anim.transitionProperty || "?",
      declaredMs: Math.round(dur),
      wallMs: effectiveWallMs(a as unknown as Timed, rate),
      progress: Number((timing?.progress ?? 0).toFixed(3)),
      state: a.playState,
    });
  }
  return out;
}

/** 애니메이션이 붙은 자리를 사람이 읽는 주소로 — 가장 가까운 노출 노드 + 자기 클래스. */
function describeTarget(el: Element | null): string {
  if (!el) return "?";
  const own = el.classList.length ? `.${[...el.classList].join(".")}` : el.tagName.toLowerCase();
  const host = el.closest("[data-node]");
  const addr = host?.getAttribute("data-node");
  return addr ? `${addr} ${own}` : own;
}

interface Timed {
  effect?: { getComputedTiming?: () => { duration?: number | string } } | null;
}

/** 선언된 길이를 재생 속도로 나눈 실제 소요 — 위상 타이머와 이 수가 맞아야 안 튄다.
 *  선언을 배수로 곱하면서 playbackRate 로 또 나누면 이 수가 제곱으로 벌어진다(실사고). */
function effectiveWallMs(a: Timed, rate: number): number {
  const dur = a.effect?.getComputedTiming?.().duration;
  if (typeof dur !== "number" || !Number.isFinite(dur) || rate <= 0) return 0;
  return Math.round(dur / rate);
}

/** 현재 지속 배수 — 자기 시계를 직접 도는 소비자(위상 타이머)가 곱한다. */
export function motionScale(): number {
  return scale;
}

/** 선언된 길이에 걸리는 재생 속도. 늘리는 축은 이것 하나다 — CSS 선언은 맨 길이로 둔다.
 *  선언까지 곱하면 화면만 배수의 제곱으로 늦고 자기 시계를 도는 타이머는 한 번만 곱해,
 *  이동 도중에 위상이 닫히며 튄다. 짝은 railMotion 의 테스트가 이 함수로 검사한다. */
export function motionPlaybackRate(): number {
  return 1 / scale;
}

export function motionDebugState(): MotionDebugState {
  return { scale, hold };
}

/** 배수와 정지를 적용한다. 둘 다 선택 — 준 것만 바뀐다. 범위 밖 배수는 호출자가 거른다. */
export function setMotionDebug(next: { scale?: number; hold?: boolean }): MotionDebugState {
  ensureWired();
  if (typeof next.scale === "number" && next.scale > 0 && next.scale <= 200) scale = next.scale;
  if (typeof next.hold === "boolean") hold = next.hold;
  const r = root();
  if (r) {
    // 상태면 — ui.snapshot.dom·스크린샷으로 "지금 어떤 설정인가"가 화면에서 읽힌다.
    r.style.setProperty("--motion-scale", String(scale));
    r.toggleAttribute("data-motion-hold", hold);
  }
  adoptWaiting();
  const applied = applyAll();
  for (const cb of listeners) cb();
  return { ...motionDebugState(), applied };
}

/**
 * 위상을 닫는 시계도 여기서 판다 — setTimeout 은 이 컨트롤러를 따르지 않는다.
 *
 * RED 근거(사용자 실측, 2026-07-26): 정지를 눌러도 멈추지 않았다. playbackRate·pause 는 문서
 * 타임라인 위의 애니메이션만 잡는데, 위상 착지는 setTimeout 이 세고 있었다. 화면은 얼었는데
 * 타이머는 계속 세다가 착지를 선언해 얼어붙은 그 순간을 지웠다. 배수도 같은 병이었다 —
 * 한쪽만 늘어나 이동 도중에 위상이 닫혔다.
 *
 * 그래서 시계를 하나로 둔다: 이 예약도 문서 타임라인 위의 애니메이션이다. 그러면 배수도 정지도
 * 예외 없이 같이 걸리고, 호출자는 배수를 곱하지 않는다(곱하면 이중이 된다).
 */
export function scheduleMotion(ms: number, cb: () => void): () => void {
  // 화면의 첫 움직임을 들어야 시계의 0 을 맞출 수 있다 — 관측 설정과 무관하게 배선한다.
  ensureWired();
  const slot: Slot = { stop: () => {} };
  arm(slot, ms, cb);
  return () => slot.stop();
}

/** 관측 중인가 — 기본값이면 아무것도 관측하지 않는다. */
function observing(): boolean {
  return scale !== 1 || hold;
}

interface Slot {
  stop: () => void;
}

/** 타임라인에 얹지 못한 예약들. 관측이 켜지는 순간 남은 만큼을 타임라인으로 옮겨 붙인다. */
interface Waiting {
  slot: Slot;
  cb: () => void;
  total: number;
  wallMs: number;
  startedAt: number;
  timer: number;
}

const waiting = new Set<Waiting>();

function nowMs(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function arm(slot: Slot, ms: number, cb: () => void): void {
  if (observing() && armOnTimeline(slot, ms, cb)) return;
  armOnTimer(slot, ms, ms * scale, cb);
}

/** 문서 타임라인 위의 빈 애니메이션 — 배수·정지가 화면과 똑같이 걸린다. */
function armOnTimeline(slot: Slot, ms: number, cb: () => void): boolean {
  const d = typeof document === "undefined" ? null : document;
  if (!d?.timeline || !d.documentElement) return false;
  if (typeof Animation !== "function" || typeof KeyframeEffect !== "function") return false;
  const a = new Animation(new KeyframeEffect(d.documentElement, [], { duration: ms }), d.timeline);
  a.id = "phase"; // ui.motion 목록에 이 예약이 이름으로 뜬다
  armedAt = nowMs();
  const held = a as unknown as Retimable;
  a.onfinish = () => {
    scheduled.delete(held);
    cb();
  };
  a.play();
  scheduled.add(held);
  applyMotionTo(held);
  slot.stop = () => {
    a.onfinish = null;
    scheduled.delete(held);
    try {
      a.cancel();
    } catch {
      /* 이미 끝났다 */
    }
  };
  return true;
}

/** 평시 경로 — 예전 그대로의 타이머다.
 *
 *  왜 평시엔 타임라인을 안 쓰나: 창이 가려지면 브라우저가 애니메이션을 세운다. 착지까지 거기
 *  얹으면 가려진 창의 위상이 영영 안 닫혀 배치가 여정 상태로 좌초한다. 관측 도구가 프로덕션
 *  동작을 바꾸면 그건 도구가 아니라 결함이다 — 기본값에서는 한 줄도 달라지지 않는다. */
function armOnTimer(slot: Slot, total: number, wallMs: number, cb: () => void): void {
  armedAt = nowMs();
  const w: Waiting = {
    slot,
    cb,
    total,
    wallMs,
    startedAt: nowMs(),
    timer: setTimeout(() => {
      waiting.delete(w);
      cb();
    }, wallMs) as unknown as number,
  };
  waiting.add(w);
  slot.stop = () => {
    waiting.delete(w);
    clearTimeout(w.timer);
  };
}

/** 관측이 켜지는 순간, 이미 달리던 타이머 예약을 남은 만큼 타임라인으로 옮긴다.
 *  이 이관이 없으면 이동 도중에 누른 정지가 그 이동에는 안 걸린다 — 사람이 멈추는 시점은
 *  언제나 이동 도중이므로, 그 경우가 곧 전부다. */
function adoptWaiting(): void {
  if (!observing() || waiting.size === 0) return;
  for (const w of [...waiting]) {
    clearTimeout(w.timer);
    waiting.delete(w);
    const left = w.wallMs > 0 ? Math.max(0, w.wallMs - (nowMs() - w.startedAt)) : 0;
    arm(w.slot, w.total * (w.wallMs > 0 ? left / w.wallMs : 0), w.cb);
  }
}

/** 설정 변화 구독 — 개발 UI 가 자기 표시를 맞춘다. */
export function onMotionDebugChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function __resetMotionDebugForTest(): void {
  scale = 1;
  hold = false;
  scheduled.clear();
  for (const w of [...waiting]) clearTimeout(w.timer);
  waiting.clear();
}
