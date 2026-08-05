export const CAPTURE_MOTION_ANCHOR_ATTR = "data-capture-motion-anchor";
export const CAPTURE_MOTION_ANCHOR_SIZE = 12;

export interface CaptureMotionAnchorTarget {
  address: string;
  color: string;
  host: HTMLElement;
  x?: number;
  y?: number;
}

function currentAnchors(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${CAPTURE_MOTION_ANCHOR_ATTR}]`)];
}

function removeAnchor(anchor: HTMLElement): void {
  const host = anchor.parentElement;
  const restore = anchor.dataset.captureMotionRestorePosition;
  anchor.remove();
  if (host && restore !== undefined) host.style.position = restore;
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
  for (const anchor of currentAnchors(document)) removeAnchor(anchor);

  for (const target of targets) {
    const anchor = document.createElement("div");
    anchor.setAttribute(CAPTURE_MOTION_ANCHOR_ATTR, target.address);
    if (target.host.ownerDocument.defaultView?.getComputedStyle(target.host).position === "static") {
      anchor.dataset.captureMotionRestorePosition = target.host.style.position;
      target.host.style.position = "relative";
    }
    Object.assign(anchor.style, {
      position: "absolute",
      left: `${target.x ?? 0}px`,
      top: `${target.y ?? 0}px`,
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
