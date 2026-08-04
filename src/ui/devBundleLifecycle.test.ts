// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const makefile = readFileSync(resolve(__dirname, "../../Makefile"), "utf8");

describe("dev 번들 수명 계약", () => {
  it("run-dev는 macOS LaunchServices에 번들을 맡기고 포커스를 훔치지 않는다", () => {
    const target = makefile.match(/run-dev:[\s\S]*?\n\nrestart-dev:/)?.[0] ?? "";
    expect(target).toMatch(/\bopen\s+-n\s+-g\b/);
    expect(target).toMatch(/-i\s+\/dev\/null/);
    expect(target).toMatch(/--env\s+SOKSAK_E2E_KEK=/);
    expect(target).toMatch(/--env\s+SOKSAK_VAULT_PATH=/);
    expect(target).toContain('"$(DEV_APP)"');
    expect(target).not.toMatch(/"\$\(DEV_EXECUTABLE\)"[^\n]*&/);
  });
});
