// @vitest-environment node
import { readFileSync, globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { undeclaredImports } from "./harness-symbols.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;

// 규칙 — 부르는 이름은 이 파일이 들여온 이름이어야 한다.
//
// `node --check` 는 구문만 본다. 정의 안 된 이름은 그 줄이 실제로 실행돼야 드러나므로, 라이브
// 실행에서만 죽는다 — 실측 2026-08-08: `readProvision is not defined` 로 B12 세 사이클이 전부
// 죽었고 인수 집계가 읽을 보고서 자체가 없었다. 같은 부류를 그 전날 한 번 더 했다.
//
// 손으로 매번 확인하면 또 놓친다. 기계가 센다.
describe("하니스가 부르는 이름은 선언돼 있다", () => {
  it("들여오지 않은 이름을 부르는 실행기가 없다", () => {
    const offenders = [];
    // 라이브러리도 서로를 부른다 — 실측 2026-08-08: evidence-store.mjs 가 `fs` 라는 없는
    // 이름을 불러 14건이 죽었다. 실행기만 세면 그 자리를 못 본다.
    for (const file of globSync("scripts/e2e/**/*.mjs", { cwd: ROOT })) {
      if (file.endsWith(".test.mjs")) continue;
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const name of undeclaredImports(source)) offenders.push(`${file}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  // 게이트는 위반을 심어 자격을 확인한다.
  it("들여오지 않은 이름을 심으면 잡는다", () => {
    expect(undeclaredImports('const x = readProvision(1);\n')).toContain("readProvision");
  });

  it("들여온 이름은 잡지 않는다", () => {
    const source = 'import { readProvision } from "./lib/harness-capabilities.mjs";\n'
      + "const x = readProvision(1);\n";
    expect(undeclaredImports(source)).toEqual([]);
  });

  it("다중행 import 블록 안의 이름도 들여온 것으로 읽는다", () => {
    const source = 'import {\n  readProvision,\n  other,\n} from "./lib/harness-capabilities.mjs";\n'
      + "const x = readProvision(other);\n";
    expect(undeclaredImports(source)).toEqual([]);
  });

  it("이 파일 안에서 선언한 이름은 들여올 필요가 없다", () => {
    expect(undeclaredImports("function readProvision() {}\nreadProvision();\n")).toEqual([]);
    expect(undeclaredImports("const readProvision = () => 1;\nreadProvision();\n")).toEqual([]);
  });
});
