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
import { invoke } from "../framework";

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
/** 최근 태어난 전이들의 정체 — "births 43" 이 무엇이었는지 사실로 남긴다(관찰면).
 *  잡은 순간의 rate 까지 기록해 "붙잡았는데 감속이 안 걸렸다"를 구분할 수 있게 한다. */
export interface BirthRecord {
  at: string; // 전이가 태어난 요소(간이 식별 — 태그.클래스)
  what: string; // transitionProperty | animationName
  declaredMs: number;
  rate: number; // applyMotionTo 직후의 playbackRate — 감속 적용의 직접 증거
  t: number; // performance.now() — 어느 커밋의 탄생인지 시각으로 가른다(#22 실패 2형 판별)
  held: boolean; // 탄생 시점의 hold 판독값 — 정지 중 탄생(동결 분기 미탑승)의 직접 증거
}
const RECENT_BIRTHS_CAP = 64;
const recentBirths: BirthRecord[] = [];
export function motionRecentBirths(): BirthRecord[] {
  return [...recentBirths];
}
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

// ── 모션 여정 원장(journeys) — "어디서 어디로, 끝까지 갔는가"를 시스템이 스스로 기록한다.
// 사용자 요구(2026-07-27): 이벤트로 모션이 시작되면 from→to 와 완전 종료까지 추적 가능해야
// 한다. 외부 샘플링(ui.trace)은 창 밖 관측이고, 이 원장은 보간 자신의 자기보고다 —
// 겹침(두 여정의 경로 교차)·잔상(finish 후 실측이 to 와 다름)을 사건으로 판독한다.
export interface MotionJourney {
  at: string; // 노드(data-node)
  from: { x: number; y: number; w: number; h: number };
  to: { x: number; y: number; w: number; h: number };
  startedAt: number; // performance.now()
  endedAt: number | null; // null = 진행 중
  end: "finish" | "cancel" | null;
  landed: { x: number; y: number; w: number; h: number } | null; // 종료 직후 실측 rect
}
const JOURNEYS_CAP = 64;
const journeys: MotionJourney[] = [];
// 여정을 활동 허브로도 발행 — 캡처(픽셀)보다 로그가 판별력이 높다(사용자 확정 2026-07-27).
// `sok events --kinds motion.journey` 로 시작·종료가 실시간으로 흐른다. 실패는 삼킨다(관측이
// 본체를 못 막는다 — boot.step 과 같은 계약).
function publishJourney(phase: "start" | "end", j: MotionJourney): void {
  void invoke("activity_publish", {
        kind: "motion.journey",
        source: "motion",
        payload: {
          phase,
          at: j.at,
          from: j.from,
          to: j.to,
          end: j.end,
          landed: j.landed,
          ms: j.endedAt !== null ? Math.round(j.endedAt - j.startedAt) : null,
          message: `· motion ${phase} ${j.at}`,
          origin: "internal",
        },
      }).catch(() => {});
}
export function motionJourneys(): MotionJourney[] {
  return [...journeys];
}
export function beginJourney(
  at: string,
  from: MotionJourney["from"],
  to: MotionJourney["to"],
): MotionJourney {
  const j: MotionJourney = {
    at,
    from,
    to,
    startedAt: typeof performance === "undefined" ? 0 : performance.now(),
    endedAt: null,
    end: null,
    landed: null,
  };
  journeys.push(j);
  if (journeys.length > JOURNEYS_CAP) journeys.shift();
  publishJourney("start", j);
  return j;
}
export function endJourney(
  j: MotionJourney,
  end: "finish" | "cancel",
  landed: MotionJourney["landed"],
): void {
  j.endedAt = typeof performance === "undefined" ? 0 : performance.now();
  j.end = end;
  j.landed = landed;
  publishJourney("end", j);
}

