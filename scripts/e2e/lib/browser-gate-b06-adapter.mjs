// 어댑터가 브라우저 표면에 통과시키는 빛 — B06 의 "이중 감광 없음" 축을 재는 자리.
//
// 조명은 작업면 평면 하나가 소유한다. 어댑터가 자기 표면을 한 번 더 어둡게 하면 같은 화면이
// 두 번 감광되는데, 그 사실은 **픽셀을 소유한 장부**에만 있다:
//
//   pane-host         프레임워크가 문서 밖 pane host 로 합성한다 → webview.pane.composition 의 alpha
//   engine-surface    엔진이 문서 밖 자기 표면으로 합성한다     → webview.surfaces 의 engine.surfaces
//   content-view-dom  표면이 문서 안에 산다                     → webview.surfaces 의 contentViews.dom
//
// 근거는 프레임워크 이름이 아니라 선언된 능력(framework.provision 의 nativeChildWebview)과
// 엔진의 합성 축(browser-matrix 의 surface)에서 나온다. 못 읽으면 null 이다 — 상수 1 을 쓰면
// 이 축은 무엇이 걸려 있어도 영원히 통과한다(실사고: 하니스가 답을 대신 썼다).

export const ADAPTER_ALPHA_BASES = Object.freeze(["pane-host", "engine-surface", "content-view-dom"]);

const PANE_HOST_SURFACES = new Set(["framework-native", "engine-windowed"]);
const ENGINE_SURFACES = new Set(["engine-offscreen"]);

/** 이 (능력 × 합성축) 조합에서 alpha 를 든 장부의 이름. 모르면 null — 아무 장부나 고르지 않는다. */
export function adapterAlphaBasis({ nativeChildWebview, surface }) {
  if (typeof surface !== "string" || surface === "") return null;
  if (nativeChildWebview === false) return "content-view-dom";
  if (nativeChildWebview !== true) return null;
  if (PANE_HOST_SURFACES.has(surface)) return "pane-host";
  if (ENGINE_SURFACES.has(surface)) return "engine-surface";
  return null;
}

const unit = (value) => (Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);

const amount = (raw) => {
  if (raw == null) return null;
  const text = String(raw).trim();
  const percent = text.endsWith("%");
  const parsed = Number.parseFloat(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed)) return null;
  return percent ? parsed / 100 : parsed;
};

/**
 * filter 선언이 통과시키는 빛의 비율.
 *
 * 베일은 검은색이라 alpha 와 brightness 는 같은 축이다 — 둘 다 "원래 빛의 몇 할이 남는가"다.
 * 모르는 함수가 하나라도 있으면 null 이다: 흐림이 아닌 필터를 1 로 읽으면 판정이 거짓이 된다.
 */
export function filterTransmission(filter) {
  if (typeof filter !== "string") return null;
  const text = filter.trim();
  if (text === "") return null;
  if (text === "none") return 1;
  const calls = [...text.matchAll(/([a-zA-Z-]+)\(([^)]*)\)/g)];
  if (calls.length === 0) return null;
  let transmission = 1;
  let consumed = 0;
  for (const [whole, name, argument] of calls) {
    consumed += whole.length;
    if (name !== "brightness" && name !== "opacity" && name !== "grayscale") return null;
    if (name === "grayscale") continue; // 명도를 바꾸지 않는다.
    const value = amount(argument);
    if (value === null || value < 0) return null;
    transmission *= value;
  }
  // 함수 밖에 남은 토큰(url(...) 뒤 이름 없는 선언 등)이 있으면 다 읽은 것이 아니다.
  if (text.replace(/\s+/g, "").length !== consumed) return null;
  return unit(transmission);
}

function paneHostAlpha(paneComposition, label) {
  const matches = (paneComposition?.matches ?? []).filter((match) =>
    (match?.memberMatches ?? []).some((member) => member?.label === label));
  if (matches.length !== 1) return null;
  return unit(Number(matches[0].alpha));
}

function engineSurfaceAlpha(surfaces, label) {
  const owned = (surfaces?.engine?.surfaces ?? []).filter((surface) => surface?.label === label);
  if (owned.length !== 1) return null;
  // 조상까지 곱한 값이 화면의 사실이다. 그 칸이 없는 실행물은 못 읽은 것이다 — 표면 자신의
  // 선언(alpha)으로 대신하면 조상이 건 감광이 통째로 안 보인다.
  return unit(Number(owned[0].effectiveAlpha));
}

function contentViewDomAlpha(surfaces, label) {
  const owned = (surfaces?.contentViews?.dom ?? []).filter((fact) => fact?.label === label);
  if (owned.length !== 1) return null;
  const opacity = amount(owned[0].opacity);
  const transmission = filterTransmission(owned[0].filter);
  if (opacity === null || transmission === null) return null;
  return unit(opacity * transmission);
}

/** 지목한 장부에서 이 표면의 투과율을 읽는다. 장부·이름·값 중 하나라도 없으면 null. */
export function readAdapterAlpha({ basis, label, paneComposition = null, surfaces = null }) {
  if (typeof label !== "string" || label === "") return null;
  if (basis === "pane-host") return paneHostAlpha(paneComposition, label);
  if (basis === "engine-surface") return engineSurfaceAlpha(surfaces, label);
  if (basis === "content-view-dom") return contentViewDomAlpha(surfaces, label);
  return null;
}
