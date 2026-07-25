// 배치 위상 — 화면에 무엇이 서 있는지는 위상이 소유한다.
//
// 위상 추적은 여기 하나뿐이다. 이전에는 셋이 각자 추적했다(포커스 스왑 위상 · 레일 주행 기하 ·
// 레일 프레젠테이션 세대) — 그래서 스위칭과 주행이 한 클릭에 겹치면 서로 다른 출발점을 보고
// 어긋났다. 한 해에서 뽑은 moves 하나가 두 축(배열 교환 · 삽입 지점)을 모두 싣는다.
//
// 그리고 **표시의 주인이 위상이다**: 주행 중에 도착한 새 해는 표시를 갈아치우지 않고 대기열
// (깊이 1)에 앉는다. 표시를 즉시 갈면 달리는 애니메이션의 출발 오프셋이 CSS 변수 갱신으로
// 다시 해석돼 요소가 남은 진행도만큼 튀고(최대 두 이동량의 합), 동결·veil·착지가 위상 한복판에
// 한 번 더 돌아간다. 대기열은 그 두 결함을 구조적으로 없앤다 — 첫 여정이 끝난 뒤 다음 여정이
// 최신 목표로 출발하므로 언제나 매끄럽고, 클릭을 몇 번 하든 위상은 최대 둘이다(중간은 접힌다).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  arrangementMoves,
  type Arrangement,
  type ArrangementMove,
} from "../lib/railArrangement";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import { redeliverViewFocusIfLost } from "../plugins/viewFocus";

export interface ArrangementPhase<L> {
  /** 지금 화면에 서 있는 배치 — 렌더의 단일 진실(위상 중에는 위상의 목표를 유지한다). */
  displayed: Arrangement<L> | null;
  /** 위상 출발 배치. 정차 중이면 displayed 와 같다. */
  from: Arrangement<L> | null;
  /** 실제로 움직이는 패널만. 비어 있으면 위상이 아니다. */
  moves: ArrangementMove[];
  traveling: boolean;
  /** 레일 레이어 key — 위상마다 전진한다. */
  generation: number;
  /** 다음 해를 여정 없이 받아들인다(손 드래그 착지 — 이미 손이 옮겨 놓았다). */
  rebase: () => void;
}

interface PhaseState<L> {
  from: Arrangement<L> | null;
  displayed: Arrangement<L> | null;
  generation: number;
  scopeId: string;
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
  const [phase, setPhase] = useState<PhaseState<L>>({
    from: current,
    displayed: current,
    generation: 0,
    scopeId,
  });

  // 커밋 시점의 최신값 — 무장 시점 캡처는 전환 중 일시값(placement 미적재 등)을 기준점에 박아
  // 이후 모든 포커스 변화가 유령 여정을 재개하게 했다(실사고).
  const latest = useRef(current);
  latest.current = current;
  const latestScope = useRef(scopeId);
  latestScope.current = scopeId;
  /** 주행 중 도착한 최신 해(깊이 1) — 표시는 여정이 끝난 뒤에 갈아탄다. */
  const queued = useRef<Arrangement<L> | null>(null);
  /** 다음 해를 여정 없이 받는다 — 손 드래그가 이미 그 자리로 옮겨 놓은 경우. */
  const acceptWithoutTravel = useRef(false);

  const samePlane = phase.scopeId === scopeId;
  const moves =
    phase.displayed && phase.from && samePlane
      ? arrangementMoves(phase.from, phase.displayed)
      : [];
  const traveling = moves.length > 0;

  const rebase = useCallback(() => {
    acceptWithoutTravel.current = true;
    queued.current = null;
    setPhase((p) => ({
      from: latest.current,
      displayed: latest.current,
      generation: p.generation + 1,
      scopeId: latestScope.current,
    }));
  }, []);

  const currentKey = arrangementKey(current);
  const displayedKey = arrangementKey(phase.displayed);

  // 새 해의 처리 — 평면이 바뀌면 즉시 재정박, 주행 중이면 대기, 정차 중이면 여정 시작.
  useEffect(() => {
    if (!samePlane) {
      // 옛 선 집합의 station 을 새 평면에 적용하면 레일이 패널을 관통한다 — 출발 기하를
      // 소비하지 않고 새 평면에 그대로 선다.
      queued.current = null;
      setPhase((p) => ({
        from: latest.current,
        displayed: latest.current,
        generation: p.generation + 1,
        scopeId: latestScope.current,
      }));
      return;
    }
    if (currentKey === displayedKey) return;
    if (acceptWithoutTravel.current) {
      acceptWithoutTravel.current = false;
      setPhase((p) => ({
        from: latest.current,
        displayed: latest.current,
        generation: p.generation + 1,
        scopeId: latestScope.current,
      }));
      return;
    }
    if (traveling) {
      queued.current = latest.current; // 여정 중 — 표시는 그대로 두고 최신 목표만 기억
      return;
    }
    setPhase((p) => ({
      from: p.displayed,
      displayed: latest.current,
      generation: p.generation + 1,
      scopeId: latestScope.current,
    }));
  }, [currentKey, displayedKey, samePlane, traveling]);

  // 여정 종료 — 대기 중인 목표가 있으면 그 자리에서 다음 여정을 시작한다.
  useEffect(() => {
    if (!traveling) return;
    const timer = window.setTimeout(() => {
      setPhase((p) => {
        const next = queued.current;
        queued.current = null;
        const advances =
          next && p.displayed && arrangementMoves(p.displayed, next).length > 0;
        return {
          from: p.displayed,
          displayed: advances ? next : p.displayed,
          generation: p.generation + 1,
          scopeId: latestScope.current,
        };
      });
      // 재배열이 떨군 입력 포커스를 착지 시점에 재배달한다 — "바깥(그룹 활성)만 되고 내부
      // (위젯) 포커스는 안 오는" 결함의 봉합점.
      redeliverViewFocusIfLost();
    }, RAIL_TRAVEL_MS);
    return () => window.clearTimeout(timer);
  }, [traveling, phase.generation]);

  return {
    displayed: phase.displayed,
    from: traveling ? phase.from : phase.displayed,
    moves,
    traveling,
    generation: phase.generation,
    rebase,
  };
}
