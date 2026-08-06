import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparePaneNativeContracts,
  comparePanePresentation,
  exposePaneHostIdentities,
  isPluginViewCallExposed,
  paneLayoutContractOf,
  presentedTransitionMode,
  projectPluginViewNode,
  projectPluginViewSlot,
} from "./pluginViewPresentation";

describe("Tauri plugin renderer RPC surface", () => {
  it("native host key와 논리 pane identity를 별도 공개 필드로 결합한다", () => {
    const [host] = exposePaneHostIdentities(
      [{
        pane: "pane-w-4fe-view-browser",
        window: "w-4fe",
        renderer: "pv-w-4fe-1",
        members: ["b-w-4fe-view-browser"],
        cssFrame: { x: 100, y: 80, w: 640, h: 480 },
      }],
      [{
        nativeHostId: "pane-w-4fe-view-browser",
        logicalPaneId: "pan-lf7lhc",
        viewId: "view-browser",
      }],
    );

    expect(host).toMatchObject({
      nativeHostId: "pane-w-4fe-view-browser",
      logicalPaneId: "pan-lf7lhc",
      viewId: "view-browser",
      window: "w-4fe",
      members: ["b-w-4fe-view-browser"],
    });
    expect(host).not.toHaveProperty("pane");
  });

  it("binding 없는 native host를 논리 pane으로 추측하지 않는다", () => {
    const [host] = exposePaneHostIdentities(
      [{ pane: "pane-orphan", window: "w-4fe", cssFrame: { x: 0, y: 0, w: 1, h: 1 } }],
      [],
    );
    expect(host).toMatchObject({
      nativeHostId: "pane-orphan",
      logicalPaneId: null,
      viewId: null,
    });
    expect(host).not.toHaveProperty("pane");
  });

  it("포커스는 합성 시계 capability가 아니며 pane은 같은 절대 epoch 거래만 쓴다", () => {
    expect(presentedTransitionMode()).toBe("glide");
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewPresentation.ts"), "utf8");
    const move = source.split("export async function preparePresentedPluginViewMove")[1] ?? "";
    expect(move).toContain("startAtUnixMs");
    expect(move).toContain('mode: "glide"');
    expect(move).toContain('invoke("webview_pane_transition_prepare"');
    expect(move).not.toContain("isFocused");
    expect(move).not.toContain('mode: "snap"');
  });

  it("포커스 조명은 단일 SVG 평면만 소유하고 Tauri adapter는 alpha·observer·IPC로 개입하지 않는다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewPresentation.ts"), "utf8");
    expect(source).not.toContain("webview_pane_lighting");
    expect(source).not.toContain("webview_surface_lighting");
    expect(source).not.toContain('getPropertyValue("--dim")');
    expect(source).not.toContain("lightingObserver");
    expect(source).not.toContain("lightingAlpha");
  });

  it("공개 content surface 생성 거래인 webview.open을 노출한다", () => {
    expect(isPluginViewCallExposed("webview.open")).toBe(true);
    expect(isPluginViewCallExposed("webview.present")).toBe(true);
  });

  it("선언된 sidecar handle의 open/send/close만 child RPC로 노출한다", () => {
    expect(isPluginViewCallExposed("sidecar.open")).toBe(true);
    expect(isPluginViewCallExposed("sidecar.send")).toBe(true);
    expect(isPluginViewCallExposed("sidecar.close")).toBe(true);
    expect(isPluginViewCallExposed("sidecar.internal")).toBe(false);
    const renderer = readFileSync(resolve(import.meta.dirname, "pluginViewRenderer.ts"), "utf8");
    expect(renderer).toContain("if (init.sidecarAvailable)");
    expect(renderer).toContain('subscribe("sidecar.on"');
  });

  it("최종 합성 배리어는 child 측정을 사건으로 요청한 뒤 native commit을 기다린다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewPresentation.ts"), "utf8");
    const barrier = source.split("export async function awaitPluginViewComposition")[1] ?? "";
    expect(barrier).toContain('emitTo(view.renderer, event(view.renderer, "measure")');
    expect(barrier.indexOf("waitCommittedRoot")).toBeLessThan(barrier.indexOf("emitTo(view.renderer"));
  });

  it("pane presentation ready는 group·member frame·visibility ACK 뒤에만 공개한다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewPresentation.ts"), "utf8");
    const bodies = [
      source.split("async function openAndGroup")[1]?.split("async function presentExisting")[0] ?? "",
      source.split("async function presentExisting")[1]?.split("async function handleCall")[0] ?? "",
    ];
    for (const body of bodies) {
      const begin = body.indexOf("state.readiness.set(view.nativeHostId, false)");
      const group = body.indexOf('invoke("webview_pane_group"');
      const member = body.indexOf("await syncMemberFrame(view, slot)");
      const visibility = body.indexOf("await view.visibility.request(view.visible)");
      const readyFact = body.indexOf("state.readiness.set(view.nativeHostId, true)");
      const readyPromise = body.indexOf("view.markReady()");
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(begin).toBeLessThan(group);
      expect(group).toBeLessThan(member);
      expect(member).toBeLessThan(visibility);
      expect(visibility).toBeLessThan(readyFact);
      expect(readyFact).toBeLessThan(readyPromise);
    }
  });

  it("child renderer의 명시적 측정 사건도 기존 slot reporter 하나를 사용한다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewRenderer.ts"), "utf8");
    expect(source).toContain('listen(event("measure"), reportSlots)');
  });

  it("child renderer에도 main과 같은 공개 workspace window 주소를 제공한다", () => {
    const presenter = readFileSync(resolve(import.meta.dirname, "pluginViewPresentation.ts"), "utf8");
    const renderer = readFileSync(resolve(import.meta.dirname, "pluginViewRenderer.ts"), "utf8");
    expect(presenter).toContain("windowLabel,");
    expect(renderer).toContain("windowLabel: () => init.windowLabel");
  });

  it("child renderer는 command 실행만 소비하고 창 단위 command 등록 소유권은 갖지 않는다", () => {
    const renderer = readFileSync(resolve(import.meta.dirname, "pluginViewRenderer.ts"), "utf8");
    const commands = renderer.split("commands: {")[1]?.split("},\n    events:")[0] ?? "";
    expect(commands).toContain("execute:");
    expect(commands).not.toContain("register:");
    expect(renderer).not.toContain("const noRegistration");
  });


  it("임의의 app 내부 경로는 노출하지 않는다", () => {
    expect(isPluginViewCallExposed("internal.anything")).toBe(false);
  });

  it("child content slot을 메인 좌표계의 공개 측정 DOM으로 투영한다", () => {
    const container = document.createElement("div");
    const projected = projectPluginViewSlot(container, {
      label: "b-main-tab-1", x: 11, y: 47, w: 320, h: 180, rootW: 400, rootH: 260,
      revision: 1, reportedAtUnixMs: 1,
    }, {
      viewId: "tab-1",
      topologyPath: "window/w-1/view/tab-1/content/b-main-tab-1",
      visible: true,
    });
    expect(projected.dataset.node).toBe("tauri/plugin-view/b-main-tab-1/surface");
    expect(projected.hasAttribute("data-content-view-body")).toBe(false);
    expect(projected.dataset).toMatchObject({
      compositionKind: "slot",
      viewId: "tab-1",
      topologyPath: "window/w-1/view/tab-1/content/b-main-tab-1",
      visible: "true",
    });
    const renderer = projected.querySelector<HTMLElement>("[data-composition-kind=renderer]");
    expect(renderer?.dataset).toMatchObject({
      viewId: "tab-1",
      topologyPath: "window/w-1/view/tab-1/content/b-main-tab-1",
      visible: "true",
    });
    expect(renderer?.dataset.node).toBe("tauri/plugin-view/b-main-tab-1/renderer");
    expect(projected.style.cssText).toContain("left: 11px");
    expect(projected.style.cssText).toContain("height: 180px");
  });

  it("child toolbar도 같은 탭 주소 아래 공개 측정 DOM으로 투영한다", () => {
    const container = document.createElement("div");
    const projected = projectPluginViewNode(container, {
      label: "b-main-tab-1", node: "toolbar", x: 4, y: 8, w: 300, h: 40, rootW: 400, rootH: 260,
      revision: 1, reportedAtUnixMs: 1, control: null,
    });
    expect(projected.dataset.node).toBe("tauri/plugin-view/b-main-tab-1/toolbar");
    expect(projected.style.top).toBe("8px");
  });

  it("child form node의 종류와 현재 value를 공개 projection에 함께 투영한다", () => {
    const container = document.createElement("div");
    const projected = projectPluginViewNode(container, {
      label: "b-main-tab-1", node: "urlbar", x: 4, y: 8, w: 300, h: 40,
      rootW: 400, rootH: 260, revision: 1, reportedAtUnixMs: 1,
      control: { kind: "input", value: "https://fixture.invalid/" },
    });
    expect(projected.dataset.formControl).toBe("input");
    expect(projected.dataset.formValue).toBe("https://fixture.invalid/");
  });

  it("child renderer가 form value를 node frame의 공개 상태로 보고한다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "pluginViewRenderer.ts"), "utf8");
    const protocol = readFileSync(resolve(import.meta.dirname, "pluginViewProtocol.ts"), "utf8");
    expect(source).toContain("control: nodeControlState(element)");
    expect(protocol).toContain("element.localName");
  });

  it("호출 창의 DOM pane과 native host를 1:1·반올림 오차만으로 판정한다", () => {
    const verdict = comparePanePresentation(
      [
        { pane: "pane-a", frame: { x: 60.2, y: 121, w: 481.2, h: 929 }, members: [
          {
            label: "browser-a",
            frame: { x: 0, y: 56, w: 481, h: 873 },
            topologyPath: "window/w-1/view/tab-a/content/browser-a",
          },
        ] },
        { pane: "pane-b", frame: { x: 713.2, y: 121, w: 180.8, h: 929 } },
      ],
      [
        { pane: "pane-a", window: "w-1", cssFrame: { x: 60, y: 121, w: 481, h: 929 }, memberFrames: [
          { label: "browser-a", cssFrame: { x: 0, y: 56, w: 481, h: 873 } },
        ] },
        { pane: "pane-b", window: "w-1", cssFrame: { x: 500, y: 121, w: 180, h: 929 } },
        { pane: "foreign", window: "w-2", cssFrame: { x: 0, y: 0, w: 1, h: 1 } },
      ],
      "w-1",
    );
    expect(verdict.matches).toHaveLength(2);
    expect(verdict.matches[0]).toMatchObject({
      pane: "pane-a",
      ok: true,
      coordinateSpace: {
        logical: "css-px",
        origin: "window-absolute",
        referenceId: "w-1",
      },
    });
    expect(verdict.matches[0].memberMatches).toMatchObject([{
      label: "browser-a",
      topologyPath: "window/w-1/view/tab-a/content/browser-a",
      ok: true,
      coordinateSpace: {
        logical: "css-px",
        origin: "presenter-local",
        referenceId: "browser-a",
      },
    }]);
    expect(verdict.matches[1]).toMatchObject({ pane: "pane-b", ok: false });
    expect(verdict.foreignNative).toEqual(["foreign"]);
    expect(verdict.ok).toBe(false);
  });

  it("pane 감사 결과에 shared topology와 adapter 비개입 alpha=1을 보존한다", () => {
    const verdict = comparePanePresentation(
      [{ pane: "pane-a", frame: { x: 10, y: 20, w: 300, h: 200 } }],
      [{
        pane: "pane-a", window: "w-1", cssFrame: { x: 10, y: 20, w: 300, h: 200 },
        alpha: 1,
        chromeAboveHost: true,
        rendererTopology: {
          domRendererPath: ["TaoView", "PaneSurfaceHost", "WryWebView"],
          nativeSurfacePath: ["TaoView", "PaneSurfaceHost", "BrowserSurface"],
          lowestCommonAncestorDepth: 1,
          lowestCommonAncestorIsWindowContentRoot: false,
        },
      }],
      "w-1",
    );
    expect(verdict.matches[0]).toMatchObject({
      alpha: 1,
      chromeAboveHost: true,
      rendererTopology: { verdict: "shared-pane-host", panelAtomicMotion: true },
    });
  });

  it("hostile resize 단계는 DOM 이벤트가 아니라 선언된 native affine 계약으로 판정한다", () => {
    const verdict = comparePaneNativeContracts([{
      pane: "pane-a", window: "w-1",
      cssFrame: { x: 10, y: 20, w: 300, h: 200 },
      contractFrame: { x: 10, y: 20, w: 300, h: 200 },
      memberFrames: [{
        label: "browser-a",
        cssFrame: { x: 0, y: 56, w: 300, h: 144 },
        contractFrame: { x: 0, y: 56, w: 300, h: 144 },
      }],
    }], "w-1");
    expect(verdict).toMatchObject({ matched: true, verdict: "green" });

    const red = comparePaneNativeContracts([{
      pane: "pane-a", window: "w-1",
      cssFrame: { x: 10, y: 20, w: 280, h: 200 },
      contractFrame: { x: 10, y: 20, w: 300, h: 200 },
      memberFrames: [],
    }], "w-1");
    expect(red).toMatchObject({ matched: false, verdict: "red" });
  });

  it("셀 비율과 고정 chrome을 native resize가 재실행할 affine 계약으로 노출한다", () => {
    const root = document.createElement("div");
    root.className = "space";
    const body = document.createElement("div");
    body.className = "tab-body";
    body.style.setProperty("--l", "66.6667%");
    body.style.setProperty("--t", "0%");
    body.style.setProperty("--w", "33.3333%");
    body.style.setProperty("--h", "50%");
    const container = document.createElement("div");
    body.appendChild(container); root.appendChild(body); document.body.appendChild(root);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
    root.getBoundingClientRect = () => ({ x: 54, y: 82, width: 846, height: 998, top: 82, left: 54, right: 900, bottom: 1080, toJSON() {} });
    container.getBoundingClientRect = () => ({ x: 669, y: 121, width: 224, height: 430, top: 121, left: 669, right: 893, bottom: 551, toJSON() {} });
    expect(paneLayoutContractOf(container)).toMatchObject({
      viewportW: 900, viewportH: 1080,
      leftRatio: 0.666667, topRatio: 0, widthRatio: 0.333333, heightRatio: 0.5,
      fixedX: expect.closeTo(51, 3), fixedY: 39,
      fixedW: expect.closeTo(-58, 3), fixedH: -69,
    });
  });
});
