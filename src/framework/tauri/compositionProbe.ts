export interface DirectCompositionProbe {
  verdict: {
    misplaced: readonly unknown[];
    stacked: readonly unknown[];
    missing: readonly unknown[];
  };
}

export interface PaneCompositionProbe {
  matched: boolean;
  verdict: "green" | "red";
}

/**
 * Tauri owns two disjoint native composition planes. Direct content views match DOM slots;
 * plugin-native views match PaneSurfaceHosts. A resize transaction is green only when both
 * owners independently report green. Their schemas remain separate so ownership cannot blur.
 */
export function combineTauriCompositionProbe<
  Direct extends DirectCompositionProbe,
  Pane extends PaneCompositionProbe,
>(direct: Direct, pane: Pane) {
  const directRed = direct.verdict.misplaced.length
    + direct.verdict.stacked.length
    + direct.verdict.missing.length;
  return {
    direct,
    pane,
    verdict: directRed === 0 && pane.matched && pane.verdict === "green"
      ? "green" as const
      : "red" as const,
  };
}
