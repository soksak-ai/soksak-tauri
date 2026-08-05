import { moduleState } from "./moduleState";

type Listener = () => void;

const state = moduleState("lib/layoutSettlement#state", () => ({
  requested: new Map<string, number>(),
  settled: new Map<string, number>(),
  listeners: new Set<Listener>(),
}));

function emit(): void {
  for (const listener of state.listeners) listener();
}

/** 레이아웃을 바꾸는 상태 변이가 동기적으로 발행하는 프로젝트별 revision. */
export function invalidateLayout(key: string): number {
  const revision = (state.requested.get(key) ?? 0) + 1;
  state.requested.set(key, revision);
  emit();
  return revision;
}

/** 렌더러가 최신 해를 채택하고 준비·이동이 모두 끝났을 때만 호출한다. */
export function settleLayout(key: string): void {
  const requested = state.requested.get(key) ?? 0;
  if ((state.settled.get(key) ?? 0) >= requested) return;
  state.settled.set(key, requested);
  emit();
}

export function layoutSettlementFacts(key?: string): {
  active: boolean;
  pending: Array<{ key: string; requested: number; settled: number }>;
} {
  const pending = [...state.requested].flatMap(([candidate, requested]) => {
    if (key !== undefined && candidate !== key) return [];
    const settled = state.settled.get(candidate) ?? 0;
    return settled < requested ? [{ key: candidate, requested, settled }] : [];
  });
  return { active: pending.length > 0, pending };
}

export function onLayoutSettlement(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function __resetLayoutSettlementForTest(): void {
  state.requested.clear();
  state.settled.clear();
  state.listeners.clear();
}
