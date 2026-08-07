import { moduleState } from "./moduleState";
import type { LayoutMove, LayoutTransitionMode, PreparedLayoutTransition } from "./layoutTransitionHost";

export type LayoutTransitionJournalEntry = {
  transactionId: string;
  /** 이 거래를 연 자극이 선언한 관측 거래 식별자. 선언한 자극이 없으면 없다. */
  causeTraceId?: string;
  sequence: number;
  phase: "prepared" | "committed" | "cancelled" | "failed";
  mode: LayoutTransitionMode;
  startAtUnixMs?: number;
  durationMs?: number;
  preparedAtUnixMs: number;
  domCommittedAtUnixMs?: number;
  /**
   * 이 거래가 더 이상 대기하는 것이 없어진 시각. 표면 ACK 와 이 거래가 선언한 출발 epoch
   * 둘 다 지나야 찍힌다 — 예약한 움직임보다 먼저 끝나는 거래는 없다.
   */
  closedAtUnixMs?: number;
  failure?: string;
  moves: LayoutMove[];
};

export type LayoutTransitionJournalEvent = Readonly<{
  type: "dom-committed";
  transactionId: string;
  sequence: number;
  domCommittedAtUnixMs: number;
}>;

const journal = moduleState("lib/layoutTransitionJournal", () => ({
  sequence: 0,
  entries: [] as LayoutTransitionJournalEntry[],
  /** 다음 거래 하나가 가져갈 사유. 자극이 선언하고 거래가 소비한다. */
  pendingCauseTraceId: null as string | null,
}));
const journalListeners = moduleState(
  "lib/layoutTransitionJournal#listeners",
  () => new Set<(event: LayoutTransitionJournalEvent) => void>(),
);

/** 공개 layout 거래 사건 구독. listener 회수 함수를 반드시 호출하는 유한 관측에 사용한다. */
export function onLayoutTransitionJournal(
  listener: (event: LayoutTransitionJournalEvent) => void,
): () => void {
  journalListeners.add(listener);
  return () => journalListeners.delete(listener);
}

function publishLayoutTransitionJournal(event: LayoutTransitionJournalEvent): void {
  for (const listener of [...journalListeners]) {
    try {
      listener(event);
    } catch (error) {
      // 관측자가 레이아웃 거래를 깨뜨리면 코어와 검증기가 강결합된다. 실패한 관측은 표본
      // 누락으로 RED가 되고, 실제 DOM/surface commit은 자기 계약대로 계속 진행한다.
      console.error("[layout] 거래 사건 관측자 실패", error);
    }
  }
}

/**
 * 다음 배치 거래 하나의 사유를 선언한다.
 *
 * 장부를 sequence 창으로 오려내는 것은 "그 사이에 다른 거래가 없었다"는 가정이다. 가정은
 * 영수증이 아니므로 자극이 자기 관측 거래 식별자를 직접 남기고, 그 자극이 연 거래 하나가
 * 가져간다. 한 번 소비되면 사라지므로 뒤따르는 남의 거래에 흘러가지 않는다.
 */
export function declareLayoutCause(traceId: string): void {
  journal.pendingCauseTraceId = traceId;
}

/** 코어/프레임워크 공통 레이아웃 거래 사실. 최대 64개인 유한 장부이며 감시 폴링이 아니다. */
export function layoutTransitionJournal(): LayoutTransitionJournalEntry[] {
  return journal.entries.map((entry) => ({ ...entry, moves: entry.moves.map((move) => ({ ...move })) }));
}

/**
 * 선언한 출발 epoch 까지 남은 실시간 lead 하나. 이미 지난 예약과 출발이 없는 거래(snap)는
 * 즉시 지나간다. 재생 배수 디버그는 움직임 자체만 늘리고 합의된 절대 epoch 는 곱하지 않으므로
 * 이 대기는 문서 타임라인이 아니라 실시간이다(motionDebug.scheduleMotionAt 과 같은 기준).
 * 감시 폴링이 아니라 유한한 예약 하나이며, 지나면 다시 걸리지 않는다.
 */
