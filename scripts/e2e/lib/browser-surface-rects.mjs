const rect = (value) => {
  const result = {
    x: Number(value?.x),
    y: Number(value?.y),
    w: Number(value?.w),
    h: Number(value?.h),
  };
  if (![result.x, result.y, result.w, result.h].every(Number.isFinite)
      || result.w <= 0 || result.h <= 0) return null;
  return result;
};

const fail = (viewId, detail) => {
  throw new Error(`${viewId}: browser surface evidence ${detail}`);
};

/**
 * 소유자를 못 찾는 것과 소유자가 계약을 어긴 것은 다른 사실이다.
 *
 * 못 찾는 것(주소·창·응답 부재)은 잴 수 없으므로 던진다 — blocked 가 옳다. 어긴 것(chrome 이
 * host 위가 아니다, topology 신원이 없다, 멤버가 정확하지 않다, 호스트가 투명하다)은 잰 값이므로
 * 영수증에 실어 judge 가 이름 붙인 RED 를 내게 한다. 던져서 지우면 그 위반은 보고서에서 이름을
 * 잃고, 41개 런 전수에서 그랬듯 판정은 한 번도 돌지 못한다.
 */
const paneSurface = ({ viewId, label, paneComposition }) => {
  const candidates = (paneComposition?.matches ?? []).flatMap((pane) =>
    (pane.memberMatches ?? [])
      .filter((member) => member.label === label)
      .map((member) => ({ pane, member })));
  if (candidates.length !== 1) fail(viewId, `must have exactly one PaneSurfaceHost owner (${candidates.length})`);
  const { pane, member } = candidates[0];
  if (pane.viewId !== viewId) {
    fail(viewId, `PaneSurfaceHost owner view mismatch (${String(pane.viewId)})`);
  }
  const paneRect = rect(pane.domFrame);
  const memberRect = rect(member.domFrame);
  return {
    rect: paneRect && memberRect
      ? {
        x: paneRect.x + memberRect.x,
        y: paneRect.y + memberRect.y,
        w: memberRect.w,
        h: memberRect.h,
      }
      : null,
    topologyPath: typeof member.topologyPath === "string" ? member.topologyPath : "",
    chromeAboveHost: pane.chromeAboveHost === true,
    live: member.nativeCount === 1,
    visible: Number(pane.alpha) > 0,
    exact: member.ok === true,
  };
};

const engineSurface = ({ viewId, surface, stats }) => {
  const offscreen = surface === "engine-offscreen";
  const engine = offscreen ? stats?.engine : stats;
  const mapping = offscreen
    ? (stats?.ids ?? []).find((item) => item?.viewId === viewId)?.surfaceId
    : stats?.idMap?.[`chromium-${viewId}`];
  const id = Number(mapping);
  const candidates = (engine?.surfaces ?? []).filter((item) => Number(item?.id) === id);
  if (!Number.isFinite(id) || candidates.length !== 1 || !(engine?.ids ?? []).map(Number).includes(id)) {
    fail(viewId, "has no unique live engine owner");
  }
  return { id, actual: candidates[0] };
};

/**
 * Maps each browser implementation's public owner facts into one B09 surface receipt.
 * It never infers a native surface from an unrelated root DOM tree.
 */
export function mapBrowserSurfaceRects({
  framework,
  surface,
  viewIds,
  labels,
  uiNodes = [],
  paneComposition,
  stats,
}) {
  return viewIds.map((viewId, index) => {
    const label = labels[index];
    if (framework === "electron") {
      const candidates = uiNodes.filter((node) =>
        node?.nodePath === "surface"
        && typeof node.address === "string"
        && node.address.includes(`/tab/${viewId}/`)
        && rect(node.rect));
      if (candidates.length !== 1) fail(viewId, `must expose exactly one DOM surface (${candidates.length})`);
      return {
        viewId,
        surfaceId: candidates[0].address,
        live: true,
        visible: true,
        presented: true,
        rect: rect(candidates[0].rect),
      };
    }

    if (framework !== "tauri") fail(viewId, `uses unsupported framework ${framework}`);
    if (surface === "framework-native") {
      const owner = paneSurface({ viewId, label, paneComposition });
      return {
        viewId,
        surfaceId: label,
        topologyPath: owner.topologyPath,
        chromeAboveHost: owner.chromeAboveHost,
        live: owner.live,
        visible: owner.visible,
        presented: owner.exact,
        rect: owner.rect,
      };
    }

    const owned = engineSurface({ viewId, surface, stats });
    if (surface === "engine-windowed") {
      const owner = paneSurface({ viewId, label, paneComposition });
      return {
        viewId,
        surfaceId: String(owned.id),
        topologyPath: owner.topologyPath,
        chromeAboveHost: owner.chromeAboveHost,
        live: owner.live,
        visible: owner.visible && owned.actual.hidden !== true,
        presented: owner.exact && owned.actual.composition != null,
        rect: owner.rect,
      };
    }
    // offscreen 은 PaneSurfaceHost 를 안 가지므로 형제 층 순서를 답할 주소가 없다. 여기서
    // 값을 지어내지 않는다 — 영수증에 그 사실이 빠진 채로 가고 judge 가 누락으로 이름 붙인다.
    if (surface === "engine-offscreen") {
      const bounds = rect(owned.actual.bounds);
      const presentation = rect(owned.actual.presentation);
      return {
        viewId,
        surfaceId: String(owned.id),
        live: true,
        visible: owned.actual.hidden !== true,
        presented: presentation != null
          && owned.actual.resize?.pending !== true
          && owned.actual.viewport?.matches === true,
        rect: bounds,
      };
    }
    fail(viewId, `uses unsupported surface ${surface}`);
  });
}
