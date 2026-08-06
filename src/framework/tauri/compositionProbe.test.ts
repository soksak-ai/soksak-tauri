import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { combineTauriCompositionProbe } from "./compositionProbe";

const direct = (bad = false, unowned = false) => ({
  verdict: {
    misplaced: bad ? [{ x: 1, y: 2, w: 3, h: 4 }] : [],
    stacked: [], missing: [],
    unowned: unowned ? [{ x: 1, y: 2, w: 3, h: 4 }] : [],
    surfaces: bad ? 1 : 0, holes: 0,
  },
});
const pane = (matched = true) => ({
  matched,
  verdict: matched ? "green" as const : "red" as const,
});
const titlebar = (verdict: "green" | "red" = "green", nativeSequence = 11) => ({
  nativeSequence,
  verdict,
  checks: {
    count: verdict === "green",
    order: verdict === "green",
    nonOverlap: verdict === "green",
    containment: verdict === "green",
    oneToOne: verdict === "green",
    verticalCenter: verdict === "green",
    backingMatch: verdict === "green",
  },
});

const probe = (overrides: {
  generation?: number;
  sampledAtUnixMs?: number;
  direct?: ReturnType<typeof direct> | null;
  pane?: ReturnType<typeof pane> | null;
  titlebar?: ReturnType<typeof titlebar> | null;
} = {}) => ({
  generation: overrides.generation ?? 1,
  sampledAtUnixMs: overrides.sampledAtUnixMs ?? 1_700_000_000_000,
  direct: overrides.direct === undefined ? direct() : overrides.direct,
  pane: overrides.pane === undefined ? pane() : overrides.pane,
  titlebar: overrides.titlebar === undefined ? titlebar() : overrides.titlebar,
});

describe("Tauri resize composition probe", () => {
  const installSource = () => readFileSync(
    resolve(process.cwd(), "src/framework/tauri/install.ts"),
    "utf8",
  );

  it("requires direct-slot, pane-host, and macOS titlebar ownership planes to be green", () => {
    expect(combineTauriCompositionProbe(probe()).verdict).toBe("green");
    expect(combineTauriCompositionProbe(probe({ direct: direct(true) })).verdict).toBe("red");
    expect(combineTauriCompositionProbe(probe({ pane: pane(false) })).verdict).toBe("red");
    expect(combineTauriCompositionProbe(probe({ titlebar: titlebar("red") })).verdict).toBe("red");
  });

  it("geometry owner가 선언되지 않은 DOM hole을 direct GREEN으로 숨기지 않는다", () => {
    const invalid = direct(false, true);
    const result = combineTauriCompositionProbe(probe({ direct: invalid }));
    expect(result.checks.direct).toBe(false);
    expect(result.issues).toContain("direct-red");
    expect(result.verdict).toBe("red");
  });

  it("preserves all public facts under one exact sample generation", () => {
    expect(combineTauriCompositionProbe(probe())).toMatchObject({
      schemaVersion: 1,
      kind: "tauri-resize-composition-sample",
      generation: 1,
      direct: { verdict: { misplaced: [] } },
      pane: { matched: true },
      titlebar: { nativeSequence: 11, verdict: "green" },
      checks: { direct: true, pane: true, titlebar: true },
      issues: [],
    });
  });

  it.each([
    ["direct", { direct: null }],
    ["pane", { pane: null }],
    ["titlebar", { titlebar: null }],
  ])("makes a missing %s receipt RED instead of dropping the sample", (plane, replacement) => {
    const result = combineTauriCompositionProbe(probe(replacement));
    expect(result.verdict).toBe("red");
    expect(result.issues).toContain(`${plane}-missing`);
  });

  it("keeps every hostile resize and the restore as independent green generations", () => {
    const samples = [
      { generation: 21, nativeSequence: 101 },
      { generation: 22, nativeSequence: 103 },
      { generation: 23, nativeSequence: 105 },
    ].map(({ generation, nativeSequence }) => combineTauriCompositionProbe(probe({
      generation,
      titlebar: titlebar("green", nativeSequence),
    })));

    expect(samples.map(({ generation, verdict }) => ({ generation, verdict }))).toEqual([
      { generation: 21, verdict: "green" },
      { generation: 22, verdict: "green" },
      { generation: 23, verdict: "green" },
    ]);
    expect(samples[2]?.titlebar?.nativeSequence).toBe(105);
  });

  it("omits the macOS-only plane entirely when that native command does not exist", () => {
    const result = combineTauriCompositionProbe({
      generation: 31,
      sampledAtUnixMs: 1_700_000_000_000,
      direct: direct(),
      pane: pane(),
    });

    expect(result).not.toHaveProperty("titlebar");
    expect(result.checks).not.toHaveProperty("titlebar");
    expect(result.verdict).toBe("green");
  });

  it("uses read-only titlebar inspection in every resize sample", () => {
    const source = installSource();
    const resizeProbe = source
      .split("registerWindowResizeProbe(async () => {")[1]
      ?.split("registerRectMotionExclusion")[0];

    expect(resizeProbe).toContain("inspectTitlebarComposition()");
    expect(resizeProbe).not.toContain("composeTitlebarComposition()");
  });

  it("keeps the public inspection command read-only and names mutation separately", () => {
    const source = installSource();
    const inspection = source
      .split('register("titlebar.composition", {')[1]
      ?.split('register("titlebar.compose", {')[0];
    const mutation = source
      .split('register("titlebar.compose", {')[1]
      ?.split("\n  });")[0];

    expect(inspection).toContain("inspectTitlebarComposition()");
    expect(inspection).not.toContain("composeTitlebarComposition()");
    expect(mutation).toContain("composeTitlebarComposition()");
  });

  it("exposes a bounded height probe that restores the exact inline geometry", () => {
    const source = installSource();
    expect(source).toContain('register("titlebar.height.set", {');
    expect(source).toContain('register("titlebar.height.reset", {');
    expect(source).toContain("height <= 0 || height > window.innerHeight");
    expect(source).toContain("titlebarHeightProbe.height = element.style.height");
    expect(source).toContain("titlebarHeightProbe.flexBasis = element.style.flexBasis");
    expect(source).toContain("requestAnimationFrame(() => requestAnimationFrame");
    expect(source).toContain("return composeTitlebarComposition()");
  });
});
