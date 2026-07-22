import { memo, useLayoutEffect, useRef, useState } from "react";
import type { RailRect } from "../lib/railPlacement";
import {
  insetClippedEdges,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
} from "../lib/railLinkShape";
import { useTheme } from "../state/theme";
import { useT } from "../i18n";

interface Size {
  width: number;
  height: number;
}

/**
 * 레일과 결부 패널의 관계를 한 합집합 경로로 표시한다. 패널 DOM/테마 보더를 읽지
 * 않으며, ResizeObserver 이벤트와 공개 레이아웃 rect만 소비한다.
 */
export const RailLinkOverlay = memo(function RailLinkOverlay({
  contentId,
  boundViewId,
  boundPanelId,
  label,
  railWidth,
  railStation,
  targetRect,
}: {
  contentId: string;
  boundViewId: string;
  boundPanelId: string;
  label: string;
  railWidth: number;
  railStation: number;
  targetRect: RailRect;
}) {
  const t = useT();
  const radius = useTheme((state) => state.spec.relation.radius);
  const strokeWidth = useTheme((state) => state.spec.relation.strokeWidth);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const commit = (width: number, height: number) => {
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    const rect = host.getBoundingClientRect();
    commit(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (next) commit(next.width, next.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const boxes = railLinkBoxes(
    size.width,
    size.height,
    railWidth,
    railStation,
    targetRect,
  );
  const polygon = boxes ? railLinkPolygon(boxes.rail, boxes.panel) : null;
  const path = polygon
    ? roundedOrthogonalPath(
        insetClippedEdges(
          polygon,
          size.width,
          size.height,
          strokeWidth / 2,
        ),
        radius,
      )
    : "";

  return (
    <div
      ref={hostRef}
      className="rail-link-overlay"
      data-node={`relation/rail/${contentId}`}
      data-bound-view={boundViewId}
      data-bound-panel={boundPanelId}
      data-connected={path ? "true" : "false"}
      aria-hidden="true"
    >
      {path && boxes && (
        <>
          <svg
            className="rail-link-canvas"
            viewBox={`0 0 ${size.width} ${size.height}`}
            preserveAspectRatio="none"
          >
            <path className="rail-link-shape" d={path} />
          </svg>
          <div
            className="rail-link-label"
            style={{ left: boxes.rail.x + 14, top: 4 }}
          >
            {t("railRelation.linked")} · {label}
          </div>
        </>
      )}
    </div>
  );
});
