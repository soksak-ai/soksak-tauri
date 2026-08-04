export const CAPTURE_CALIBRATION_ID = "soksak-capture-calibration";
const CALIBRATION_COLOR = "#0000ff";
const CALIBRATION_ANCHORS = [
  { name: "top", top: "4px" },
  { name: "middle", top: "calc(50% - 20px)" },
  { name: "bottom", bottom: "4px" },
] as const;

function createRuler(anchor: (typeof CALIBRATION_ANCHORS)[number]): HTMLDivElement {
  const ruler = document.createElement("div");
  ruler.dataset.captureCalibrationAnchor = anchor.name;
  Object.assign(ruler.style, {
    position: "fixed",
    left: "4px",
    width: "64px",
    height: "40px",
    background: CALIBRATION_COLOR,
    pointerEvents: "none",
    zIndex: "2147483647",
    ...(anchor.name === "bottom" ? { bottom: anchor.bottom } : { top: anchor.top }),
  });
  return ruler;
}

/**
 * WindowServer가 transition 중 창 backing을 잘라 재투영해도 최소 한 기준자가 남도록,
 * native content hole이 없는 왼쪽 DOM rail의 상·중·하에 같은 64×40 기준자를 둔다.
 * 같은 visible 상태의 재적용은 DOM을 다시 만들지 않으며, 불완전한 기존 root는 복구한다.
 */
export function setCaptureCalibration(visible: boolean) {
  let root = document.getElementById(CAPTURE_CALIBRATION_ID) as HTMLDivElement | null;
  if (visible) {
    if (!root) {
      root = document.createElement("div");
      root.id = CAPTURE_CALIBRATION_ID;
      root.dataset.node = "capture-calibration";
      document.body.append(root);
    }
    const names = [...root.querySelectorAll<HTMLElement>("[data-capture-calibration-anchor]")]
      .map((el) => el.dataset.captureCalibrationAnchor);
    if (JSON.stringify(names) !== JSON.stringify(CALIBRATION_ANCHORS.map((anchor) => anchor.name))) {
      root.replaceChildren(...CALIBRATION_ANCHORS.map(createRuler));
    }
  } else if (root) {
    root.remove();
    root = null;
  }

  const rulers = root
    ? [...root.querySelectorAll<HTMLElement>("[data-capture-calibration-anchor]")]
    : [];
  const rects = rulers.map((ruler) => {
    const rect = ruler.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  return {
    visible: Boolean(root),
    color: CALIBRATION_COLOR,
    rect: rects[0] ?? null,
    rects,
  };
}
