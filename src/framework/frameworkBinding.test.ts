// 프런트엔드 프레임워크 바인딩 계약 — 선택하지 않은 어댑터는 실행되지 않는 정도가 아니라
// import graph에 존재하지 않아야 한다. 런타임 분기는 이미 두 구현을 한 산출물에 섞은 뒤다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

export function adapterImports(source: string): string[] {
  return [...source.matchAll(/from\s+["'](\.\/(?:electron|tauri))["']/g)].map(
    (m) => m[1],
  );
}

describe("framework build binding", () => {
  it("제품 프레임워크의 개발 엔드포인트는 서로 겹치지 않는다", () => {
    const endpoints = JSON.parse(
      readFileSync(resolve(ROOT, "frameworks/dev-endpoints.json"), "utf8"),
    ) as Record<"tauri" | "electron", { url: string; port: number }>;
    const tauri = JSON.parse(
      readFileSync(resolve(ROOT, "frameworks/tauri/tauri.conf.json"), "utf8"),
    ) as { build: { devUrl: string } };
    const electron = readFileSync(resolve(ROOT, "frameworks/electron/main.cjs"), "utf8");
    const vite = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");

    expect(endpoints.electron.url).not.toBe(endpoints.tauri.url);
    expect(endpoints.electron.port).not.toBe(endpoints.tauri.port);
    expect(tauri.build.devUrl).toBe(endpoints.tauri.url);
    expect(electron).toContain('require("../dev-endpoints.json")');
    expect(electron).toContain("DEV_ENDPOINTS.electron.url");
    expect(vite).toContain('from "./frameworks/dev-endpoints.json"');
    expect(vite).toContain("port: devEndpoint.port");
  });

  it("공통 문은 구체 어댑터를 함께 import하지 않는다", () => {
    const source = readFileSync(resolve(ROOT, "src/framework/index.ts"), "utf8");
    expect(adapterImports(source)).toEqual([]);
    expect(source).toContain('from "#framework-adapter"');
  });

  it("각 선택 잎은 자기 어댑터 하나만 연결한다", () => {
    const tauri = readFileSync(resolve(ROOT, "src/framework/selected.tauri.ts"), "utf8");
    const electron = readFileSync(resolve(ROOT, "src/framework/selected.electron.ts"), "utf8");
    expect(adapterImports(tauri)).toEqual(["./tauri"]);
    expect(adapterImports(electron)).toEqual(["./electron"]);
  });

  it("알 수 없는 프레임워크 이름에는 fallback이 없다", () => {
    const config = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    expect(config).not.toContain('?? "tauri"');
    expect(config).toContain("SOKSAK_FRAMEWORK를 tauri 또는 electron으로 명시해야 합니다");
    const tsconfig = readFileSync(resolve(ROOT, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain('"src/framework/selected.neutral.ts"');
  });
});