function declaredStartArrived(startAtUnixMs: number | undefined): Promise<void> {
  if (startAtUnixMs === undefined) return Promise.resolve();
  const leadMs = startAtUnixMs - presentationNowUnixMs();
  if (!(leadMs > 0)) return Promise.resolve();
  // 예약 지연은 정수 ms 로 잘린다. 내림으로 잘리면 깨어난 시각이 선언한 출발보다 1ms 이르고,
  // 그러면 닫음이 다시 출발보다 앞선다. 시각을 손으로 올려 적는 대신 기다림을 올림한다.
  return new Promise((resolve) => { setTimeout(resolve, Math.ceil(leadMs)); });
}

export function journalPreparedLayoutTransition(
  moves: readonly LayoutMove[],
  prepared: PreparedLayoutTransition,
): PreparedLayoutTransition {
  const sequence = ++journal.sequence;
  const causeTraceId = journal.pendingCauseTraceId;
  journal.pendingCauseTraceId = null;
  const entry: LayoutTransitionJournalEntry = {
    transactionId: `layout-${sequence}`,
    ...(causeTraceId === null ? {} : { causeTraceId }),
    sequence,
    phase: "prepared",
    mode: prepared.mode,
    ...(prepared.startAtUnixMs === undefined ? {} : { startAtUnixMs: prepared.startAtUnixMs }),
    ...(prepared.durationMs === undefined ? {} : { durationMs: prepared.durationMs }),
    preparedAtUnixMs: presentationNowUnixMs(),
    moves: moves.map((move) => ({ ...move })),
  };
  journal.entries.push(entry);
  if (journal.entries.length > 64) journal.entries.splice(0, journal.entries.length - 64);
  let closed = false;
  return {
    mode: prepared.mode,
    startAtUnixMs: prepared.startAtUnixMs,
    durationMs: prepared.durationMs,
    commit: async () => {
      if (closed) return;
      closed = true;
      // PreparedLayoutTransition.commit은 useLayoutEffect에서 목표 DOM이 실제 커밋된 직후
      // 호출된다. 이 시각과 사건은 surface 어댑터 ACK를 기다리기 전에 동기 발행한다.
      // 따라서 DOM 표본은 timer 근사 없이 이 callback 안에서 같은 transaction에 결합된다.
      entry.domCommittedAtUnixMs = presentationNowUnixMs();
      publishLayoutTransitionJournal(Object.freeze({
        type: "dom-committed",
        transactionId: entry.transactionId,
        sequence: entry.sequence,
        domCommittedAtUnixMs: entry.domCommittedAtUnixMs,
      }));
      try {
        await prepared.commit();
        // 표면이 목표를 받았다는 것과 이 거래가 끝났다는 것은 다른 사실이다. glide 거래는
        // 준비 왕복을 덮을 lead 를 두고 출발 epoch 를 미래에 선언하므로, ACK 시각을 그대로
        // 닫음으로 찍으면 장부는 아직 시작도 안 한 움직임을 이미 끝난 것으로 답한다.
        await declaredStartArrived(entry.startAtUnixMs);
        entry.phase = "committed";
        entry.closedAtUnixMs = presentationNowUnixMs();
      } catch (error) {
        entry.phase = "failed";
        entry.closedAtUnixMs = presentationNowUnixMs();
        const message = error instanceof Error ? error.message : String(error);
        entry.failure = message || "layout surface commit failed";
        throw error;
      }
    },
    cancel: () => {
      if (closed) return;
      closed = true;
      prepared.cancel();
      entry.phase = "cancelled";
      entry.closedAtUnixMs = presentationNowUnixMs();
    },
  };
}

export function __resetLayoutTransitionJournalForTest(): void {
  journal.sequence = 0;
  journal.entries.length = 0;
  journal.pendingCauseTraceId = null;
  journalListeners.clear();
}
import { presentationNowUnixMs } from "./presentationClock";
