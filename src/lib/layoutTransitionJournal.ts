import { moduleState } from "./moduleState";
import type { LayoutMove, LayoutTransitionMode, PreparedLayoutTransition } from "./layoutTransitionHost";

export type LayoutTransitionJournalEntry = {
  transactionId: string;
  sequence: number;
  phase: "prepared" | "committed" | "cancelled" | "failed";
  mode: LayoutTransitionMode;
  startAtUnixMs?: number;
  preparedAtUnixMs: number;
  domCommittedAtUnixMs?: number;
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

/** 코어/프레임워크 공통 레이아웃 거래 사실. 최대 64개인 유한 장부이며 감시 폴링이 아니다. */
export function layoutTransitionJournal(): LayoutTransitionJournalEntry[] {
  return journal.entries.map((entry) => ({ ...entry, moves: entry.moves.map((move) => ({ ...move })) }));
}

export function journalPreparedLayoutTransition(
  moves: readonly LayoutMove[],
  prepared: PreparedLayoutTransition,
): PreparedLayoutTransition {
  const sequence = ++journal.sequence;
  const entry: LayoutTransitionJournalEntry = {
    transactionId: `layout-${sequence}`,
    sequence,
    phase: "prepared",
    mode: prepared.mode,
    ...(prepared.startAtUnixMs === undefined ? {} : { startAtUnixMs: prepared.startAtUnixMs }),
    preparedAtUnixMs: Date.now(),
    moves: moves.map((move) => ({ ...move })),
  };
  journal.entries.push(entry);
  if (journal.entries.length > 64) journal.entries.splice(0, journal.entries.length - 64);
  let closed = false;
  return {
    mode: prepared.mode,
    startAtUnixMs: prepared.startAtUnixMs,
    commit: async () => {
      if (closed) return;
      closed = true;
      // PreparedLayoutTransition.commit은 useLayoutEffect에서 목표 DOM이 실제 커밋된 직후
      // 호출된다. 이 시각과 사건은 surface 어댑터 ACK를 기다리기 전에 동기 발행한다.
      // 따라서 DOM 표본은 timer 근사 없이 이 callback 안에서 같은 transaction에 결합된다.
      entry.domCommittedAtUnixMs = Date.now();
      publishLayoutTransitionJournal(Object.freeze({
        type: "dom-committed",
        transactionId: entry.transactionId,
        sequence: entry.sequence,
        domCommittedAtUnixMs: entry.domCommittedAtUnixMs,
      }));
      try {
        await prepared.commit();
        entry.phase = "committed";
        entry.closedAtUnixMs = Date.now();
      } catch (error) {
        entry.phase = "failed";
        entry.closedAtUnixMs = Date.now();
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
      entry.closedAtUnixMs = Date.now();
    },
  };
}

export function __resetLayoutTransitionJournalForTest(): void {
  journal.sequence = 0;
  journal.entries.length = 0;
  journalListeners.clear();
}
