// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./install.ts", import.meta.url), "utf8");

describe("Tauri layout composition installation", () => {
  it("creates one schedule and injects it into both external-surface presenters", () => {
    const prepare = source
      .split("prepareMove: async (moves) => {")[1]
      ?.split("commit: async () =>")[0] ?? "";
    expect(prepare.match(/const timing =/g)).toHaveLength(1);
    expect(prepare).toContain("prepareNativeContentViewMove(moves, timing)");
    expect(prepare).toContain("preparePresentedPluginViewMove(moves, timing)");
    expect(prepare).toContain("...(hasExternalGlide ? timing : {})");
    expect(prepare).not.toMatch(/direct\.startAtUnixMs \?\?|presented\.startAtUnixMs \?\?/);
  });
});