// ── 스왑 원장(swaps) — 교체(파킹↔등장)의 실행 사실을 DOM 변이에서 직접 기록한다.
// 여정 원장은 FLIP 보간의 자기보고다 — 파킹 전환은 보간하지 않으므로(좌표 계약) 그 축을 볼
// 눈이 없다. 사용자 실측 "a↔b 가 두 번 교체된다"(2026-07-27)를 잡으려면 어떤 코드 경로가
// 스타일을 썼든 화면의 사실을 봐야 한다 — MutationObserver 는 쓴 주체와 무관하게 파킹이
// 걸리는 세 층(project plane·space plane·tab 슬롯)의 인라인 스타일 전환을 전부 본다.
// 정상 교체는 탭 층 전환 정확히 2건(나가는 탭 visible→parked, 들어오는 탭 parked→visible)이다.
export interface SwapRecord {
  at: string; // layout/tab/<id> · project/<id> · space-plane
  kind: "park" | "restyle"; // park = 파킹 축 전환, restyle = 파킹 불변인데 다른 선언이 바뀜
  from: string; // park: visible|parked, restyle: 바뀐 선언 이름들(요약)
  to: string;
  t: number; // performance.now()
}
const SWAPS_CAP = 128;
const swaps: SwapRecord[] = [];
export function motionSwaps(): SwapRecord[] {
  return [...swaps];
}
function publishSwap(s: SwapRecord): void {
  void invoke("activity_publish", {
    kind: "motion.swap",
    source: "motion",
    payload: {
      at: s.at,
      kind: s.kind,
      from: s.from,
      to: s.to,
      t: Math.round(s.t * 10) / 10,
      message: `· swap ${s.at} [${s.kind}] ${s.from}→${s.to}`,
      origin: "internal",
    },
  }).catch(() => {});
}
// 파킹 판정은 인라인 스타일 직독이다(parkedStyle 이 인라인으로 쓴다) — computed 는 반영
// 시차로 거짓을 말한다(실측: 파킹 좌표를 읽는 순간에도 visible — #15 의 가시성 프록시 오판).
const parkedInText = (style: string | null): boolean =>
  !!style && (/visibility:\s*hidden/.test(style) || /display:\s*none/.test(style));
const swapName = (el: HTMLElement): string | null => {
  const node = el.dataset.node;
  if (node && node.startsWith("layout/tab/")) return node;
  if (el.dataset.projectPlane) return `project/${el.dataset.projectPlane}`;
  if (el.classList.contains("space-plane")) return "space-plane";
  return null;
};
let swapObserver: MutationObserver | null = null;
/** 스왑 감시 설치 — App 마운트에서 1회(멱등). 관측은 본체를 못 막는다(발행 실패는 삼킨다). */
export function installSwapObserver(): void {
  if (swapObserver || typeof MutationObserver === "undefined" || typeof document === "undefined")
    return;
  // 선언 텍스트를 이름→값으로 — restyle 사건의 "무엇이 바뀌었나"를 이름으로 요약한다.
  const declsOf = (text: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const part of text.split(";")) {
      const i = part.indexOf(":");
      if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return m;
  };
  const record = (rec: SwapRecord) => {
    swaps.push(rec);
    if (swaps.length > SWAPS_CAP) swaps.shift();
    publishSwap(rec);
  };
  swapObserver = new MutationObserver((muts) => {
    // 배치 재구성 — 변이 i 의 결과값은 변이 i+1 의 oldValue 다. 현재 el.style 은 배치의
    // 최종값이라, 그걸 매 변이의 결과로 읽으면 중간 왕복이 전부 최종 상태로 뭉개진다
    // (첫 판의 오판: 한 배치 4변이가 전부 parked→visible 로 보였다).
    const byEl = new Map<HTMLElement, MutationRecord[]>();
    const t0 = typeof performance === "undefined" ? 0 : performance.now();
    for (const m of muts) {
      const el = m.target;
      if (!(el instanceof HTMLElement)) continue;
      const name = swapName(el);
      if (!name) continue;
      // class 축 — .flip-move 류 클래스 부착이 CSS 키프레임(rail-flip-x)을 발화시킨다.
      // 스타일 축만 보면 "두 번 미끄러짐"의 원인(클래스 재부착 = 애니메이션 재발화)에 눈이 없다.
      if (m.attributeName === "class") {
        const oldCls = new Set((m.oldValue ?? "").split(/\s+/).filter(Boolean));
        const newCls = new Set(el.className.split(/\s+/).filter(Boolean));
        const delta: string[] = [];
        for (const c of newCls) if (!oldCls.has(c)) delta.push(`+${c}`);
        for (const c of oldCls) if (!newCls.has(c)) delta.push(`-${c}`);
        if (delta.length > 0)
          record({ at: name, kind: "restyle", from: "class", to: delta.join(" "), t: t0 });
        continue;
      }
      const list = byEl.get(el);
      if (list) list.push(m);
      else byEl.set(el, [m]);
    }
    const t = typeof performance === "undefined" ? 0 : performance.now();
    for (const [el, list] of byEl) {
      const at = swapName(el);
      if (!at) continue;
      const finalText = el.getAttribute("style") ?? "";
      for (let i = 0; i < list.length; i++) {
        const oldText = list[i].oldValue ?? "";
        const newText = i + 1 < list.length ? (list[i + 1].oldValue ?? "") : finalText;
        if (oldText === newText) continue;
        const was = parkedInText(oldText);
        const now = parkedInText(newText);
        if (was !== now) {
          record({ at, kind: "park", from: was ? "parked" : "visible", to: now ? "parked" : "visible", t });
          continue;
        }
        // 파킹 축 불변 — 어떤 선언이 바뀌었는지(움직임의 실체는 transform·크기 재작성이다).
        const a = declsOf(oldText);
        const b = declsOf(newText);
        // 제거 마커로 접두사를 깎으면 CSS 변수(--x)의 이름이 상한다 — 키 집합으로 정직하게.
        const keys = new Set<string>([...a.keys(), ...b.keys()]);
        const changed = [...keys].filter((k) => a.get(k) !== b.get(k));
        if (changed.length === 0) continue;
        record({
          at,
          kind: "restyle",
          from: changed.map((k) => `${k}:${a.get(k) ?? "∅"}`).join(" "),
          to: changed.map((k) => `${k}:${b.get(k) ?? "∅"}`).join(" "),
          t,
        });
      }
    }
  });
  swapObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
    attributeOldValue: true,
  });
}

