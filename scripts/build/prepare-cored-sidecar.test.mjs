// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  builtBinaryPath,
  cargoBuildArgs,
  hostTriple,
  profileFromEnv,
  stagedBinaryPath,
} from "./prepare-cored-sidecar.mjs";

describe("Tauri cored sidecar 준비 계약", () => {
  it("Tauri가 선언한 빌드 종류와 같은 Cargo 프로필을 사용한다", () => {
    expect(profileFromEnv({ TAURI_ENV_DEBUG: "true" })).toBe("debug");
    expect(profileFromEnv({ TAURI_ENV_DEBUG: "false" })).toBe("release");
    expect(() => profileFromEnv({})).toThrow(/TAURI_ENV_DEBUG/);
  });

  it("호스트 빌드는 중복 target 폴더 없이 읽고 Tauri 규약 이름으로 복사한다", () => {
    const triple = hostTriple("rustc 1.0\nhost: aarch64-apple-darwin\n");
    expect(cargoBuildArgs("debug", triple, false)).toEqual([
      "build", "-p", "soksak-cored", "--bin", "soksak-cored",
    ]);
    expect(builtBinaryPath("/repo/target", "debug", triple, false)).toBe(
      "/repo/target/debug/soksak-cored",
    );
    expect(stagedBinaryPath("/repo", triple)).toBe(
      "/repo/frameworks/tauri/binaries/soksak-cored-aarch64-apple-darwin",
    );
  });

  it("교차 빌드는 명시한 triple의 산출물만 패키징한다", () => {
    expect(cargoBuildArgs("release", "x86_64-apple-darwin", true)).toEqual([
      "build", "-p", "soksak-cored", "--bin", "soksak-cored", "--release",
      "--target", "x86_64-apple-darwin",
    ]);
    expect(
      builtBinaryPath(
        "/repo/target", "release", "x86_64-apple-darwin", true,
      ),
    ).toBe("/repo/target/x86_64-apple-darwin/release/soksak-cored");
  });

  it("명시 target이 host와 같아도 Cargo의 target 하위 산출물을 읽는다", () => {
    const triple = "aarch64-apple-darwin";
    expect(cargoBuildArgs("debug", triple, true)).toEqual([
      "build", "-p", "soksak-cored", "--bin", "soksak-cored", "--target", triple,
    ]);
    expect(builtBinaryPath("/repo/target", "debug", triple, true)).toBe(
      "/repo/target/aarch64-apple-darwin/debug/soksak-cored",
    );
  });

  it("실행 모드는 build-only와 bundle stage를 명시적으로 구분한다", () => {
    const scripts = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).scripts;
    expect(scripts["dev:tauri"]).toContain("pnpm build:cored");
    expect(scripts["build:cored"]).toMatch(/--build-only$/);
    expect(scripts["build:tauri"]).toContain("pnpm stage:cored");
    expect(scripts["stage:cored"]).toMatch(/--stage$/);
  });
});
