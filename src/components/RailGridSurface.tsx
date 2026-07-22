import type { ReactNode } from "react";

/**
 * 콘텐츠 탭이 선택하는 패널 그리드의 좌표계.
 * rail은 탭 chrome이 아니라 이 surface만 점유한다.
 */
export function RailGridSurface({
  children,
  railPlane,
  traveling = false,
}: {
  children: ReactNode;
  railPlane: ReactNode;
  // §12-④ 주행 위상 — 이 동안 railGap 소비자들이 레일과 동조해 미끄러진다(App.css 동조 규칙).
  traveling?: boolean;
}) {
  return (
    <div className={`content-body${traveling ? " rail-traveling" : ""}`}>
      {children}
      {railPlane}
    </div>
  );
}
