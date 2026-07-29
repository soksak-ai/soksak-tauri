// 정체성 파생은 **한 규칙**이다 — Rust 와 JS 가 같은 픽스처를 통과한다.
//
// 규칙이 두 벌이면 같은 identifier 가 프로세스마다 다른 홈을 답한다. 그 어긋남은 오류가
// 아니다: cored 는 없는 파일을 "없음"으로 답하고, 앱은 자기 데이터가 안 보인다고만 느낀다.
//
// 정본은 src-tauri/crates/soksak-core/fixtures/identity.json 이고, Rust 쪽은
// identity.rs 의 the_fixture_binds_both_implementations 가 같은 파일을 읽는다.
// 한쪽만 고치면 그쪽이 깨진다 — 사람 주의력이 아니라 파일이 둘을 묶는다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { frameworkIdentity, identityAxes, homeSuffix, productName } = require("../../electron/cored.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "src-tauri", "crates", "soksak-core", "fixtures", "identity.json"), "utf8"),
);

describe("정체성 파생 — 픽스처가 오라클", () => {
  it("픽스처가 비어 있지 않다", () => {
    // 오라클 생존 — 비면 이 검사는 아무것도 안 지키면서 통과한다.
    expect(FIXTURE.cases.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE.cases.map((c) => [c.identifier, c]))("%s", (_id, c) => {
    expect(identityAxes(c.identifier).framework, `framework — ${c.why}`).toBe(c.framework);
    expect(identityAxes(c.identifier).env).toBe(
      c.coreBuild === "release" ? "app" : c.coreBuild,
    );
    expect(homeSuffix(c.identifier), "homeSuffix").toBe(c.homeSuffix);
    expect(productName(c.identifier), "productName").toBe(c.productName);
  });

  /** 홈은 접미에서만 나온다 — 두 프레임워크가 같은 env 에서 동시에 서려면 이것이 갈려야 한다. */
  it("홈이 프레임워크마다 갈린다", () => {
    const home = (id) =>
      frameworkIdentity({ env: { SOKSAK_IDENTIFIER: id }, argv: [], homedir: "/H" }).home;
    expect(home("com.soksak.tauri.dev")).toBe("/H/.soksak-tauri-dev");
    expect(home("com.soksak.electron.dev")).toBe("/H/.soksak-electron-dev");
    expect(home("com.soksak.tauri.dev")).not.toBe(home("com.soksak.electron.dev"));
  });

  /** 옛 모양도 그대로 답한다 — 규칙 하나가 둘 다 읽는다(전환기에 두 이름이 공존한다). */
  it("프레임워크 없는 옛 identifier 도 같은 규칙으로 답한다", () => {
    expect(homeSuffix("com.soksak.app")).toBe("");
    expect(homeSuffix("com.soksak.dev")).toBe("-dev");
    expect(productName("com.soksak.dev")).toBe("soksak-dev");
    expect(identityAxes("com.soksak.dev").framework).toBeNull();
  });

  /** 제품 이름은 프레임워크 이름이 아니다 — 안 정하면 Dock·메뉴바가 "Electron" 이 된다. */
  it("제품 이름에 프레임워크 이름이 새지 않는다", () => {
    for (const c of FIXTURE.cases) {
      expect(c.productName.startsWith(FIXTURE.product)).toBe(true);
      expect(productName(c.identifier)).not.toMatch(/^electron|^tauri/i);
    }
  });
});