// ── 발화 원장(triggers) — "이벤트가 실제로 몇 번 발화했나"를 원인 축에서 기록한다.
// 사용자 가설(2026-07-27): 교체가 두 번 보이는 건 활성화가 두 번 발화하기 때문일 수 있다
// (down/up 이중발화 류). 판정 지점은 상태 변이의 단일 소유자(sessions.setActiveView/
// setActiveGroup)다 — 어느 UI 경로가 부르든 전부 여기로 모이므로, 호출마다 호출 스택 서명을
// 남기면 한 제스처가 몇 번·어떤 경로로 활성화를 쐈는지 그대로 드러난다. 입력 층(pointerdown/
// up/click)도 문서 캡처로 함께 기록해 제스처→발화→교체의 인과 사슬을 한 시간축에 놓는다.
export interface TriggerRecord {
  what: string; // setActiveView | setActiveGroup | pointerdown | pointerup | click
  target: string; // 뷰/칸 id 또는 입력 대상의 data-node
  via: string; // 호출 스택 서명(상태 발화) 또는 입력 좌표
  t: number; // performance.now()
}
const TRIGGERS_CAP = 128;
const triggers: TriggerRecord[] = [];
export function motionTriggers(): TriggerRecord[] {
  return [...triggers];
}
function recordTrigger(rec: TriggerRecord): void {
  triggers.push(rec);
  if (triggers.length > TRIGGERS_CAP) triggers.shift();
  void invoke("activity_publish", {
    kind: "motion.trigger",
    source: "motion",
    payload: {
      what: rec.what,
      target: rec.target,
      via: rec.via,
      t: Math.round(rec.t * 10) / 10,
      message: `· trigger ${rec.what} ${rec.target}`,
      origin: "internal",
    },
  }).catch(() => {});
}
/** 상태 발화 기록 — 상태 액션(단일 소유 지점)이 부른다. 스택 서명으로 경로를 남긴다. */
export function noteActivation(what: string, target: string): void {
  const stack = (new Error().stack ?? "")
    .split("\n")
    .slice(2, 7)
    .map((l) => l.trim().replace(/^at /, "").split(/[ @]/)[0])
    .filter((f) => f && !f.startsWith("http"))
    .join("<");
  recordTrigger({
    what,
    target,
    via: stack,
    t: typeof performance === "undefined" ? 0 : performance.now(),
  });
}
let inputObserved = false;
/** 입력 층 기록 — 탭/칸 표면에 닿은 pointerdown/up/click 만(캡처 단계, 본체 무간섭). */
export function installInputObserver(): void {
  if (inputObserved || typeof document === "undefined") return;
  inputObserved = true;
  for (const type of ["pointerdown", "pointerup", "click"] as const) {
    document.addEventListener(
      type,
      (e) => {
        const el = e.target instanceof Element ? e.target.closest("[data-node],[data-tab-id],[data-pane]") : null;
        if (!(el instanceof HTMLElement)) return;
        const target =
          el.dataset.node ?? (el.dataset.tabId ? `tab:${el.dataset.tabId}` : `pane:${el.dataset.pane}`);
        recordTrigger({
          what: type,
          target,
          via: `${Math.round((e as MouseEvent).clientX)},${Math.round((e as MouseEvent).clientY)}`,
          t: typeof performance === "undefined" ? 0 : performance.now(),
        });
      },
      { capture: true, passive: true },
    );
  }
}

