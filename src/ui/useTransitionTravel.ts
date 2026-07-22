import { useEffect, useState, type RefObject } from "react";

// 주행 신호(§12-④) — 대상 요소의 `left` transition 이 도는 동안만 true. 레일 평면이
// pane 아래로 잠수하는 유일한 근거다: 정차 중에는 위(상호작용 소유), 주행 중에만 창 뒤로.
// left 외 속성(width 등)의 transition 은 주행이 아니다.
export function useTransitionTravel(ref: RefObject<HTMLElement | null>): boolean {
  const [traveling, setTraveling] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const isOwnLeft = (e: TransitionEvent) => e.target === el && e.propertyName === "left";
    const start = (e: TransitionEvent) => {
      if (isOwnLeft(e)) setTraveling(true);
    };
    const stop = (e: TransitionEvent) => {
      if (isOwnLeft(e)) setTraveling(false);
    };
    el.addEventListener("transitionstart", start as EventListener);
    el.addEventListener("transitionend", stop as EventListener);
    el.addEventListener("transitioncancel", stop as EventListener);
    return () => {
      el.removeEventListener("transitionstart", start as EventListener);
      el.removeEventListener("transitionend", stop as EventListener);
      el.removeEventListener("transitioncancel", stop as EventListener);
    };
  }, [ref]);
  return traveling;
}
