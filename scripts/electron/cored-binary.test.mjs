// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const { coredBinary } = createRequire(import.meta.url)(
  path.join(ROOT, "frameworks/electron/cored.cjs"),
);
const SANDBOX = path.join(os.tmpdir(), `soksak-cored-binary-${process.pid}`);

function placeBinary(relative) {
  const at = path.join(SANDBOX, relative);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, "#!/bin/sh\n");
  chmodSync(at, 0o755);
  return at;
}

afterEach(() => rmSync(SANDBOX, { recursive: true, force: true }));

// 규칙 — 산출물 자리는 cargo 관례를 다 따른다.
//
// 교차 빌드는 `target/<triple>/<profile>/` 에 난다(CARGO_BUILD_TARGET 이 설정되면 항상). 후보를
// `target/<profile>/` 두 자리로만 적어서, 그 빌드를 쓰는 저장소에서는 바이너리가 있는데도 "못
// 찾았다" 가 됐다 — 실측 2026-08-08: 아홉 건이 그 이유로 실패했고, 앱은 정상이었다.
describe("coredBinary", () => {
  it("target/<profile> 에 있으면 찾는다", () => {
    const at = placeBinary("target/debug/soksak-cored");
    expect(coredBinary({ root: SANDBOX })).toBe(at);
  });

  it("교차 빌드 자리(target/<triple>/<profile>)도 찾는다", () => {
    const at = placeBinary("target/aarch64-apple-darwin/debug/soksak-cored");
    expect(coredBinary({ root: SANDBOX })).toBe(at);
  });

  it("어디에도 없으면 찾아본 자리를 이름으로 답한다", () => {
    mkdirSync(SANDBOX, { recursive: true });
    expect(() => coredBinary({ root: SANDBOX })).toThrow(/찾아본 자리/);
  });
});
