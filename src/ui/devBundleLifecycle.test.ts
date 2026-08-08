// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const makefile = readFileSync(resolve(__dirname, "../../Makefile"), "utf8");

/** 한 타깃의 구간 — 그 헤더부터 **다음 타깃 헤더 직전**까지.
 *
 * "빈 줄 다음에 오는 타깃" 으로 자르면 다음 타깃에 주석이 붙는 순간 아무것도 못 자르고,
 * 빈 구간에 대한 단언은 전부 통과한다(실측 2026-08-08: 세 검사가 빈 문자열을 보고 실패했고,
 * 실패로 나온 것이 다행이었다 — `not.toMatch` 였다면 조용히 통과했다).
 *
 * 주석은 자기 아래 타깃의 것이다. 그래서 경계는 헤더 자신이지 그 앞의 빈 줄이 아니다.
 */
function section(name: string): string {
  const lines = makefile.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start < 0) throw new Error(`Makefile 에 ${name} 타깃이 없다`);
  const header = /^[A-Za-z0-9_.-]+:(?!=)/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (header.test(lines[i])) {
      end = i;
      break;
    }
  }
  // 다음 타깃에 붙은 주석 묶음은 그 타깃의 것이다 — 이 구간에서 뺀다.
  while (end > start + 1 && (lines[end - 1].startsWith("#") || lines[end - 1] === "")) end -= 1;
  return lines.slice(start, end).join("\n");
}

describe("dev 번들 수명 계약", () => {
  it("run-dev는 macOS LaunchServices에 번들을 맡기고 포커스를 훔치지 않는다", () => {
    const target = section("run-dev");
    expect(target).toMatch(/\bopen\s+-n\s+-g\b/);
    expect(target).toMatch(/-i\s+\/dev\/null/);
    expect(target).toMatch(/--env\s+SOKSAK_E2E_KEK=/);
    expect(target).toMatch(/--env\s+SOKSAK_VAULT_PATH=/);
    expect(target).toContain('"$(DEV_APP)"');
    expect(target).not.toMatch(/"\$\(DEV_EXECUTABLE\)"[^\n]*&/);
  });

  it("restart-dev는 응답 재등장이 아니라 dev IPC 소유 PID의 실제 교체를 증명한다", () => {
    const target = section("restart-dev");
    expect(makefile).toMatch(/^DEV_HOST_SOCKET\s*:=/m);
    expect(makefile).toMatch(/^DEV_CORED_SOCKET\s*:=/m);
    expect(target).toContain('SOCKET="$(DEV_HOST_SOCKET)"');
    expect(target).toMatch(/owner_pid\(\)/);
    expect(target).toContain('old_pid="$$(owner_pid)"');
    expect(target).toMatch(/new_pid=.*owner_pid/);
    expect(target).toMatch(/new_pid.*old_pid|old_pid.*new_pid/);
    expect(target).toMatch(/kill -0/);
  });

  it("rebuild-dev는 현재 소스를 빌드하고 restart-dev는 동일 번들만 재실행한다", () => {
    const rebuild = section("rebuild-dev");
    const repeat = section("restart-dev");

    expect(rebuild).toMatch(/^rebuild-dev:\s+build-dev\b/m);
    expect(rebuild).toContain("restart-dev");
    expect(repeat).not.toMatch(/^restart-dev:\s+build-dev\b/m);
    expect(repeat).not.toMatch(/\$\(MAKE\).*\bbuild-dev\b/);
    expect(repeat).toContain('SOCKET="$(DEV_HOST_SOCKET)"');
  });
});
