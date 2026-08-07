import { mapWithWiring } from "./browser-machine-judge-support.mjs";

const field = (value, key) => value && typeof value === "object" && Object.hasOwn(value, key)
  ? value[key]
  : null;

function exempt(value, node) {
  return {
    node,
    exempt: field(value, "exempt"),
    styleDim: field(value, "styleDim"),
    coveredByPlane: field(value, "coveredByPlane"),
  };
}

/**
 * 한 조명 checkpoint 인계 기록을 판정 스키마로 옮긴다.
 *
 * 하니스가 checkpoint 에 railComposition 을 싣고 이쪽은 rail 을 찾던 사고가 실제로 있었다. 그때
 * 소비되지 않은 생산 이름과 생산되지 않은 소비 이름이 둘 다 조용했다. 그래서 이 기록의 필드는
 * 손으로 나열하지 않고 배선 장부를 통해 읽는다.
 */
function mapCheckpoint(raw, index) {
  return mapWithWiring(raw, `B06.checkpoint[${index}]`, (checkpoint) => {
    const paneIdsValue = checkpoint.take("paneIds");
    const paneIds = Array.isArray(paneIdsValue) ? paneIdsValue : [];
    const lighting = checkpoint.take("lighting");
    const dims = Array.isArray(lighting?.dims) ? lighting.dims : [];
    const levels = Array.isArray(lighting?.levels) ? lighting.levels : [];
    const adapterAlphas = Array.isArray(lighting?.adapterAlphas) ? lighting.adapterAlphas : [];
    // 값과 그 값을 낸 장부의 이름은 함께 온다. 이름 없이 실린 alpha 는 측정이 아니라 선언이다.
    const adapterBases = Array.isArray(lighting?.adapterBases) ? lighting.adapterBases : [];
    const activePaneId = checkpoint.take("activePaneId") ?? null;
    const plane = checkpoint.take("lightingPlane");
    return {
      phase: checkpoint.take("phase") ?? null,
      activePaneId,
      panes: paneIds.map((paneId, paneIndex) => ({
        paneId,
        active: paneId === activePaneId,
        level: levels[paneIndex] ?? null,
        styleDim: dims[paneIndex] ?? null,
        adapterAlpha: adapterAlphas[paneIndex] ?? null,
        adapterBasis: adapterBases[paneIndex] ?? null,
      })),
      lightingPlane: {
        presented: field(plane, "presented"),
        parked: field(plane, "parked"),
        unreadable: field(plane, "unreadable"),
        baseAmount: field(plane, "baseAmount"),
        aperturePaneId: field(plane, "aperturePaneId"),
        apertureCount: field(plane, "apertureCount"),
      },
      rail: exempt(checkpoint.take("rail"), "rail"),
      sidebar: exempt(checkpoint.take("sidebar"), "sidebar"),
    };
  });
}

/** Maps only independently measured style, plane, adapter, and exemption facts. */
export function mapB06LiveEvidence(raw = {}) {
  return mapWithWiring(raw, "B06.live", (checkpoint) => {
    const checkpoints = checkpoint.take("checkpoints");
    return {
      engine: checkpoint.take("engine") ?? null,
      checkpoints: Array.isArray(checkpoints) ? checkpoints.map(mapCheckpoint) : null,
    };
  });
}
