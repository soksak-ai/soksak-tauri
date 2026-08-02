// DOM 수명 보존 가시성 — 프로젝트·콘텐츠·뷰를 언마운트하지 않고 보이기만 전환한다.
// 좌표 이동과 z 보정은 DOM의 책임이 아니다. 문서 밖 표면에 그런 보정이 필요하면 그 표면을
// 제공하는 프레임워크가 자기 어댑터 안에서 처리한다.
import type { CSSProperties } from "react";

/** 같은 규칙을 React 밖 DOM 요소에도 적용한다. */
export function applyParked(el: HTMLElement, active: boolean): void {
  // 보임은 선언하지 않고 조상 계약을 상속한다. CSS visibility는 hidden 조상 아래의 자식이
  // visible을 직접 선언하면 다시 드러날 수 있으므로, 중첩된 프로젝트→스페이스→탭 층에서
  // `visible`은 국소 사실이 아니라 상위 파킹을 깨는 명령이 된다.
  el.style.visibility = active ? "" : "hidden";
  el.style.pointerEvents = active ? "" : "none";
}

export function parkedStyle(active: boolean): CSSProperties {
  return {
    visibility: active ? undefined : "hidden",
    pointerEvents: active ? undefined : "none",
  } as CSSProperties;
}
