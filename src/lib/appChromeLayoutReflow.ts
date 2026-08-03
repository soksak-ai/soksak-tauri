import { useLayoutEffect } from "react";
import { emitPluginEvent } from "../plugins/hooks";

/**
 * ProjectSurface 바깥 앱 크롬 기하의 커밋 에지.
 *
 * 프로젝트 탭을 top↔left로 옮기거나 왼쪽 프로젝트 레일 폭이 바뀌면 안쪽 슬롯의 rect도
 * 바뀌지만 ProjectSurface 자체의 상태는 바뀌지 않을 수 있다. ResizeObserver/rAF는 비전면
 * 창에서 정지할 수 있으므로 정합 계약의 주 구동원이 될 수 없다. 앱 크롬 기하를 소유한 렌더가
 * 커밋 직후 명시적 layout.reflow 사건을 발행하고, 문서 밖 표면을 가진 어댑터만 소비한다.
 */
export function useAppChromeLayoutReflow(
  geometryKey: string,
  activeSpaceId: string | null,
): void {
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId });
  }, [geometryKey, activeSpaceId]);
}
