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
  if (typeof member.topologyPath !== "string" || member.topologyPath.length === 0) {
    fail(viewId, "has no public topology path");
  }
  if (pane.chromeAboveHost !== true) {
    fail(viewId, "chrome is not above its PaneSurfaceHost");
  }
  const paneRect = rect(pane.domFrame);
  const memberRect = rect(member.domFrame);
  if (!paneRect || !memberRect || member.nativeCount !== 1 || member.ok !== true) {
    fail(viewId, "has no live, exact PaneSurfaceHost member");
  }
  return {
    rect: {
      x: paneRect.x + memberRect.x,
      y: paneRect.y + memberRect.y,
      w: memberRect.w,
      h: memberRect.h,
    },
    topologyPath: member.topologyPath,
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
        live: true,
        visible: true,
        presented: true,
        rect: owner.rect,
      };
    }

    const owned = engineSurface({ viewId, surface, stats });
    if (owned.actual.hidden === true) fail(viewId, "owner is hidden");
    if (surface === "engine-windowed") {
      const owner = paneSurface({ viewId, label, paneComposition });
      return {
        viewId,
        surfaceId: String(owned.id),
        topologyPath: owner.topologyPath,
        live: true,
        visible: true,
        presented: owned.actual.composition != null,
        rect: owner.rect,
      };
    }
    if (surface === "engine-offscreen") {
      const bounds = rect(owned.actual.bounds);
      const presentation = rect(owned.actual.presentation);
      if (!bounds || !presentation || owned.actual.resize?.pending === true
          || owned.actual.viewport?.matches !== true) {
        fail(viewId, "offscreen owner has no settled exact presentation");
      }
      return {
        viewId,
        surfaceId: String(owned.id),
        live: true,
        visible: true,
        presented: true,
        rect: bounds,
      };
    }
    fail(viewId, `uses unsupported surface ${surface}`);
  });
}
