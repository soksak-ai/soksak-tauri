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

/**
 * presenter-local 원점의 기준 — 이 표면을 품은 pane host 가 창의 어디에 앉았는가.
 *
 * 표면이 자기 자리를 presenter 기준으로 답했으면, 자리(slot)와 같은 축이 되려면 그 presenter 의
 * 창 좌표를 더해야 한다. 그 값은 AppKit 장부가 소유하므로 여기서 지어내지 않는다 — 못 읽으면
 * null 이고, 그러면 좌표는 없는 것이지 0 에서 시작하는 것이 아니다.
 */
const presenterOrigin = ({ viewId, label, paneComposition }) => {
  const candidates = (paneComposition?.matches ?? []).filter((pane) =>
    pane?.viewId === viewId
    && (pane.memberMatches ?? []).some((member) => member?.label === label));
  return candidates.length === 1 ? rect(candidates[0].nativeFrame) : null;
};

/**
 * 표면이 답한 자리를 자리(slot)와 같은 축으로 세운다.
 *
 * 두 축을 그냥 맞대면 판정은 좌표계 차이를 합성 결함으로 읽는다(실측: 표면이 presenter 를
 * 원점으로 답한 y=28 과 자리의 창 좌표 y=149 가 121 만큼 어긋났고, 그 121 은 presenter 가 창
 * 안에 앉은 자리였다). 문턱으로 덮지 않는다 — 축을 같게 만들거나, 못 만들면 답하지 않는다.
 *
 * 세 갈래를 이름으로 가른다. 원점을 안 밝혔거나 모르는 원점이면 **잰 계약 위반**이라 rect 는
 * null 로 남고 judge 가 이름 붙인다. 밝힌 원점을 창 축으로 옮길 장부가 답하지 않으면 **못 잰**
 * 것이라 여기서 던진다 — blocked 는 red 와 다른 사실이다.
 */
const windowFrameOf = ({ viewId, label, owner, paneComposition }) => {
  const frame = rect(owner.frame);
  const space = owner.coordinateSpace;
  if (frame === null || space?.logical !== "css-px") return null;
  if (space.origin === "window-absolute") return frame;
  if (space.origin !== "presenter-local") return null;
  const origin = presenterOrigin({ viewId, label, paneComposition });
  if (origin === null) {
    fail(viewId, `declares a ${space.origin} frame with no readable presenter origin`);
  }
  return { x: origin.x + frame.x, y: origin.y + frame.y, w: frame.w, h: frame.h };
};

/**
 * 표면을 앉힌 원장이 스스로 밝힌 신원과 자리.
 *
 * 주소는 이 표면의 라벨에 매인 것만 받는다 — 매이지 않은 문자열은 이 표면의 신원이 아니라
 * 남의 것이므로 빈 신원이다.
 */
const declaredSurface = ({ viewId, label, stats, paneComposition }) => {
  const declared = (stats?.surfaces ?? []).filter((item) => item?.viewId === viewId);
  if (declared.length !== 1) {
    fail(viewId, `must have exactly one declared surface identity (${declared.length})`);
  }
  const owner = declared[0];
  const anchor = `/${encodeURIComponent(label)}`;
  const path = typeof owner.topologyPath === "string" ? owner.topologyPath : "";
  return {
    topologyPath: path.endsWith(anchor) ? path : "",
    rect: windowFrameOf({ viewId, label, owner, paneComposition }),
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
  // 문서 밖 offscreen 표면의 신원과 자리는 그 표면을 앉힌 원장이 스스로 답한다. 여기서
  // 만들지 않는다 — 판정면이 자리(slot)와 같은 공식으로 주소를 채우면 셋은 한 공식의 사본이
  // 되고, 표면이 엉뚱한 라벨에 붙은 날에도 1:1 이 통과한다.
  if (surface === "engine-offscreen") {
    const owner = declaredSurface({ viewId, label, stats, paneComposition });
    const presentation = rect(owned.actual.presentation);
    return {
      source: BROWSER_SURFACE_OBSERVATION_SOURCES.engineLedger,
      receipt: {
        viewId,
        surfaceId: String(owned.id),
        topologyPath: owner.topologyPath,
        live: true,
        visible: owned.actual.hidden !== true,
        presented: presentation != null
          && owned.actual.resize?.pending !== true
          && owned.actual.viewport?.matches === true,
        rect: owner.rect,
      },
    };
  }
  return fail(viewId, `uses unsupported surface ${surface}`);
}

/** 이 원장이 스스로 적은 표본 시각. 안 적는 원장은 null 이다 — 모름을 아는 값으로 바꾸지 않는다. */
function sampledAt(source, { paneComposition, contentViews, stats }) {
  const raw = source === BROWSER_SURFACE_OBSERVATION_SOURCES.paneMember
    ? paneComposition?.sampledAtUnixMs
    : source === BROWSER_SURFACE_OBSERVATION_SOURCES.contentViewHost
      ? contentViews?.sampledAtUnixMs
      : source === BROWSER_SURFACE_OBSERVATION_SOURCES.engineLedger
        ? stats?.sampledAtUnixMs
        : null;
  // Number(null) 은 0 이고, 그 0 은 정착보다 이른 시각으로 읽힌다 — 안 잰 것이 잰 위반이 된다.
  if (raw === null || raw === undefined) return null;
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
    sampledAtUnixMs: sampledAt(sources[0], { paneComposition, contentViews, stats }),
    receipts: observed.map((item) => item.receipt),
  };
}

export function mapBrowserSurfaceRects(input) {
  return browserSurfaceObservation(input).receipts;
}
