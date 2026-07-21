import type { ReactNode } from "react";

/**
 * 콘텐츠 탭이 선택하는 패널 그리드의 좌표계.
 * rail은 탭 chrome이 아니라 이 surface만 점유한다.
 */
export function RailGridSurface({
  children,
  railPlane,
}: {
  children: ReactNode;
  railPlane: ReactNode;
}) {
  return (
    <div className="content-body">
      {children}
      {railPlane}
    </div>
  );
}
