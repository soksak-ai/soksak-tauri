import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetTauriHoleMarkersForTest,
  installTauriHoleMarkers,
  isTauriRectMotionExcluded,
  syncTauriHoleMarkers,
  TAURI_PANE_RENDERER_ATTR,
} from "./holeMarkers";

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
    document.body.innerHTML = "";
  });
  afterEach(__resetTauriHoleMarkersForTest);

  it("공개 content-view 슬롯이 있는 본문과 같은 pane만 Tauri hole로 투영한다", () => {
    const p1 = pane("g1");
    const p2 = pane("g2");
    const native = body(p1, "g1", "b-main-v1");
    const dom = body(p2, "g2");

    syncTauriHoleMarkers();

    const slot = native.querySelector<HTMLElement>("[data-content-view-body]")!;
    expect(slot.dataset.tauriHole).toBe("content");
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
    expect(remote.dataset.tauriHoleFrame).toBe("");
    expect(p1.dataset.tauriHole).toBe("pane");
    expect(ordinary.dataset.tauriHoleFrame).toBeUndefined();
    expect(p2.dataset.tauriHole).toBeUndefined();
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
});
