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

const displayed = (value) => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

/**
 * 콘텐츠가 문서 안에 사는 프레임워크의 표면 원장은 content view host 자신의 목록이다.
 *
 * 자리(slot) 노드를 표면이라 부르면 표면이 통째로 사라져도 1:1 이 통과한다 — 자리는 표면보다
 * 오래 살기 때문이다. 그래서 여기서 읽는 것은 호스트가 자기 속성으로 열거한 살아 있는 표면이고,
 * 그 표면이 스스로 밝힌 선언에서 뷰와 위상 주소를 얻는다. label 문법에서 뷰를 뽑지 않는다.
 */
const documentSurface = ({ viewId, label, contentViews }) => {
  const candidates = (contentViews?.dom ?? []).filter((fact) => fact?.label === label);
  if (candidates.length !== 1) {
    fail(viewId, `must have exactly one live content surface (${candidates.length})`);
  }
  const fact = candidates[0];
  const composition = fact.composition ?? null;
  if (composition?.viewId !== viewId || !composition.topologyPath) {
    fail(viewId, `declares no composition owner (${JSON.stringify(composition)})`);
  }
  // 자리 밖에 있는 표면은 좌표로 밀리고 있다는 뜻이다 — 자리와 표면이 두 기준이 되고
  // 하나는 반드시 늦는다.
  if (fact.slotLabel !== label) fail(viewId, "is detached from its declared slot");
  // 선언은 호스트가 마지막으로 손댄 순간의 값이다. 그 뒤에 자리가 접혔을 수 있으므로 실제
  // 합성 사실과 함께 본다 — 도장 하나로는 접힌 표면이 스스로 보인다고 말할 수 있다.
  if (composition.visible !== true) fail(viewId, "is not declared visible");
  if (fact.computedVisibility === "hidden") fail(viewId, "is not composited");
  const frame = rect(fact.rect);
  if (!frame) fail(viewId, "has no live frame");
  return {
    viewId,
    surfaceId: label,
    topologyPath: composition.topologyPath,
    live: true,
    visible: true,
    presented: true,
    rect: frame,
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
 *
 * 갈라지는 축은 프레임워크 이름이 아니라 프레임워크가 **선언한 능력**이다. 이름으로 가르면
 * 프레임워크가 하나 늘 때마다 갈래가 늘고, 새 이름은 판정면 어디에서도 자기 자리를 못 찾는다.
 */
export function mapBrowserSurfaceRects({
  nativeChildWebview,
  surface,
  viewIds,
  labels,
  contentViews,
  paneComposition,
  stats,
}) {
  return viewIds.map((viewId, index) => {
    const label = labels[index];
    if (typeof nativeChildWebview !== "boolean") {
      fail(viewId, `has no declared nativeChildWebview provision (${displayed(nativeChildWebview)})`);
    }
    // 콘텐츠가 문서 안에 살면 자리의 자식이 곧 표면이다 — 그 선언을 네이티브 홀로 투영하지
    // 않으므로 네이티브 원장을 찾을 자리도 없다.
    if (!nativeChildWebview) return documentSurface({ viewId, label, contentViews });

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
