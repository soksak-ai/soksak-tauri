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

function checkpoint(raw) {
  const paneIds = Array.isArray(raw?.paneIds) ? raw.paneIds : [];
  const dims = Array.isArray(raw?.lighting?.dims) ? raw.lighting.dims : [];
  const levels = Array.isArray(raw?.lighting?.levels) ? raw.lighting.levels : [];
  const adapterAlphas = Array.isArray(raw?.lighting?.adapterAlphas)
    ? raw.lighting.adapterAlphas
    : [];
  return {
    phase: field(raw, "phase"),
    activePaneId: field(raw, "activePaneId"),
    panes: paneIds.map((paneId, index) => ({
      paneId,
      active: paneId === raw?.activePaneId,
      level: levels[index] ?? null,
      styleDim: dims[index] ?? null,
      adapterAlpha: adapterAlphas[index] ?? null,
    })),
    lightingPlane: {
      count: field(raw?.lightingPlane, "count"),
      baseAmount: field(raw?.lightingPlane, "baseAmount"),
      aperturePaneId: field(raw?.lightingPlane, "aperturePaneId"),
      apertureCount: field(raw?.lightingPlane, "apertureCount"),
    },
    rail: exempt(raw?.rail, "rail"),
    sidebar: exempt(raw?.sidebar, "sidebar"),
  };
}

/** Maps only independently measured style, plane, adapter, and exemption facts. */
export function mapB06LiveEvidence(raw = {}) {
  return {
    engine: field(raw, "engine"),
    checkpoints: Array.isArray(raw?.checkpoints) ? raw.checkpoints.map(checkpoint) : null,
  };
}
