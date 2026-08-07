/**
 * 표면 관측이 읽은 원장의 이름.
 *
 * slot·renderer 는 메인 문서 DOM 을 읽는다. surface 가 같은 DOM 을 한 번 더 읽으면 세 관측은
 * 한 숫자의 사본 셋이 되고, native 표면이 어디에 있든 1:1 판정이 통과한다. 어느 원장에서
 * 왔는지는 좌표와 함께 판정에 실린다 — 판정이 두 경우를 가를 축은 그것뿐이다.
 */
export const BROWSER_SURFACE_OBSERVATION_SOURCES = Object.freeze({
  domProjection: "dom-projection",
  paneMember: "appkit-pane-member",
  engineLedger: "engine-surface-ledger",
  contentViewHost: "content-view-host",
});

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
const displayed = (value) => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * 문서 밖 표면의 자리는 AppKit 장부가 소유한다.
 *
 * DOM 투영(domFrame)은 같은 자리를 **예측한** 값이다. 그것을 영수증에 옮겨 적으면 slot·renderer
 * 와 같은 숫자가 되고, 표면이 실제로 어긋난 순간에도 세 관측이 일치한다. 그래서 여기서 읽는
 * 것은 host nativeFrame + member nativeFrame 이고, 못 읽으면 rect 는 null 이다 — 예측값으로
 * 메우지 않는다.
 *
 * 공개 topology 문자열은 DOM 이 선언한다. native 로 등재된 member 라벨에 매이지 않으면 그
 * 문자열은 이 표면의 신원이 아니라 남의 것이므로, 이 원장은 그것을 보증하지 않는다(빈 신원).
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
  const paneNative = rect(pane.nativeFrame);
  const memberNative = rect(member.nativeFrame);
  const declared = typeof member.topologyPath === "string" ? member.topologyPath : "";
  const anchor = `/${encodeURIComponent(label)}`;
  return {
    rect: paneNative && memberNative
      ? {
        x: paneNative.x + memberNative.x,
        y: paneNative.y + memberNative.y,
        w: memberNative.w,
        h: memberNative.h,
      }
      : null,
    topologyPath: declared.endsWith(anchor) ? declared : "",
    chromeAboveHost: pane.chromeAboveHost === true,
    live: member.nativeCount === 1,
    exact: member.ok === true,
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
 * Maps one browser implementation's public owner facts into one surface receipt.
 * It never infers a native surface from an unrelated root DOM tree.
 *
 * 갈라지는 축은 프레임워크 이름이 아니라 프레임워크가 **선언한 능력**이다. 이름으로 가르면
 * 프레임워크가 하나 늘 때마다 갈래가 늘고, 새 이름은 판정면 어디에서도 자기 자리를 못 찾는다.
 */
function observeSurface({
  nativeChildWebview, surface, viewId, label, contentViews, paneComposition, stats,
}) {
  if (typeof nativeChildWebview !== "boolean") {
    fail(viewId, `has no declared nativeChildWebview provision (${displayed(nativeChildWebview)})`);
  }
  // 콘텐츠가 문서 안에 살면 자리의 자식이 곧 표면이다 — 그 선언을 네이티브 홀로 투영하지
  // 않으므로 네이티브 원장을 찾을 자리도 없다. 대신 호스트 자신의 살아 있는 표면 목록이 원장이다.
  if (!nativeChildWebview) {
    return {
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.contentViewHost,
      receipt: documentSurface({ viewId, label, contentViews }),
    };
  }

  if (surface === "framework-native") {
    const owner = paneSurface({ viewId, label, paneComposition });
    return {
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.paneMember,
      receipt: {
        viewId,
        surfaceId: label,
        topologyPath: owner.topologyPath,
        chromeAboveHost: owner.chromeAboveHost,
        live: owner.live,
        // 가시성의 주인은 pane composition 이 아니라 presentation trace 다(live && !hidden &&
        // alpha>0 을 pane·renderer·surface 셋에 대해 센다). 여기서 alpha 하나로 다시 세우면
        // 같은 이름의 더 약한 두 번째 정의가 생긴다 — 주인을 읽기 전까지 이 자리는 미측정이다.
        visible: true,
        presented: owner.exact,
        rect: owner.rect,
      },
    };
  }

  const owned = engineSurface({ viewId, surface, stats });
  if (surface === "engine-windowed") {
    const owner = paneSurface({ viewId, label, paneComposition });
    return {
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.paneMember,
      receipt: {
        viewId,
        surfaceId: String(owned.id),
        topologyPath: owner.topologyPath,
        chromeAboveHost: owner.chromeAboveHost,
        live: owner.live,
        // 엔진은 자기 surface 의 숨김을 스스로 답한다 — 그 답만 싣는다(pane 가시성은 미측정).
        visible: owned.actual.hidden !== true,
        presented: owner.exact && owned.actual.composition != null,
        rect: owner.rect,
      },
    };
  }
  // offscreen 은 PaneSurfaceHost 를 안 가지므로 형제 층 순서를 답할 주소가 없다. 여기서
  // 값을 지어내지 않는다 — 영수증에 그 사실이 빠진 채로 가고 judge 가 누락으로 이름 붙인다.
  if (surface === "engine-offscreen") {
    const bounds = rect(owned.actual.bounds);
    const presentation = rect(owned.actual.presentation);
    return {
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.engineLedger,
      receipt: {
        viewId,
        surfaceId: String(owned.id),
        live: true,
        visible: owned.actual.hidden !== true,
        presented: presentation != null
          && owned.actual.resize?.pending !== true
          && owned.actual.viewport?.matches === true,
        rect: bounds,
      },
    };
  }
  return fail(viewId, `uses unsupported surface ${surface}`);
}

/** 이 원장이 스스로 적은 표본 시각. 안 적는 원장은 null 이다 — 모름을 아는 값으로 바꾸지 않는다. */
function sampledAt(source, { paneComposition, contentViews }) {
  const raw = source === BROWSER_SURFACE_OBSERVATION_SOURCES.paneMember
    ? paneComposition?.sampledAtUnixMs
    : source === BROWSER_SURFACE_OBSERVATION_SOURCES.contentViewHost
      ? contentViews?.sampledAtUnixMs
      : null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * 한 브라우저 구현의 살아 있는 표면 원장을 읽고, **무엇을 읽었는지**·언제 그 원장이 스스로를
 * 표본했는지·뷰별 영수증을 함께 낸다. 좌표만 내면 받는 쪽은 그 숫자가 어느 관측에서 왔는지
 * 알 수 없고, 그러면 세 관측의 일치는 증명이 아니라 우연과 구분되지 않는다.
 */
export function browserSurfaceObservation({
  nativeChildWebview,
  surface,
  viewIds,
  labels,
  contentViews,
  paneComposition,
  stats,
}) {
  const observed = viewIds.map((viewId, index) => observeSurface({
    nativeChildWebview,
    surface,
    viewId,
    label: labels[index],
    contentViews,
    paneComposition,
    stats,
  }));
  const sources = [...new Set(observed.map((item) => item.source))];
  if (sources.length !== 1) {
    fail(viewIds[0] ?? "browser", `mixes surface observation ledgers (${sources.join(",")})`);
  }
  return {
    source: sources[0],
    sampledAtUnixMs: sampledAt(sources[0], { paneComposition, contentViews }),
    receipts: observed.map((item) => item.receipt),
  };
}

export function mapBrowserSurfaceRects(input) {
  return browserSurfaceObservation(input).receipts;
}
