export const CAPTURE_MOTION_ANCHOR_ATTR = "data-capture-motion-anchor";
export const CAPTURE_MOTION_ANCHOR_SIZE = 12;

export interface CaptureMotionAnchorTarget {
  address: string;
  color: string;
  host: HTMLElement;
}

function currentAnchors(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`)];
}

/**
 * 외부 표면과 DOM 슬롯의 이동 궤적을 같은 PNG에서 비교하는 DOM 기준자.
 *
 * 기준자는 공개 주소로 해소한 탭 슬롯의 자식이므로 슬롯의 transform을 그대로 상속한다. 페이지
 * 표면의 같은 색 기준자와 x좌표를 비교하면, 최종 정착만 맞는 stale surface를 프레임별로 검출할
 * 수 있다. 호출마다 선언 전체를 다시 적용하며 빈 배열은 제거다.
 */
export function setCaptureMotionAnchors(
  document: Document,
  targets: readonly CaptureMotionAnchorTarget[],
) {
  for (const anchor of currentAnchors(document)) anchor.remove();

  for (const target of targets) {
    const anchor = document.createElement("div");
    anchor.setAttribute(CAPTURE_MOTION_ANCHOR_ATTR, target.address);
    Object.assign(anchor.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${CAPTURE_MOTION_ANCHOR_SIZE}px`,
      height: `${CAPTURE_MOTION_ANCHOR_SIZE}px`,
      background: target.color,
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    target.host.append(anchor);
  }

  return {
    visible: targets.length > 0,
    count: targets.length,
    anchors: currentAnchors(document).map((anchor) => {
      const rect = anchor.getBoundingClientRect();
      return {
        address: anchor.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR) ?? "",
        color: anchor.style.backgroundColor,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    }),
  };
}
