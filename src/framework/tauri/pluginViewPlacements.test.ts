// 배치를 호스트가 소유하면, 그 자리에 사는 표면은 자기 프레임을 스스로 알 수 없다.
//
// RED 근거(실측 2026-08-07 · buildId=cfe39f5c, framework=tauri): browser-chromium-offscreen
// 11칸 blocked, status = `sentinel-created settle tab-awfrfr 실패:
// {"code":"TIMEOUT","message":"surface 4 actual presentation timeout"}`.
//
// offscreen 표면의 배치는 PaneSurfaceHost 가 소유한다(webview_pane_member_bounds). 그래서
// 엔진은 자기 프레임을 한 번도 듣지 못했고, 엔진 원장의 applied bounds 는 비어 있다.
// 표시 원장이 프레임을 못 세우면 표시 사건은 영원히 판정되지 않는다 — 대기는 타임아웃뿐이다.
//
// 계약 두 줄:
//   1. 적용한 쪽이 적용한 값을 알린다. 재측정은 같은 자리를 두 번 재는 쫓아가는 복사본이다.
//   2. 늦게 듣는 자는 못 들은 것이 아니다 — 표면은 만들어진 뒤에야 구독할 수 있고, 그 사이의
//      적용이 그 표면의 첫 프레임이다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginViewPlacementRegistry } from "./pluginViewPlacements";
import type { PluginViewPlacementFrame } from "./pluginViewProtocol";

const dir = import.meta.dirname;
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");

const frame = (
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  revision: number,
): PluginViewPlacementFrame => ({ label, x, y, w, h, revision });

describe("host-applied placement registry", () => {
  it("delivers the last applied frame to a subscriber that arrives after the commit", () => {
    const registry = new PluginViewPlacementRegistry();
    registry.commit(frame("offscreen-tab-a", 12, 40, 800, 600, 1));

    const seen: PluginViewPlacementFrame[] = [];
    registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied));

    expect(seen).toEqual([frame("offscreen-tab-a", 12, 40, 800, 600, 1)]);
  });

  it("delivers every later commit to the same subscriber", () => {
    const registry = new PluginViewPlacementRegistry();
    const seen: PluginViewPlacementFrame[] = [];
    registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied));

    registry.commit(frame("offscreen-tab-a", 12, 40, 800, 600, 1));
    registry.commit(frame("offscreen-tab-a", 12, 40, 400, 600, 2));

    expect(seen.map((applied) => applied.w)).toEqual([800, 400]);
  });

  it("keeps one label's placement out of another label's subscription", () => {
    const registry = new PluginViewPlacementRegistry();
    const seen: string[] = [];
    registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied.label));

    registry.commit(frame("offscreen-tab-b", 0, 0, 10, 10, 1));

    expect(seen).toEqual([]);
    expect(registry.applied("offscreen-tab-b")).toEqual(frame("offscreen-tab-b", 0, 0, 10, 10, 1));
  });

  it("does not let a late-arriving older measurement replace the current placement", () => {
    const registry = new PluginViewPlacementRegistry();
    const seen: number[] = [];
    registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied.revision));

    registry.commit(frame("offscreen-tab-a", 12, 40, 800, 600, 7));
    registry.commit(frame("offscreen-tab-a", 12, 40, 100, 100, 3));

    expect(seen).toEqual([7]);
    expect(registry.applied("offscreen-tab-a")?.w).toBe(800);
  });

  it("stops delivery once the subscription is disposed", () => {
    const registry = new PluginViewPlacementRegistry();
    const seen: number[] = [];
    const subscription = registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied.revision));

    registry.commit(frame("offscreen-tab-a", 0, 0, 10, 10, 1));
    subscription.dispose();
    registry.commit(frame("offscreen-tab-a", 0, 0, 20, 10, 2));

    expect(seen).toEqual([1]);
  });

  it("stops delivery once the registry is disposed", () => {
    const registry = new PluginViewPlacementRegistry();
    const seen: number[] = [];
    registry.subscribe("offscreen-tab-a", (applied) => seen.push(applied.revision));

    registry.dispose();
    registry.commit(frame("offscreen-tab-a", 0, 0, 10, 10, 1));

    expect(seen).toEqual([]);
    expect(registry.applied("offscreen-tab-a")).toBeUndefined();
  });
});

describe("the applied frame reaches the surface owner", () => {
  it("publishes the frame the native commit applied, right after that commit", () => {
    const source = read("pluginViewPresentation.ts");
    const body = (source.split("async function syncMemberFrame")[1] ?? "")
      .split("async function openAndGroup")[0];
    const commit = body.indexOf('invoke("webview_pane_member_bounds"');
    const publish = body.indexOf('event(view.renderer, "placement")');

    expect(commit).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(commit);
    // 적용한 값 그대로여야 한다 — 여기서 다시 재면 배치와 엔진이 서로 다른 기준을 쓴다.
    expect(body).toContain("label: frame.label");
    expect(body).toContain("revision: frame.revision");
    expect(body).not.toContain("getBoundingClientRect");
    expect(body).not.toContain("rectOf(");
  });

  it("child renderer listens for the applied frame before it activates the plugin", () => {
    const source = read("pluginViewRenderer.ts");
    const listen = source.indexOf('event("placement")');
    const activation = source.indexOf("activatePluginInViewRenderer(");

    expect(listen).toBeGreaterThan(-1);
    expect(listen).toBeLessThan(activation);
    expect(source).toContain("new PluginViewPlacementRegistry()");
  });

  it("declares the applied-frame subscription on the realm's webview surface", () => {
    const source = read("pluginViewRenderer.ts");
    const surface = (source.split("app.webview = {")[1] ?? "").split("};")[0];
    expect(surface).toContain("onPlacement:");
    // 선언은 손으로 적지 않는다 — 다 지은 객체에서 파생된다.
    expect(source.indexOf("app.webview = {"))
      .toBeLessThan(source.indexOf('declarePluginRealm("view-renderer", app)'));
  });
});
