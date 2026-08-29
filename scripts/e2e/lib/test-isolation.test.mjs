// @vitest-environment node
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;

// 규칙 — 테스트는 자기만의 자리를 쓴다.
//
// 고정 경로를 쓰는 테스트가 둘이면 병렬 실행에서 서로 덮는다. 그러면 같은 코드가 실행 순서에
// 따라 다른 답을 낸다 — 그것이 운이다. 실측 2026-08-07: 단독으로는 통과하는 스위트가 전체
// 실행에서만 실패했고, 원인은 두 스위트가 <local-evidence> 아래 같은 이름을 쓴 것이었다.
//
// 사람이 매번 판별하면 하나를 놓친다. 규칙을 기계가 센다.
describe("테스트는 고정 경로를 소유하지 않는다", () => {
  it("os.tmpdir 아래 고정 이름을 쓰는 테스트가 없다", () => {
    const offenders = [];
    for (const file of globSync("scripts/e2e/**/*.test.mjs", { cwd: ROOT })) {
      // 이 게이트 자신은 규칙을 증명하려고 위반 문자열을 든다 — 자기를 세면 자기 자격 확인이
      // 곧 위반이 된다. 규칙을 지키는지는 이 파일이 스스로 아래에서 증명한다.
      if (file.endsWith("test-isolation.test.mjs")) continue;
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const [index, text] of source.split("\n").entries()) {
        const line = index;
        // 리터럴 "<local-evidence>/..." 는 이 프로세스만의 자리가 아니다. mkdtemp 나 pid 로 자기 자리를 받아라.
        //
        // 게이트가 자격을 확인하려면 위반을 심어야 한다 — 심은 위반 문자열은 파일시스템을 쓰지
        // 않으므로 이 규칙의 대상이 아니다. 그 자리는 write(...) 로 픽스처를 짓는다.
        const plantsViolation = /\bwrite\(/.test(text);
        if (/["'`]\<local-evidence>\//.test(text) && !text.trimStart().startsWith("//") && !plantsViolation) {
          offenders.push(`${file}:${line + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 게이트는 위반을 심어 자격을 확인한다 — 안 잡는 게이트는 green 이 통과의 증거가 아니다.
  it("고정 경로를 심으면 잡는다", () => {
    const planted = 'const root = "<local-evidence>/soksak-fixed-name";';
    expect(/["\'`]\<local-evidence>\//.test(planted)).toBe(true);
    // 픽스처를 짓는 줄(write)은 규칙 대상이 아니다 — 그 차이도 함께 고정한다.
    expect(/\bwrite\(/.test('write("bad.mjs", \'"<local-evidence>/x.sock"\');')).toBe(true);
  });
});
