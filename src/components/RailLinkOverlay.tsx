import { useCallback, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { RailRect } from "../lib/railPlacement";
import { moduleState } from "../lib/moduleState";
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

/**
 * 마지막으로 잰 호스트 크기 — 다시 붙어도 0 프레임이 없도록 잇는 자리.
 *
 * 갈아끼우기 경계 밖에 둔다. 모듈 지역 변수로 두면 HMR 이 모듈을 새로 만들 때 값을 잃고,
 * 그러면 다시 0 프레임이 생긴다 — 담는 자리와 "이미 쟀다"는 기억이 함께 살아야 한다.
 */
const lastSizeRef = moduleState("components/RailLinkOverlay#lastSize", () => ({
  value: { width: 0, height: 0 },
}));

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
  rightInset = 0,
  railStation,
  targetRect,
  projected = false,
}: {
  contentId: string;
  boundViewId: string;
  boundPaneId: string;
  railWidth: number;
  /** 오른쪽에서 판을 밀고 들어온 폭 — 밀기 사이드바가 서면 판이 그만큼 좁다. 안 넘기면
   *  투영이 늘어나 칸이 호스트 밖으로 나가고 경로가 사선이 된다. */
  rightInset?: number;
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
  // 실선 이음매의 색 — 레일이 판을 찾아가 인접이 **실재**할 때만(당기면 인접은 만들어진 것이라
  // 점선이고, 그 색까지 사용자 손에 두면 두 모양이 한 값을 나눠 갖는다).
  // 테마 토큰을 덮어쓰지 않고 이 오버레이 자기 자리에만 얹는다 — 한 토큰을 둘이 쓰면 어느
  // 쪽이 이길지 특이성이 정한다. 비움 = 테마에 맡긴다.
  const railPullFocused = useSettings((state) => state.railPullFocused);
  const railSolidColor = useSettings((state) => state.railSolidColor);
  const solidColorStyle =
    !railPullFocused && railSolidColor
      ? ({ "--relation-stroke": railSolidColor } as CSSProperties)
      : undefined;
  const hostRef = useRef<HTMLDivElement>(null);
  // 마지막으로 잰 크기에서 시작한다 — 0 에서 시작하면 그 프레임의 기하가 null 이라 보더가
  // 사라졌다 돌아온다(실측 2026-08-02: 토글마다 `host=0` 프레임 둘이 기하까지 갔다).
  // 이 컴포넌트는 토글 때 다시 붙으므로 상태로는 못 잇는다 — 값을 모듈에 둔다.
  const [size, setSize] = useState<Size>(lastSizeRef.value);
  /**
   * 붙는 **그 순간** 잰다.
   *
   * 0 으로 시작해 effect 에서 채우면 그 사이에 `hostWidth <= 0` 인 프레임이 생기고, 그때
   * 기하는 null 이라 보더가 통째로 사라진다 — 토글마다 한 번 깜빡이는 것이 그것이다(실측
   * 2026-08-02: 토글 직후 `host=0` 프레임이 로그에 찍혔다).
   *
   * ref 콜백은 DOM 이 붙는 시점에 불린다. 거기서 재면 안 잰 프레임이 없다.
   */
  const attach = useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node;
    if (!node) return;
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) lastSizeRef.value = { width: r.width, height: r.height };
    setSize((cur) =>
      cur.width === r.width && cur.height === r.height ? cur : { width: r.width, height: r.height },
    );
  }, []);
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
    rightInset,
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
      ref={attach}
      className={`rail-link-overlay relation-${railRelation} fill-${railFill}`}
      data-node={`relation/rail/${contentId}`}
      data-bound-tab={boundViewId}
      data-bound-pane={boundPaneId}
      data-connected={path ? "true" : "false"}
      data-projected={projected ? "true" : undefined}
      data-flash={railRelation === "moment" ? String(flash) : undefined}
      aria-hidden="true"
      style={solidColorStyle}
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
