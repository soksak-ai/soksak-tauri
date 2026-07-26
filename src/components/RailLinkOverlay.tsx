import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RailRect } from "../lib/railPlacement";
import {
  insetClippedEdges,
  splitRightEdgeRounded,
  railLinkAdjacent,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
} from "../lib/railLinkShape";
import { useSettings } from "../state/settings";
import { useTheme } from "../state/theme";

interface Size {
  width: number;
  height: number;
}

// moment 모드 플래시 유지 시간(ms) — 해제 후 페이드아웃은 CSS transition 이 소유.
export const RELATION_MOMENT_MS = 600;

/**
 * 레일과 결부 패널의 관계를 한 합집합 경로로 표시한다. 패널 DOM/테마 보더를 읽지
 * 않으며, ResizeObserver 이벤트와 공개 레이아웃 rect만 소비한다.
 *
 * 표현은 railRelation 설정(tint|moment|stroke)의 모드 클래스로 CSS 가 갈래를 나눈다
 * — 비교 실험용 임시 스위치(결정 시 채택안만 남기고 소거, App.css 갈래 참조).
 * 비인접(레일 변과 셀 변의 논리 간격 1%p 초과)이면 모든 모드에서 아예 렌더하지 않는다.
 */
export const RailLinkOverlay = memo(function RailLinkOverlay({
  contentId,
  boundViewId,
  boundPaneId,
  railWidth,
  railStation,
  targetRect,
  projected = false,
}: {
  contentId: string;
  boundViewId: string;
  boundPaneId: string;
  railWidth: number;
  railStation: number;
  targetRect: RailRect;
  /** 이 인접이 focus-near 투영(교체)으로 성립했는가 — 봉합선 표시의 유일 입력. */
  projected?: boolean;
}) {
  const radius = useTheme((state) => state.spec.relation.radius);
  const strokeWidth = useTheme((state) => state.spec.relation.strokeWidth);
  const railRelation = useSettings((state) => state.railRelation);
  const railFill = useSettings((state) => state.railFill);
  const railSeamStyle = useSettings((state) => state.railSeamStyle);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const adjacent = railLinkAdjacent(railStation, targetRect);

  useLayoutEffect(() => {
    // 비인접 렌더 억제 중엔 host 가 없다 — 인접 복귀 때 이 effect 가 다시 붙는다.
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
  }, [adjacent]);

  // moment: 결부 정체성(boundViewId/targetRect)이 바뀐 순간만 잠깐 관계 토큰을 노출.
  const identity = `${boundViewId}|${targetRect.left}|${targetRect.top}|${targetRect.width}|${targetRect.height}`;
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (railRelation !== "moment") {
      setFlash(false);
      return;
    }
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), RELATION_MOMENT_MS);
    return () => clearTimeout(timer);
  }, [railRelation, identity]);

  if (!adjacent) return null;

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
      className={`rail-link-overlay relation-${railRelation} fill-${railFill}`}
      data-node={`relation/rail/${contentId}`}
      data-bound-tab={boundViewId}
      data-bound-pane={boundPaneId}
      data-connected={path ? "true" : "false"}
      data-projected={projected ? "true" : undefined}
      data-flash={railRelation === "moment" ? String(flash) : undefined}
      aria-hidden="true"
    >
      {path && boxes && (
        <svg
          className="rail-link-canvas"
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
        >
          {projected && railSeamStyle === "edge" ? (() => {
            // B안 — 바깥 오른쪽 변 점선: 외곽선에서 최우측 변만 분리해 점선으로,
            // 나머지는 열린 실선으로 그린다. 채움은 닫힌 원경로가 소유(스트로크 없음).
            const inset = insetClippedEdges(
              polygon!,
              size.width,
              size.height,
              strokeWidth / 2,
            );
            const split = splitRightEdgeRounded(inset, radius);
            if (!split) return <path className="rail-link-shape" d={path} />;
            return (
              <>
                <path className="rail-link-fill" d={path} />
                <path className="rail-link-rest" d={split.solid} />
                <line
                  className="rail-link-edge"
                  x1={split.edge[0].x}
                  y1={split.edge[0].y}
                  x2={split.edge[1].x}
                  y2={split.edge[1].y}
                />
              </>
            );
          })() : (
            <path className="rail-link-shape" d={path} />
          )}
          {projected && railSeamStyle === "seam" && (() => {
            // 교체-인접 봉합선 — 합집합 외곽선의 내부 공유변. 자연 인접은 한 몸이라 봉합선이
            // 없고, 투영(교체)으로 성립한 인접만 같은 두께의 점선으로 "꿰맨 자국"을 남긴다.
            const eps = 1;
            const seamX =
              Math.abs(boxes.rail.x + boxes.rail.width - boxes.panel.x) < eps
                ? boxes.panel.x
                : Math.abs(boxes.panel.x + boxes.panel.width - boxes.rail.x) < eps
                  ? boxes.rail.x
                  : null;
            const y0 = Math.max(boxes.rail.y, boxes.panel.y);
            const y1 = Math.min(
              boxes.rail.y + boxes.rail.height,
              boxes.panel.y + boxes.panel.height,
            );
            return seamX !== null && y1 > y0 ? (
              <line
                className="rail-link-seam"
                x1={seamX}
                y1={y0}
                x2={seamX}
                y2={y1}
              />
            ) : null;
          })()}
        </svg>
      )}
    </div>
  );
});
