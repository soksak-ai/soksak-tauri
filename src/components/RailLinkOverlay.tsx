import { useCallback, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { RailRect } from "../lib/railPlacement";
import type { RailRelationState } from "../lib/railArrangement";
import { moduleState } from "../lib/moduleState";
import {
  insetClippedEdges,
  splitRightEdgeRounded,
  railLinkBoxes,
  railLinkPolygon,
  roundedOrthogonalPath,
  type PixelBox,
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

function independentBoxPath(
  box: PixelBox,
  hostWidth: number,
  hostHeight: number,
  strokeWidth: number,
  radius: number,
): string {
  const points = insetClippedEdges(
    [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ],
    hostWidth,
    hostHeight,
    strokeWidth / 2,
  );
  return roundedOrthogonalPath(points, radius);
}

// moment 모드 플래시 유지 시간(ms) — 해제 후 페이드아웃은 CSS transition 이 소유.
export const RELATION_MOMENT_MS = 600;

/**
 * 레일과 결부 패널의 관계를 한 합집합 경로로 표시한다. 패널 DOM/테마 보더를 읽지
 * 않으며, ResizeObserver 이벤트와 공개 레이아웃 rect만 소비한다.
 *
 * 표현은 railRelation 설정(tint|moment|stroke)의 모드 클래스로 CSS 가 갈래를 나눈다.
 * 해결기가 union이면 합성 외곽선 하나, independent이면 두 실제 상자의 독립 보더, none이면
 * 경로 없는 상태 루트만 남긴다. 이 컴포넌트가 관계 분기를 재판정하지 않는다.
 */
export const RailLinkOverlay = memo(function RailLinkOverlay({
  contentId,
  relation,
  railWidth,
  railStation,
  targetRect,
  projected = false,
}: {
  contentId: string;
  /** 배치 해결기가 낸 공개 상태 — 이 컴포넌트는 관계·보더 분기를 다시 판정하지 않는다. */
  relation: RailRelationState;
  railWidth: number;
  /** 오른쪽에서 판을 밀고 들어온 폭 — 밀기 사이드바가 서면 판이 그만큼 좁다. 안 넘기면
   *  투영이 늘어나 칸이 호스트 밖으로 나가고 경로가 사선이 된다. */
  railStation: number;
  targetRect: RailRect | null;
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
  const commitSize = useCallback((width: number, height: number) => {
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  /**
   * **그리기 전에 잰다.** ResizeObserver 는 페인트 뒤에 온다 — 호스트가 줄거나 늘어난 그
   * 프레임에는 옛 크기로 그려지고, 관측이 도착한 다음 프레임에 제자리로 튄다. 그 한 프레임이
   * 사용자가 본 "안/밖으로 밀렸다가 정확히 복귀"다.
   *
   * 그래서 매 렌더 뒤(페인트 전)에 다시 잰다. 값이 그대로면 setState 가 no-op 이라 추가 렌더는
   * 없고, 달라진 프레임에서만 페인트 전에 한 번 더 그린다. 관측자는 **밖에서 오는** 크기 변화
   * (창 리사이즈 등 렌더 없이 일어나는 것)를 위해 남긴다 — 둘은 다른 사건이다.
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    commitSize(rect.width, rect.height);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (next) commitSize(next.width, next.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [commitSize]);

  // moment: 유효 결부 정체성/기하가 바뀐 순간만 잠깐 관계 토큰을 노출.
  const identity = targetRect
    ? `${relation.relationId}|${targetRect.left}|${targetRect.top}|${targetRect.width}|${targetRect.height}`
    : relation.relationId;
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

  const independent = relation.borderMode === "independent";

  const boxes = targetRect && relation.borderMode !== "none"
    ? railLinkBoxes(
        size.width,
        size.height,
        railWidth,
        railStation,
        targetRect,
      )
    : null;
  const polygon = boxes && relation.borderMode === "union"
    ? railLinkPolygon(boxes.rail, boxes.panel)
    : null;
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
  const independentRailPath = independent && boxes
    ? independentBoxPath(boxes.rail, size.width, size.height, strokeWidth, radius)
    : "";
  const independentPanelPath = independent && boxes
    ? independentBoxPath(boxes.panel, size.width, size.height, strokeWidth, radius)
    : "";

  return (
    <div
      ref={attach}
      className={`rail-link-overlay relation-${railRelation} fill-${railFill}`}
      data-node={`relation/rail/${contentId}`}
      data-bound-tab={relation.boundTabId ?? undefined}
      data-bound-pane={relation.boundPaneId ?? undefined}
      data-connected={String(relation.connected)}
      data-placement={relation.placement}
      data-side={relation.side}
      data-relation-id={relation.relationId}
      data-border-mode={relation.borderMode}
      data-path-count={relation.pathCount}
      // 그린 상자를 밖에서 잰다 — 보더는 SVG path 안에만 있어 "어디에 그려졌나"를 물을 자리가
      // 없었다. 없으면 눈으로 때려맞히게 된다. 호스트 상대 px, "x,y,w,h" 한 사실 하나.
      // 레일 상자와 판 상자는 서로 다른 것이다 — 한 가방에 넣지 않는다. 이음매가 흔들리면
      // 둘 중 어느 쪽이 움직였는지부터 갈라야 한다.
      data-rail={
        boxes
          ? `${Math.round(boxes.rail.x)},${Math.round(boxes.rail.y)},${Math.round(boxes.rail.width)},${Math.round(boxes.rail.height)}`
          : undefined
      }
      data-box={
        boxes
          ? `${Math.round(boxes.panel.x)},${Math.round(boxes.panel.y)},${Math.round(boxes.panel.width)},${Math.round(boxes.panel.height)}`
          : undefined
      }
      data-projected={projected ? "true" : undefined}
      data-flash={railRelation === "moment" ? String(flash) : undefined}
      aria-hidden="true"
      style={solidColorStyle}
    >
      {/* **늘리지 않는다.** viewBox 에 잰 크기를 싣고 preserveAspectRatio="none" 을 걸면, 그
          크기가 한 프레임이라도 낡았을 때 그림 전체가 (새폭/옛폭) 배로 눌리거나 늘어난다.
          x=0 은 스케일해도 0 이라 바깥 변만 제자리고 안쪽 변만 안/밖으로 밀린다 — 사용자가 본
          것이 정확히 그것이다(실측 2026-08-02: 밀 때 안으로, 접을 때 밖으로, 그리고 정확히 복귀).
          좌표는 이미 이 요소의 CSS px 이므로 viewBox 없이 그대로 그린다: 낡아도 틀린 자리에 그릴
          뿐 일그러지지는 않는다. */}
      {boxes && (path || independent) && (
        <svg className="rail-link-canvas">
          {independent ? (
            <>
              <path className="rail-link-independent rail-link-independent-rail" d={independentRailPath} />
              <path className="rail-link-independent rail-link-independent-pane" d={independentPanelPath} />
            </>
          ) : projected && railSeamStyle === "edge" ? (() => {
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
            <path className="rail-link-shape rail-link-union" d={path} />
          )}
          {!independent && projected && railSeamStyle === "seam" && (() => {
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
