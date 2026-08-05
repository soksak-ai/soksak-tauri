import { moduleState } from "./moduleState";
import { moveOffsetPx, type ArrangementMove } from "./railArrangement";

export interface LayoutMove {
  /** 공개 view identity. 네이티브 label 문자열을 코어가 해석하지 않는다. */
  viewId: string;
  /** 현재 위치에서 목표 위치까지의 DOM FLIP 시작 오프셋(old - new), CSS px. */
  dx: number;
}

export type LayoutTransitionMode = "glide" | "snap";

/** prepare 성공 뒤 DOM 커밋 또는 취소 중 정확히 하나로 닫아야 하는 배치 거래. */
export interface PreparedLayoutTransition {
  mode: LayoutTransitionMode;
  /** DOM과 문서 밖 표면이 함께 출발할 절대 epoch. 외부 surface glide에서만 존재한다. */
  startAtUnixMs?: number;
  /** 목표 DOM이 실제로 커밋된 직후 외부 표면 장부를 최종 rect와 대조한다. */
  commit(): Promise<void>;
  /** 목표가 준비 중 바뀌거나 컴포넌트가 사라지면 옛 DOM rect로 되돌린다. */
  cancel(): void;
}

export interface LayoutTransitionHost {
  /** 목표 DOM 커밋 전에 프레임워크가 자기 외부 표면을 준비한다. */
  prepareMove(moves: readonly LayoutMove[]): Promise<PreparedLayoutTransition>;
}

export interface LayoutViewGroup {
  id: string;
  viewIds: readonly string[];
}

/** 그룹 배치의 논리 이동을 공개 view identity별 CSS px 이동으로 한 번만 투영한다. */
export function viewLayoutMoves(
  moves: readonly ArrangementMove[],
  groups: readonly LayoutViewGroup[],
  hostWidthPx: number,
  railWidthPx: number,
): LayoutMove[] {
  if (!Number.isFinite(hostWidthPx) || hostWidthPx <= 0) {
    throw new Error(`배치 host 폭이 유효하지 않습니다: ${hostWidthPx}`);
  }
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  return moves.flatMap((move) => {
    const group = groupsById.get(move.id);
    if (!group) return [];
    const dx = moveOffsetPx(move, hostWidthPx, railWidthPx);
    return group.viewIds.map((viewId) => ({ viewId, dx }));
  });
}

const registered = moduleState("lib/layoutTransitionHost#registered", () => ({
  host: null as LayoutTransitionHost | null,
}));

export function registerLayoutTransitionHost(host: LayoutTransitionHost): void {
  registered.host = host;
}

/** 미설치 = 콘텐츠가 DOM 배치를 그대로 따라가므로 기존 glide가 정답이다. */
export function prepareLayoutMove(
  moves: readonly LayoutMove[],
): Promise<PreparedLayoutTransition> {
  return registered.host?.prepareMove(moves) ?? Promise.resolve({
    mode: "glide",
    commit: async () => {},
    cancel: () => {},
  });
}

export function __resetLayoutTransitionHostForTest(): void {
  registered.host = null;
}
