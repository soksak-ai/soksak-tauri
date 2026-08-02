// DOM 수명 보존 가시성 — 프로젝트·콘텐츠·뷰를 언마운트하지 않고 보이기만 전환한다.
// 좌표 이동과 z 보정은 DOM의 책임이 아니다. 문서 밖 표면에 그런 보정이 필요하면 그 표면을
// 제공하는 프레임워크가 자기 어댑터 안에서 처리한다.
import type { CSSProperties } from "react";

/** 같은 규칙을 React 밖 DOM 요소에도 적용한다. */
export function applyParked(el: HTMLElement, active: boolean): void {
  el.style.visibility = active ? "visible" : "hidden";
  el.style.pointerEvents = active ? "" : "none";
}

export function parkedStyle(active: boolean): CSSProperties {
  return {
    visibility: active ? "visible" : "hidden",
    pointerEvents: active ? undefined : "none",
  } as CSSProperties;
}
