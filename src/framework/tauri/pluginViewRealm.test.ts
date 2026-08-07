// nativeSurface 뷰의 자식 renderer realm 이 자기 신원과 능력을 선언하는지, 그리고 그 realm 이
// 부를 수 있는 RPC 가 한 자리에만 적혀 있는지.
//
// RED 근거(실측 2026-08-07 · buildId=c437078c, framework=tauri): browser-chromium-offscreen
// 12칸 blocked, status = "플러그인 활성 실패(...): app.commands.register is not a function".
// 자식 realm 의 app 에는 register 가 없다. 그 사실은 어디에도 선언되어 있지 않아 플러그인이
// typeof 로 더듬었고, 세 브라우저 플러그인의 판정이 제각각이었다.
//
// 계약 두 줄:
//   1. 자식 renderer 는 app 을 다 지은 뒤 realm 을 선언한다 — 선언은 그 객체에서 파생된다.
//   2. 그 realm 이 부모에게 부를 수 있는 경로는 protocol 이 소유한다. 부모의 게이트와 자식의
//      shim 이 각자 적은 두 목록이면 반드시 갈린다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VIEW_RENDERER_CALL_PATHS,
  VIEW_RENDERER_SUBSCRIBE_PATHS,
  isPluginViewCallExposed,
  isPluginViewSubscribeExposed,
} from "./pluginViewProtocol";

const dir = import.meta.dirname;
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");

/** 자식 소스가 실제로 부르는 부모 경로 전수. 손으로 적은 목록을 쓰지 않는다. */
function rendererRpcPaths(source: string): Set<string> {
  const found = new Set<string>();
  for (const [, path] of source.matchAll(/\bcall\(\s*"([^"]+)"/g)) found.add(path);
  for (const [, path] of source.matchAll(/\bsubscribe\(\s*"([^"]+)"/g)) found.add(path);
  // webview 표면은 이름만 다른 같은 forward 라 한 자리에서 만든다(asyncMethod).
  for (const [, name] of source.matchAll(/asyncMethod\(\s*"([^"]+)"/g)) found.add(`webview.${name}`);
  return found;
}

describe("view-renderer realm 선언", () => {
  it("자식은 app 을 다 지은 뒤 realm 을 선언하고, 그 다음에 플러그인을 살린다", () => {
    const source = read("pluginViewRenderer.ts");
    const declaration = source.indexOf('declarePluginRealm("view-renderer"');
    expect(declaration).toBeGreaterThan(-1);
    // 조건부 표면(sidecar·webview)이 붙기 전에 선언하면 선언이 객체보다 좁아진다.
    expect(declaration).toBeGreaterThan(source.indexOf("app.sidecar = {"));
    expect(declaration).toBeGreaterThan(source.indexOf("app.webview = {"));
    expect(declaration).toBeLessThan(source.indexOf("activatePluginInViewRenderer("));
  });

  it("자식은 선언을 손으로 적지 않는다 — app 객체를 그대로 넘긴다", () => {
    const source = read("pluginViewRenderer.ts");
    expect(source).toContain('declarePluginRealm("view-renderer", app)');
  });

  it("활성 실패는 어느 realm 에서 죽었는지까지 싣는다", () => {
    const renderer = read("pluginViewRenderer.ts");
    const protocol = read("pluginViewProtocol.ts");
    const presentation = read("pluginViewPresentation.ts");
    expect(protocol).toContain("realm: PluginRealmId");
    expect(renderer).toContain("realm: app.realm.id");
    expect(presentation).toContain("payload.realm");
  });
});

describe("realm 이 부를 수 있는 RPC 는 한 자리에 적힌다", () => {
  it("protocol 이 표를 소유하고, 부모는 그 표로만 판정한다", () => {
    const presentation = read("pluginViewPresentation.ts");
    expect(presentation).not.toContain("const CALL_PATHS = new Set");
    expect(presentation).not.toContain("const SUBSCRIBE_PATHS = new Set");
    expect(presentation).toContain("isPluginViewCallExposed");
    expect(presentation).toContain("isPluginViewSubscribeExposed");
    expect(isPluginViewCallExposed("commands.execute")).toBe(true);
    expect(isPluginViewCallExposed("commands.register")).toBe(false);
    expect(isPluginViewSubscribeExposed("events.on")).toBe(true);
    expect(isPluginViewSubscribeExposed("app.internal")).toBe(false);
  });

  it("자식이 부르는 경로 전수와 부모가 받는 경로 전수가 같다", () => {
    const declared = new Set<string>([
      ...VIEW_RENDERER_CALL_PATHS,
      ...VIEW_RENDERER_SUBSCRIBE_PATHS,
    ]);
    const called = rendererRpcPaths(read("pluginViewRenderer.ts"));

    const unexposed = [...called].filter((path) => !declared.has(path)).sort();
    const unused = [...declared].filter((path) => !called.has(path)).sort();

    expect(unexposed, "자식이 부르는데 부모가 안 받는 경로").toEqual([]);
    expect(unused, "부모는 받는데 자식이 안 부르는 경로").toEqual([]);
  });
});
