import { useEffect, useMemo, useState } from "react";
import type { SplitTree } from "../state/splitTree";
import { computeSplitLayout } from "../lib/splitLayout";
import { RAIL_TRAVEL_MS } from "../lib/railMotion";
import { emitPluginEvent } from "../plugins/hooks";
import { redeliverViewFocusIfLost } from "../plugins/viewFocus";

type Identified = { id: string };

// 근접 투영 FLIP 위상 — displayLayout 이 바뀌면 이전 배열(from)을 RAIL_TRAVEL_MS 동안
// 붙잡아 compositor FLIP 의 출발점을 제공한다. 같은 크기의 x 교환일 때만 위상이 선다
// (실제 분할 편집/리사이즈는 조건 미달 → 즉시 스냅, 임의 애니메이션 오염 없음).
// 위상이 끝나는 순간 layout.reflow 를 발화한다 — 네이티브 웹뷰(브라우저)는 rAF 측정이라
// FLIP 시작 프레임(옛 좌표)을 읽고 눌러앉을 수 있고, 종료 신호가 없으면 옛 자리에서
// 클릭을 삼켜 포커스·스왑이 죽는다. 시작 신호는 ProjectPane(activeGroupId deps)이 소유.
export function useFocusLayoutPhase<L extends Identified>(
  displayLayout: SplitTree<L>,
  spaceId: string,
): { from: SplitTree<L>; traveling: boolean } {
  const [from, setFrom] = useState(displayLayout);
  const fromCells = useMemo(() => computeSplitLayout(from).cells, [from]);
  const toCells = useMemo(
    () => computeSplitLayout(displayLayout).cells,
    [displayLayout],
  );
  const traveling =
    from !== displayLayout &&
    fromCells.length === toCells.length &&
    toCells.every(({ value, rect }) => {
      const prev = fromCells.find((cell) => cell.value.id === value.id)?.rect;
      return (
        !!prev &&
        Math.abs(prev.top - rect.top) < 1e-9 &&
        Math.abs(prev.width - rect.width) < 1e-9 &&
        Math.abs(prev.height - rect.height) < 1e-9
      );
    });
  useEffect(() => {
    if (from === displayLayout) return;
    if (!traveling) {
      setFrom(displayLayout);
      return;
    }
    const timer = window.setTimeout(() => {
      setFrom(displayLayout);
      emitPluginEvent("layout.reflow", { activeSpaceId: spaceId });
      // 투영 재배열의 reparent 가 떨군 입력 포커스를 이동 종료 시점에 재배달한다 —
      // "바깥(그룹 활성)만 되고 내부(위젯) 포커스는 안 오는" 결함의 봉합점.
      redeliverViewFocusIfLost();
    }, RAIL_TRAVEL_MS);
    return () => window.clearTimeout(timer);
  }, [displayLayout, from, traveling, spaceId]);
  return { from, traveling };
}
