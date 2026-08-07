const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);

/**
 * ui.hit 이 답한 선언 소유자 사슬. 이 사슬이 층 순서의 유일한 입력이다 — dataset·host·painters
 * 를 하니스 규칙으로 이어붙이지 않는다. 명령이 사슬을 답하지 않으면 비어 있다.
 */
export function deriveHitOwners(hit) {
  const owners = Array.isArray(hit?.owners) ? hit.owners : [];
  const seen = new Set();
  const chain = [];
  for (const value of owners) {
    const owner = text(value);
    if (owner === null || seen.has(owner)) continue;
    seen.add(owner);
    chain.push(owner);
  }
  return chain;
}

/**
 * ui.measure 한 장을 chrome 조작면 사실로 옮긴다.
 *
 * 도달 불가와 낮은 평면은 계약 위반이지 측정 실패가 아니다. 여기서 던지면 그 사실이 blocked 로
 * 사라지고 보고서에 이름이 남지 않는다. 값으로 실어 judge 가 이름 붙이게 한다.
 * `planeSource` 는 평면 번호를 답하는 노드 — modal 은 card 의 도달성과 root 의 평면이 짝이다.
 */
export function deriveChromeControl(measured, planeSource = measured) {
  const planeZ = Number(planeSource?.style?.zIndex);
  return {
    reachable: measured?.occlusion?.reachable === true,
    planeZ: Number.isFinite(planeZ) ? planeZ : null,
  };
}

/**
 * 한 표본의 층 순서를 명령 응답에서 파생한다.
 *
 * chrome 층은 ui.hit 이 답한 소유자 사슬이고, 그 아래 native 층은 surface 영수증의 실측
 * `chromeAboveHost` 가 "chrome 이 위"라고 답했을 때만 쌓는다. 아니라고 답하면 층을 쌓지 않는다 —
 * 없는 순서를 적는 대신 stack 이 짧아지고 judge 가 그 사실에 이름을 붙인다.
 */
export function buildB09Sample({
  target,
  relation,
  chromeRect,
  chromeControl,
  nativeSurface,
  point,
  hit,
}) {
  const owners = deriveHitOwners(hit);
  const stack = owners.map((owner) => ({ kind: "chrome", owner, surfaceId: null }));
  if (nativeSurface?.chromeAboveHost === true) {
    stack.push({
      kind: "native-surface",
      owner: nativeSurface.viewId ?? null,
      surfaceId: nativeSurface.surfaceId ?? null,
    });
  }
  return {
    target,
    relation,
    chromeRect,
    chromeControl,
    nativeSurface,
    hit: { point, topmostOwner: owners[0] ?? null, stack },
  };
}

/** chrome rect 와 surface rect 의 교집합. 음의 넓이는 0 으로 눕힌다(좌표는 그대로). */
export function overlapOf(chromeRect, surfaceRect) {
  const left = Math.max(chromeRect.x, surfaceRect.x);
  const top = Math.max(chromeRect.y, surfaceRect.y);
  const right = Math.min(chromeRect.x + chromeRect.w, surfaceRect.x + surfaceRect.w);
  const bottom = Math.min(chromeRect.y + chromeRect.h, surfaceRect.y + surfaceRect.h);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/**
 * chrome rect 와 가장 크게 겹치는 surface 를 고른다. 겹치는 것이 없어도 비교 대상은 남긴다 —
 * "겹칠 surface 가 없다"는 던져서 지울 사실이 아니라 영수증에 좌표로 남길 사실이다.
 * 후보가 아예 없을 때만 null 이다(측정 대상 부재).
 */
export function pickOverlapSurface(chromeRect, surfaces) {
  let best = null;
  let bestArea = -1;
  for (const surface of surfaces ?? []) {
    const rect = surface?.rect;
    const area = rect ? (() => {
      const overlap = overlapOf(chromeRect, rect);
      return overlap.w * overlap.h;
    })() : 0;
    if (area > bestArea) {
      best = surface;
      bestArea = area;
    }
  }
  return best;
}

/**
 * 히트를 넣을 점. 겹침이 있으면 그 중심, 없으면 chrome 중심 — 어느 쪽이든 chrome rect 안이라
 * anchor 선언이 노드 밖으로 나가지 않는다. 겹침 부재는 judge 가 좌표로 판정한다.
 */
export function probePointFor(chromeRect, surfaceRect) {
  const overlap = surfaceRect ? overlapOf(chromeRect, surfaceRect) : null;
  const source = overlap && overlap.w > 0 && overlap.h > 0 ? overlap : chromeRect;
  return {
    x: Math.round(source.x + source.w / 2),
    y: Math.round(source.y + source.h / 2),
  };
}
