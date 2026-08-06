import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetTauriHoleMarkersForTest,
  installTauriHoleMarkers,
  isTauriRectMotionExcluded,
  syncTauriHoleMarkers,
  TAURI_PANE_RENDERER_ATTR,
} from "./holeMarkers";
import {
  __resetTauriSurfaceOwnershipForTest,
  claimDirectSurface,
} from "./surfaceOwnership";

function pane(id: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "pane";
  el.dataset.pane = id;
  document.body.appendChild(el);
  return el;
}

function body(parent: HTMLElement, paneId: string, label?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab-body";
  el.dataset.pane = paneId;
  if (label) {
    const slot = document.createElement("div");
    slot.dataset.contentViewBody = label;
    el.appendChild(slot);
  }
  parent.appendChild(el);
  return el;
}

describe("Tauri private hole projection", () => {
  beforeEach(() => {
    __resetTauriHoleMarkersForTest();
    __resetTauriSurfaceOwnershipForTest();
    document.body.innerHTML = "";
  });
  afterEach(__resetTauriHoleMarkersForTest);

  it("공개 content-view 슬롯이 있는 본문과 같은 pane만 Tauri hole로 투영한다", () => {
    const p1 = pane("g1");
    const p2 = pane("g2");
    const native = body(p1, "g1", "b-main-v1");
    const dom = body(p2, "g2");

    claimDirectSurface("b-main-v1");
    syncTauriHoleMarkers();

    const slot = native.querySelector<HTMLElement>("[data-content-view-body]")!;
    expect(slot.dataset.tauriHole).toBe("content");
    expect(slot.dataset.tauriSurfaceOwner).toBe("direct");
    expect(native.dataset.tauriHole).toBeUndefined();
    expect(native.dataset.tauriHoleFrame).toBe("");
    expect(p1.dataset.tauriHole).toBe("pane");
    expect(dom.dataset.tauriHole).toBeUndefined();
    expect(p2.dataset.tauriHole).toBeUndefined();
  });

  it("문서 밖 plugin renderer 자리도 Tauri private source에서 hole로 투영한다", () => {
    const p1 = pane("g1");
    const p2 = pane("g2");
    const remote = body(p1, "g1");
    const ordinary = body(p2, "g2");
    const placeholder = document.createElement("div");
    placeholder.setAttribute(TAURI_PANE_RENDERER_ATTR, "pv-main-1");
    remote.appendChild(placeholder);

    syncTauriHoleMarkers();

    expect(placeholder.dataset.tauriHole).toBe("content");
    expect(placeholder.dataset.tauriSurfaceOwner).toBe("pane");
    expect(remote.dataset.tauriHoleFrame).toBe("");
    expect(p1.dataset.tauriHole).toBe("pane");
    expect(ordinary.dataset.tauriHoleFrame).toBeUndefined();
    expect(p2.dataset.tauriHole).toBeUndefined();
  });

  it("native open 장부가 없는 DOM/offscreen content 슬롯은 Tauri hole로 추측하지 않는다", () => {
    const p = pane("g1");
    const offscreen = body(p, "g1", "offscreen-tab-1");

    syncTauriHoleMarkers();

    const slot = offscreen.querySelector<HTMLElement>("[data-content-view-body]")!;
    expect(slot.dataset.tauriHole).toBeUndefined();
    expect(slot.dataset.tauriSurfaceOwner).toBeUndefined();
    expect(p.dataset.tauriHole).toBeUndefined();
  });

  it("공개 external-surface 선언은 외부 소유 hole로 투영하고 direct 감사와 분리한다", () => {
    const p = pane("g1");
    const external = body(p, "g1", "offscreen-tab-1");
    const slot = external.querySelector<HTMLElement>("[data-content-view-body]")!;
    slot.dataset.externalSurface = "offscreen-tab-1";

    syncTauriHoleMarkers();

    expect(slot.dataset.tauriHole).toBe("content");
    expect(slot.dataset.tauriSurfaceOwner).toBe("external");
    expect(external.dataset.tauriHoleFrame).toBe("");
    expect(p.dataset.tauriHole).toBe("pane");
  });

  it("PaneSurfaceHost renderer 안의 content 슬롯을 direct 소유로 중복 선언하지 않는다", () => {
    const p = pane("g1");
    const remote = body(p, "g1", "b-pane-member");
    remote.setAttribute(TAURI_PANE_RENDERER_ATTR, "pv-main-1");

    syncTauriHoleMarkers();

    const slot = remote.querySelector<HTMLElement>("[data-content-view-body]")!;
    expect(slot.dataset.tauriHole).toBe("content");
    expect(slot.dataset.tauriSurfaceOwner).toBe("pane");
    expect(remote.dataset.tauriSurfaceOwner).toBe("pane");
  });

  it("plugin renderer source 제거 뒤 stale hole을 남기지 않는다", () => {
    const p = pane("g1");
    const remote = body(p, "g1");
    const placeholder = document.createElement("div");
    placeholder.setAttribute(TAURI_PANE_RENDERER_ATTR, "pv-main-1");
    remote.appendChild(placeholder);
    syncTauriHoleMarkers();

    placeholder.removeAttribute(TAURI_PANE_RENDERER_ATTR);
    syncTauriHoleMarkers();

    expect(placeholder.dataset.tauriHole).toBeUndefined();
    expect(remote.dataset.tauriHoleFrame).toBeUndefined();
    expect(p.dataset.tauriHole).toBeUndefined();
  });

  it("문서 밖 표면의 실제 FLIP 추적 프레임만 보간에서 제외한다", () => {
    const p = pane("g1");
    const native = body(p, "g1", "b-main-v1");
    claimDirectSurface("b-main-v1");
    syncTauriHoleMarkers();

    const slot = native.querySelector<HTMLElement>("[data-content-view-body]")!;
    expect(isTauriRectMotionExcluded(p)).toBe(true);
    expect(isTauriRectMotionExcluded(native)).toBe(true);
    expect(isTauriRectMotionExcluded(slot)).toBe(false);

    const ordinaryFrame = pane("g2");
    const ordinaryBody = body(ordinaryFrame, "g2");
    expect(isTauriRectMotionExcluded(ordinaryFrame)).toBe(false);
    expect(isTauriRectMotionExcluded(ordinaryBody)).toBe(false);
  });

  it("슬롯 제거 뒤 stale 표식을 남기지 않는다", () => {
    const p = pane("g1");
    const native = body(p, "g1", "b-main-v1");
    claimDirectSurface("b-main-v1");
    syncTauriHoleMarkers();
    native.replaceChildren();
    syncTauriHoleMarkers();
    expect(native.dataset.tauriHoleFrame).toBeUndefined();
    expect(p.dataset.tauriHole).toBeUndefined();
  });

  it("설치는 DOM mutation 사건으로 새 슬롯을 반영한다", async () => {
    const p = pane("g1");
    const native = body(p, "g1");
    installTauriHoleMarkers();
    const slot = document.createElement("div");
    slot.dataset.contentViewBody = "b-main-v1";
    claimDirectSurface("b-main-v1");
    native.appendChild(slot);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(slot.dataset.tauriHole).toBe("content");
    expect(native.dataset.tauriHoleFrame).toBe("");
  });

  it("설치는 plugin renderer source 속성 사건도 반영한다", async () => {
    const p = pane("g1");
    const remote = body(p, "g1");
    const placeholder = document.createElement("div");
    remote.appendChild(placeholder);
    installTauriHoleMarkers();

    placeholder.setAttribute(TAURI_PANE_RENDERER_ATTR, "pv-main-1");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();

    expect(placeholder.dataset.tauriHole).toBe("content");
    expect(remote.dataset.tauriHoleFrame).toBe("");
    expect(p.dataset.tauriHole).toBe("pane");
  });

  it("설치는 external surface 소유권의 선언과 해제를 같은 DOM 사건으로 반영한다", async () => {
    const p = pane("g1");
    const external = body(p, "g1", "offscreen-tab-1");
    const slot = external.querySelector<HTMLElement>("[data-content-view-body]")!;
    installTauriHoleMarkers();

    slot.dataset.externalSurface = "offscreen-tab-1";
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(slot.dataset.tauriSurfaceOwner).toBe("external");
    expect(p.dataset.tauriHole).toBe("pane");

    delete slot.dataset.externalSurface;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(slot.dataset.tauriHole).toBeUndefined();
    expect(slot.dataset.tauriSurfaceOwner).toBeUndefined();
    expect(external.dataset.tauriHoleFrame).toBeUndefined();
    expect(p.dataset.tauriHole).toBeUndefined();
  });
});
