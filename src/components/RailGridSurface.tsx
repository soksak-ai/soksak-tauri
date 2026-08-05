import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { railTravelDeclaredMs } from "../lib/railMotion";

/**
 * 콘텐츠 탭이 선택하는 패널 그리드의 좌표계.
 * rail은 탭 chrome이 아니라 이 surface만 점유한다.
 */
export function RailGridSurface({
  children,
  railPlane,
  relationOverlay,
  traveling = false,
  startAtUnixMs,
}: {
  children: ReactNode;
  railPlane: ReactNode;
  relationOverlay?: ReactNode;
  // §12-④ 주행 위상 — 이 동안 railGap 소비자들이 레일과 동조해 미끄러진다(App.css 동조 규칙).
  traveling?: boolean;
  /** DOM 패널·레일과 프레임워크 외부 표면이 공유하는 거래 시작 epoch. */
  startAtUnixMs?: number;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!startAtUnixMs || !surface) return;
    const timelineNow = Number(document.timeline?.currentTime ?? performance.now());
    const startTime = timelineNow + (startAtUnixMs - Date.now());
    for (const animation of surface.getAnimations({ subtree: true })) {
      const css = animation as CSSAnimation;
      if (css.animationName === "rail-flip-x") animation.startTime = startTime;
    }
  }, [startAtUnixMs]);
  return (
    <div
      // 옛 이름 동반 — commands 층이 `.content-body.rail-traveling` 로 주행 위상을 읽는다.
      // 제거 조건: catalogDom 의 그 셀렉터가 `.space-body` 로 이행하면 두 번째 토큰을 지운다.
      className={`space-body content-body${traveling ? " rail-traveling" : ""}`}
      ref={surfaceRef}
      // 선언은 맨 길이다 — 배수를 여기서 곱하면 안 된다. 느리게 보는 축은 Web Animations 의
      // playbackRate 하나이고, 그것이 이 전이를 이미 늘린다. 선언까지 곱하면 화면은 배수의
      // 제곱만큼 느려지는데 위상을 닫는 JS 타이머는 한 번만 곱하므로, 이동이 몇 %만 진행된
      // 자리에서 위상이 끝나 레이어가 갈리며 튄다(실사고: 20배에서 느려지다 끊기고 되돌아감).
      style={{ "--rail-travel-ms": `${railTravelDeclaredMs()}ms` } as CSSProperties}
    >
      {children}
      {railPlane}
      {relationOverlay}
    </div>
  );
}