/** 위상 스킵 사실 — 원장에 남겨 "감속이 안 걸렸다"의 원인을 실측 가능하게 한다(#15 규명). */
export function noteRectMotionSkip(at: string, why: string): void {
  recentBirths.push({
    at,
    what: `layout-rect-skipped(${why})`,
    declaredMs: 0,
    rate: 1,
    t: typeof performance === "undefined" ? 0 : performance.now(),
    held: hold,
  });
  if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
}

/** JS 소유 레이아웃 보간(코어가 element.animate 로 판 것)의 등록 지점 — WAAPI 애니메이션은
 *  animationstart 를 쏘지 않아 onStart 배선에 안 잡힌다(실측: births 0). 만든 쪽이 직접
 *  입양시켜야 같은 컨트롤러(배수·정지·원장)를 예외 없이 따른다. */
export function adoptLayoutAnimation(a: Animation, at: string, declaredMs: number): void {
  births++;
  recentBirths.push({
    at,
    what: "layout-rect",
    declaredMs,
    rate: motionPlaybackRate(),
    t: typeof performance === "undefined" ? 0 : performance.now(),
    held: hold,
  });
  if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
  applyMotionTo(a as unknown as Retimable);
  // 정지 중의 탄생은 0 에서 얼린다 — pause() 는 pending 커밋이라 브라우저가 첫 프레임에서
  // play 를 먼저 커밋하면 한 프레임이 샌다(실측: 정지 중 rect 가 정확히 1프레임 전진 후
  // 동결, 3회 중 1회). 탄생은 정의상 진행 전이므로 currentTime=0 고정이 정당하다 —
  // 이미 달리던 애니메이션의 동결 위치(applyMotionTo)는 건드리지 않는다.
  if (motionDebugState().hold) {
    try {
      a.currentTime = 0;
    } catch {
      /* 이미 끝났거나 분리됨 — 무해 */
    }
    // pending pause 중의 currentTime 세팅은 WebKit 이 무시할 수 있다(실측: 위 고정에도
    // 1프레임(≈17ms, ease 20%)에서 동결). ready(커밋 완료) 시점에 0 을 재고정한다 —
    // 커밋 순서와 무관하게 최종적으로 0 이 이긴다. 그 사이 hold 가 풀렸으면 손대지 않는다.
    void (a as { ready?: Promise<unknown> }).ready
      ?.then(() => {
        if (motionDebugState().hold) {
          try {
            a.currentTime = 0;
          } catch {
            /* 무해 */
          }
        }
      })
      .catch(() => {});
  }
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
      const el = t as HTMLElement;
      const eff = (a as Animation).effect as KeyframeEffect | null;
      const timing = eff?.getTiming?.();
      recentBirths.push({
        at: `${el.tagName?.toLowerCase() ?? "?"}${el.className ? "." + String(el.className).split(" ").slice(0, 2).join(".") : ""}`,
        what:
          (a as unknown as { transitionProperty?: string }).transitionProperty ??
          (a as unknown as { animationName?: string }).animationName ??
          (a as Animation).id ??
          "?",
        declaredMs: typeof timing?.duration === "number" ? timing.duration : -1,
        rate: (a as Animation).playbackRate ?? 1,
        t: typeof performance === "undefined" ? 0 : performance.now(),
        held: hold,
      });
      if (recentBirths.length > RECENT_BIRTHS_CAP) recentBirths.shift();
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
