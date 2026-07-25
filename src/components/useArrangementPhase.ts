// 배치 위상 — 해가 바뀌면 직전 해를 RAIL_TRAVEL_MS 동안 붙잡아 이동의 출발점을 제공한다.
//
// 위상 추적은 여기 하나뿐이다. 이전에는 셋이 각자 추적했다(포커스 스왑 위상 · 레일 주행 기하 ·
// 레일 프레젠테이션 세대) — 그래서 스위칭과 주행이 한 클릭에 겹치면 서로 다른 출발점을 보고
// 어긋났다. 한 해에서 뽑은 moves 하나가 두 축(배열 교환 · 삽입 지점)을 모두 싣는다.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  arrangementMoves,
  type Arrangement,
  type ArrangementMove,
} from "../lib/railArrangement";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import { redeliverViewFocusIfLost } from "../plugins/viewFocus";

export interface ArrangementPhase<L> {
  /** 위상 출발 배치. 정차 중이면 현재 해와 같다. */
  from: Arrangement<L> | null;
  /** 실제로 움직이는 패널만. 비어 있으면 위상이 아니다. */
  moves: ArrangementMove[];
  traveling: boolean;
  /** 레일 레이어 key — 위상마다 전진한다. */
  generation: number;
  /** 표시 기준점을 현재 해에 즉시 동기화(손 드래그 착지 — 주행이 아니다). */
  rebase: () => void;
}

/** 위상 재무장 판정용 해 서명 — 렌더마다 새 객체가 오므로 값으로 비교한다. */
function arrangementKey<L>(a: Arrangement<L> | null): string {
  if (!a) return "";
  const cells = a.cells
    .map((c) => `${c.id}@${c.rect.left.toFixed(3)}`)
    .join(",");
  return `${a.station.toFixed(3)}|${cells}`;
}

export function useArrangementPhase<L extends { id: string }>(
  current: Arrangement<L> | null,
  /** 평면 identity(스페이스 + 깨끗한 선 집합). 분할·병합으로 선 집합이 바뀌면 새 평면이다. */
  scopeId: string,
): ArrangementPhase<L> {
  const [phase, setPhase] = useState<{
    from: Arrangement<L> | null;
    generation: number;
    scopeId: string;
  }>({ from: current, generation: 0, scopeId });

  // 커밋 시점의 최신값 — 무장 시점 캡처는 전환 중 일시값(placement 미적재 등)을 기준점에 박아
  // 이후 모든 포커스 변화가 유령 여정을 재개하게 했다(실사고).
  const latest = useRef(current);
  latest.current = current;
  const latestScope = useRef(scopeId);
  latestScope.current = scopeId;

  const samePlane = phase.scopeId === scopeId;
  const moves =
    current && phase.from && samePlane
      ? arrangementMoves(phase.from, current)
      : [];
  const traveling = moves.length > 0;

  const rebase = useCallback(() => {
    setPhase((p) => ({
      from: latest.current,
      generation: p.generation + 1,
      scopeId: latestScope.current,
    }));
  }, []);

  const targetKey = arrangementKey(current);
  useEffect(() => {
    // 평면이 바뀌면(분할·병합·최대화) 출발 기하를 소비하지 않는다 — 옛 선 집합의 station 을
    // 새 평면에 적용하면 레일이 패널을 관통한다.
    if (!samePlane) {
      rebase();
      return;
    }
    if (!traveling) return;
    const timer = window.setTimeout(() => {
      rebase();
      // 재배열이 떨군 입력 포커스를 착지 시점에 재배달한다 — "바깥(그룹 활성)만 되고 내부
      // (위젯) 포커스는 안 오는" 결함의 봉합점.
      redeliverViewFocusIfLost();
    }, RAIL_TRAVEL_MS);
    return () => window.clearTimeout(timer);
    // targetKey = 해의 값 서명. 같은 해가 다시 렌더돼도 타이머를 재무장하지 않는다.
  }, [rebase, samePlane, traveling, targetKey]);

  return {
    from: traveling ? phase.from : current,
    moves,
    traveling,
    generation: phase.generation,
    rebase,
  };
}
