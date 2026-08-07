import { mapWithWiring } from "./browser-machine-judge-support.mjs";

/**
 * @param {unknown} value 탭이 자기 안에서 답한 사실
 * @param {unknown} focus 창이 답한 포커스 소유(`ui.focus.state`) — 탭이 아니라 창의 사실이다
 */
export function mapImeObservation(value, focus = null) {
  return {
    value: value?.value ?? null,
    active: value?.active ?? null,
    // 못 물어본 것과 "소유자가 없다" 는 다른 답이다 — 안 답했으면 이 자리를 비운다.
    inputFocus: focus == null ? undefined : {
      // 창이 답하는 이름은 activeTabId 다 — activeElement 는 그 안의 요소 모양만 답한다.
      // 필드를 지어내면 두 탭이 나란히 null 을 답하고 판정은 "아무도 안 밝혔다" 로 읽는다.
      owner: focus?.activeTabId ?? null,
      // 이 관측이 어느 탭에서 났는지는 부르는 쪽이 안다 — 창은 "지금 누가 쥐었나" 만 답한다.
      self: focus?.activeTabId != null && focus.activeTabId === (value?.tabId ?? null),
    },
    ledger: {
      beforeInput: value?.ledger?.beforeInput ?? null,
      inputEvents: value?.ledger?.inputEvents ?? null,
      values: Array.isArray(value?.ledger?.values) ? [...value.ledger.values] : null,
    },
  };
}

function publicNodeRole(nodePath) {
  if (typeof nodePath !== "string" || nodePath.length === 0) return null;
  const parts = nodePath.split("/").filter(Boolean);
  return parts.at(-1) ?? null;
}

/**
 * 한 번의 실제 항해를 공개 영수증만으로 옮긴다.
 *
 * 관측이 도중에 실패해도 던지지 않는다. 실패 사실은 observation.error 로 실려 judge 가 RED 로
 * 판정하고 보고서에 이름으로 남는다 — 못 잰 것과 재서 어긋난 것은 둘 다 이름이 있어야 한다.
 */
export function mapB01NavigationEvidence(raw = {}) {
  return mapWithWiring(raw, "B01.navigation", (checkpoint) => {
    const requestedViewId = checkpoint.take("requestedViewId") ?? null;
    const navigateReceipt = checkpoint.take("navigateReceipt");
    const urlbarMeasure = checkpoint.take("urlbarMeasure");
    const pageIdentity = checkpoint.take("pageIdentity");
    const observationError = checkpoint.take("observationError") ?? null;
    return {
      url: checkpoint.take("url") ?? null,
      expectedTitle: checkpoint.take("expectedTitle") ?? null,
      expectedBodyIncludes: checkpoint.take("expectedBodyIncludes") ?? null,
      requestedViewId,
      returnedViewId: navigateReceipt?.viewId ?? navigateReceipt?.tabId ?? null,
      toolbarAddress: {
        // data-node는 plugin-view namespace를 포함한 발견 경로다. B01은 그 공개 경로의
        // 마지막 semantic segment가 정확히 urlbar인지 판정한다; private selector나
        // 요청 URL에서 역할을 지어내지 않는다.
        dataNode: publicNodeRole(urlbarMeasure?.dataset?.node),
        value: urlbarMeasure?.value ?? null,
      },
      pageIdentity: {
        url: pageIdentity?.url ?? null,
        title: pageIdentity?.title ?? null,
        bodyText: pageIdentity?.bodyText ?? null,
      },
      observation: { error: observationError },
    };
  });
}

export function mapB01TabEvidence(raw = {}) {
  return mapWithWiring(raw, "B01.tab", (checkpoint) => {
    const mountReceipt = checkpoint.take("mountReceipt");
    const navigations = checkpoint.take("navigations");
    return {
      viewId: checkpoint.take("viewId") ?? null,
      expectedUrl: checkpoint.take("expectedUrl") ?? null,
      mounted: mountReceipt?.mounted ?? null,
      navigations: Array.isArray(navigations) ? [...navigations] : null,
    };
  });
}

