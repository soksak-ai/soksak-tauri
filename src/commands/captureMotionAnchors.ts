export const CAPTURE_MOTION_ANCHOR_ATTR = "data-capture-motion-anchor";
export const CAPTURE_MOTION_ANCHOR_SIZE = 12;
const STYLE_ID = "soksak-capture-motion-anchor-style";
const X_PROP = "--capture-motion-anchor-x";
const Y_PROP = "--capture-motion-anchor-y";
const COLOR_PROP = "--capture-motion-anchor-color";

interface AnchorDeclaration {
  address: string;
  color: string;
  x: number;
  y: number;
  restorePosition: string;
  changedPosition: boolean;
}

const declarations = new Map<HTMLElement, AnchorDeclaration>();
const observers = new Map<HTMLElement, MutationObserver>();

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

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${CAPTURE_MOTION_ANCHOR_ATTR}]::after {
      content: "" !important;
      position: absolute !important;
      left: var(${X_PROP}, 0px) !important;
      top: var(${Y_PROP}, 0px) !important;
      width: ${CAPTURE_MOTION_ANCHOR_SIZE}px !important;
      height: ${CAPTURE_MOTION_ANCHOR_SIZE}px !important;
      background: var(${COLOR_PROP}) !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
    }
  `;
  document.head.append(style);
}

function applyDeclaration(host: HTMLElement, declaration: AnchorDeclaration): void {
  if (host.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR) !== declaration.address) {
    host.setAttribute(CAPTURE_MOTION_ANCHOR_ATTR, declaration.address);
  }
  if (declaration.changedPosition && host.style.position !== "relative") {
    host.style.position = "relative";
  }
  const values = [
    [X_PROP, `${declaration.x}px`],
    [Y_PROP, `${declaration.y}px`],
    [COLOR_PROP, declaration.color],
  ] as const;
  for (const [name, value] of values) {
    if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value);
  }
}

function removeAnchor(host: HTMLElement): void {
  observers.get(host)?.disconnect();
  observers.delete(host);
  const declaration = declarations.get(host);
  declarations.delete(host);
  host.removeAttribute(CAPTURE_MOTION_ANCHOR_ATTR);
  host.style.removeProperty(X_PROP);
  host.style.removeProperty(Y_PROP);
  host.style.removeProperty(COLOR_PROP);
  if (declaration?.changedPosition) host.style.position = declaration.restorePosition;
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
  ensureStyle(document);
  for (const host of [...declarations.keys()]) removeAnchor(host);

  for (const target of targets) {
    const declaration: AnchorDeclaration = {
      address: target.address,
      color: target.color,
      x: target.x ?? 0,
      y: target.y ?? 0,
      restorePosition: target.host.style.position,
      changedPosition:
        target.host.ownerDocument.defaultView?.getComputedStyle(target.host).position === "static",
    };
    declarations.set(target.host, declaration);
    applyDeclaration(target.host, declaration);
    const observer = new MutationObserver(() => applyDeclaration(target.host, declaration));
    observer.observe(target.host, {
      attributes: true,
      attributeFilter: [CAPTURE_MOTION_ANCHOR_ATTR, "style"],
    });
    observers.set(target.host, observer);
  }

  return {
    visible: targets.length > 0,
    count: targets.length,
    anchors: currentAnchors(document).map((host) => {
      const rect = host.getBoundingClientRect();
      const x = Number.parseFloat(host.style.getPropertyValue(X_PROP)) || 0;
      const y = Number.parseFloat(host.style.getPropertyValue(Y_PROP)) || 0;
      return {
        address: host.getAttribute(CAPTURE_MOTION_ANCHOR_ATTR) ?? "",
        color: host.style.getPropertyValue(COLOR_PROP),
        rect: { x: rect.x + x, y: rect.y + y, w: CAPTURE_MOTION_ANCHOR_SIZE, h: CAPTURE_MOTION_ANCHOR_SIZE },
      };
    }),
  };
}
