import { moduleState } from "./moduleState";
import type { LayoutMove, LayoutTransitionMode, PreparedLayoutTransition } from "./layoutTransitionHost";

export type LayoutTransitionJournalEntry = {
  transactionId: string;
  sequence: number;
  phase: "prepared" | "committed" | "cancelled";
  mode: LayoutTransitionMode;
  startAtUnixMs?: number;
  preparedAtUnixMs: number;
  closedAtUnixMs?: number;
  moves: LayoutMove[];
};

const journal = moduleState("lib/layoutTransitionJournal", () => ({
  sequence: 0,
  entries: [] as LayoutTransitionJournalEntry[],
}));

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
      await prepared.commit();
      entry.phase = "committed";
      entry.closedAtUnixMs = Date.now();
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
}
