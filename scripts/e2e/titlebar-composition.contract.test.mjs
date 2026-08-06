// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("titlebar composition live E2E contract", () => {
  const source = readFileSync(new URL("./titlebar-composition.mjs", import.meta.url), "utf8");

  it("uses only public status/DOM commands and a finite height sequence", () => {
    for (const marker of [
      'rpc("window.list"',
      'rpc("window.startup"',
      'rpc("debug.sleep"',
      'rpc("titlebar.composition"',
      'rpc("titlebar.height.set"',
      'rpc("titlebar.height.reset"',
      'rpc("ui.measure"',
      'rpc("window.snapshot"',
      "[30, 60, 72]",
      "held:",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("window.focus");
  });

  it("judges every live window against all three browser acceptance identities", () => {
    expect(source).toContain("BROWSER_ACCEPTANCE_ENGINES");
    expect(source).toContain("judgeB12MachineEvidence");
    expect(source).toContain("for (const windowLabel of labels)");
    expect(source).toContain("for (const engine of BROWSER_ACCEPTANCE_ENGINES)");
    expect(source).toContain('verdict.status !== "green"');
  });

  it("always restores exact titlebar inline geometry", () => {
    const finallyAt = source.indexOf("finally {");
    const resetAt = source.indexOf('rpc("titlebar.height.reset"', finallyAt);
    expect(finallyAt).toBeGreaterThan(0);
    expect(resetAt).toBeGreaterThan(finallyAt);
  });
});
