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

  it("restart-dev는 응답 재등장이 아니라 dev IPC 소유 PID의 실제 교체를 증명한다", () => {
    const target = makefile.match(/restart-dev:[\s\S]*?\n\nrun-debug:/)?.[0] ?? "";
    expect(makefile).toMatch(/^DEV_HOST_SOCKET\s*:=/m);
    expect(makefile).toMatch(/^DEV_CORED_SOCKET\s*:=/m);
    expect(target).toContain('SOCKET="$(DEV_HOST_SOCKET)"');
    expect(target).toMatch(/owner_pid\(\)/);
    expect(target).toContain('old_pid="$$(owner_pid)"');
    expect(target).toMatch(/new_pid=.*owner_pid/);
    expect(target).toMatch(/new_pid.*old_pid|old_pid.*new_pid/);
    expect(target).toMatch(/kill -0/);
  });
});
