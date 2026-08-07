// Electron display-coordinate adapter.
//
// Electron의 screen 변환 지원 범위는 플랫폼마다 다르다. 특히 dipToScreenRect는 Windows
// 전용이고 Wayland는 전역 좌표 변환을 지원하지 않는다. 따라서 전역 DIP * scaleFactor를
// 보편적인 screen physical 좌표라고 부르지 않고, 방법과 좌표 공간을 결과에 함께 싣는다.

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rect(value, name = "rect") {
  const result = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (!Object.values(result).every(Number.isFinite) || result.width < 0 || result.height < 0) {
    throw namedError("INVALID_DISPLAY_RECT", `${name}가 유효하지 않다: ${JSON.stringify(value)}`);
  }
  return result;
}

function size(value, name = "size") {
  const result = { width: Number(value?.width), height: Number(value?.height) };
  if (!Object.values(result).every(Number.isFinite) || result.width <= 0 || result.height <= 0) {
    throw namedError("INVALID_DISPLAY_SIZE", `${name}가 유효하지 않다: ${JSON.stringify(value)}`);
  }
  return result;
}

function edgeScaledRect(value, scaleFactor) {
  const input = rect(value);
  const left = Math.round(input.x * scaleFactor);
  const top = Math.round(input.y * scaleFactor);
  const right = Math.round((input.x + input.width) * scaleFactor);
  const bottom = Math.round((input.y + input.height) * scaleFactor);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function displaySnapshot(display) {
  const scaleFactor = Number(display?.scaleFactor);
  if (!(Number.isFinite(scaleFactor) && scaleFactor > 0)) {
    throw namedError("INVALID_SCALE_FACTOR", `display scaleFactor가 유효하지 않다: ${scaleFactor}`);
  }
  return {
    id: display?.id ?? null,
    scaleFactor,
    boundsDip: rect(display?.bounds, "display bounds"),
  };
}

function createDisplayGeometry({
  screen,
  platform = process.platform,
  sessionType = process.env.XDG_SESSION_TYPE ?? "",
} = {}) {
  // 계약은 그대로다 — screen 이 이 능력을 답해야 한다. 다만 **만들 때** 확인하면 app 'ready'
  // 전에 그 모듈을 만지게 되고, Electron 은 그 순간 던진다(실측 2026-08-08: 앱이 적재조차 못 해
  // 인수의 절반이 통째로 측정 불가였다). 확인은 실제로 쓰는 자리에서 한다.
  const requireScreen = () => {
    if (!screen || typeof screen.getDisplayMatching !== "function") {
      throw new TypeError("Electron screen.getDisplayMatching이 필요하다");
    }
    return screen;
  };
  const normalizedPlatform = String(platform);
  const wayland = normalizedPlatform === "linux" && String(sessionType).toLowerCase() === "wayland";

  function snapshot(win, bounds = win?.getBounds?.()) {
    const dip = rect(bounds, "window bounds");
    return displaySnapshot(requireScreen().getDisplayMatching(dip));
  }

  function rectToPhysical(win, dipRect, display) {
    const input = rect(dipRect);
    if (normalizedPlatform === "win32") {
      if (typeof requireScreen().dipToScreenRect !== "function") {
        throw namedError(
          "SCREEN_RECT_CONVERSION_UNAVAILABLE",
          "Windows screen physical 변환에 screen.dipToScreenRect가 없다",
        );
      }
      return {
        coordinateSpace: "screen-physical",
        method: "electron.screen.dipToScreenRect",
        rect: rect(requireScreen().dipToScreenRect(win ?? null, input), "screen physical rect"),
      };
    }

    if (normalizedPlatform === "darwin") {
      const bounds = rect(display?.boundsDip, "display bounds");
      return {
        coordinateSpace: "display-local-physical",
        method: "display-local-edge-rounding",
        rect: edgeScaledRect({
          x: input.x - bounds.x,
          y: input.y - bounds.y,
          width: input.width,
          height: input.height,
        }, Number(display.scaleFactor)),
      };
    }

    if (normalizedPlatform === "linux" && !wayland && typeof requireScreen().dipToScreenPoint === "function") {
      const topLeft = requireScreen().dipToScreenPoint({ x: input.x, y: input.y });
      const bottomRight = requireScreen().dipToScreenPoint({
        x: input.x + input.width,
        y: input.y + input.height,
      });
      return {
        coordinateSpace: "screen-physical",
        method: "electron.screen.dipToScreenPoint-edges",
        rect: {
          x: Number(topLeft.x),
          y: Number(topLeft.y),
          width: Number(bottomRight.x) - Number(topLeft.x),
          height: Number(bottomRight.y) - Number(topLeft.y),
        },
      };
    }

    return {
      coordinateSpace: "unavailable",
      method: wayland ? "unsupported-wayland" : `unsupported-${normalizedPlatform}`,
      rect: null,
    };
  }

  function physicalSizeToDip(value, display) {
    const physical = size(value, "physical size");
    const scaleFactor = Number(display?.scaleFactor);
    if (!(Number.isFinite(scaleFactor) && scaleFactor > 0)) {
      throw namedError("INVALID_SCALE_FACTOR", `display scaleFactor가 유효하지 않다: ${scaleFactor}`);
    }
    return {
      width: Math.round(physical.width / scaleFactor),
      height: Math.round(physical.height / scaleFactor),
    };
  }

  return {
    platform: normalizedPlatform,
    snapshot,
    rectToPhysical,
    physicalSizeToDip,
  };
}

module.exports = { createDisplayGeometry, edgeScaledRect };
