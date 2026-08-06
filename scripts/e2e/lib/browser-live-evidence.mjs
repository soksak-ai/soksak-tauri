export function mapImeObservation(value) {
  return {
    value: value?.value ?? null,
    active: value?.active ?? null,
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

export function mapB01TabEvidence({
  viewId,
  expectedUrl,
  mountReceipt,
  urlbarMeasure,
  pageIdentity,
  navigateReceipt,
}) {
  return {
    viewId,
    expectedUrl,
    mounted: mountReceipt?.mounted ?? null,
    toolbarAddress: {
      // data-node는 plugin-view namespace를 포함한 발견 경로다. B01은 그 공개 경로의
      // 마지막 semantic segment가 정확히 urlbar인지 판정한다; private selector나
      // 요청 URL에서 역할을 지어내지 않는다.
      dataNode: publicNodeRole(urlbarMeasure?.dataset?.node),
      value: urlbarMeasure?.value ?? null,
    },
    pageIdentity: {
      viewId: pageIdentity?.viewId ?? null,
      url: pageIdentity?.url ?? null,
    },
    commandReceipt: {
      requestedViewId: viewId,
      returnedViewId: navigateReceipt?.viewId ?? navigateReceipt?.tabId ?? null,
    },
  };
}

function page(value) {
  return {
    scrollX: value?.x ?? value?.scrollX ?? null,
    scrollY: value?.y ?? value?.scrollY ?? null,
    viewportWidth: value?.viewport?.w ?? null,
    viewportHeight: value?.viewport?.h ?? null,
    documentWidth: value?.document?.w ?? null,
    documentHeight: value?.document?.h ?? null,
  };
}

export function mapB11TabEvidence({ viewId, scroll, fullCapture }) {
  return {
    viewId,
    wheel: {
      positions: [scroll?.beforeY ?? null, scroll?.afterY ?? null, scroll?.restoredY ?? null],
    },
    capture: {
      before: page(fullCapture?.before),
      receipt: {
        requestedViewId: viewId,
        returnedViewId: fullCapture?.viewId ?? null,
        requestedPath: fullCapture?.requestedPath ?? null,
        returnedPath: fullCapture?.returnedPath ?? null,
        reportedBytes: fullCapture?.reportedBytes ?? null,
        fileBytes: fullCapture?.fileBytes ?? null,
        width: fullCapture?.width ?? null,
        docHeight: fullCapture?.height ?? null,
      },
      after: page(fullCapture?.after),
    },
  };
}
