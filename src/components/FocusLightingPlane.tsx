import { useId, type CSSProperties } from "react";

/** 조명 평면에 투영할 pane 상자. 좌표 산수는 GroupArea의 cellVars 한 곳에서 끝난다. */
export type LightingRegion = {
  id: string;
  style: CSSProperties;
  moving?: boolean;
};

type BlockedLightingRegion = LightingRegion & { amount: number };

/**
 * 작업면 조명은 콘텐츠의 속성이 아니라 그 위에 놓이는 단일 시각 평면이다.
 *
 * 검은 base veil이 작업면 전체를 가라앉히고, focused aperture만 원래 픽셀을 드러낸다.
 * blocked 영역은 base mask에서도 빼고 자기 농도로 정확히 한 번 칠한다. 따라서 콘텐츠
 * subtree에 filter/opacity를 걸지 않고도 DOM·WebGL·문서 밖 native surface가 같은 결과를
 * 낸다. SVG는 시각만 소유하며 입력과 접근성 트리에는 참여하지 않는다.
 */
export function FocusLightingPlane({
  baseAmount,
  focused,
  blocked,
}: {
  baseAmount: number;
  focused?: LightingRegion;
  blocked: BlockedLightingRegion[];
}) {
  const maskId = `focus-light-${useId().replace(/:/g, "")}`;
  const regionClass = (moving?: boolean) =>
    `focus-lighting-region${moving ? " flip-move" : ""}`;

  return (
    <svg
      className="focus-lighting-plane"
      data-node="focus-lighting"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask
          id={maskId}
          className="focus-lighting-mask"
          x="0"
          y="0"
          width="100%"
          height="100%"
          maskUnits="userSpaceOnUse"
        >
          <rect width="100%" height="100%" fill="white" />
          {focused && (
            <rect
              className={regionClass(focused.moving)}
              data-lighting-aperture={focused.id}
              style={focused.style}
              fill="black"
            />
          )}
          {blocked.map((region) => (
            <rect
              key={`cutout-${region.id}`}
              className={regionClass(region.moving)}
              data-lighting-cutout={region.id}
              style={region.style}
              fill="black"
            />
          ))}
        </mask>
      </defs>

      <rect
        className="focus-lighting-base"
        data-lighting-base="idle"
        width="100%"
        height="100%"
        fill="black"
        fillOpacity={baseAmount}
        mask={`url(#${maskId})`}
      />

      {blocked.map((region) => (
        <rect
          key={`blocked-${region.id}`}
          className={regionClass(region.moving)}
          data-lighting-blocked={region.id}
          style={region.style}
          fill="black"
          fillOpacity={region.amount}
        />
      ))}
    </svg>
  );
}
