// Tauri 시각 hole 표식 — 문서 밖 content-view가 실제로 붙은 DOM 슬롯에서만 파생한다.
// 코어의 plugin manifest나 CSS 클래스는 hole을 알지 않는다. 슬롯은 공개 DOM 계약
// (`data-content-view-body`)이고, pane 연결은 공개 identity(`data-pane`)로 해소한다.
import { moduleState } from "../../lib/moduleState";
import { CONTENT_VIEW_BODY } from "../../lib/contentViews";
import { EXTERNAL_SURFACE_ATTR } from "../../lib/externalSurfaceTransition";
import { onPluginEvent } from "../../plugins/hooks";
import { onTauriSurfaceOwnershipChanged, tauriSurfaceOwner } from "./surfaceOwnership";

export const TAURI_HOLE_ATTR = "data-tauri-hole";
export const TAURI_HOLE_FRAME_ATTR = "data-tauri-hole-frame";
/** DOM hole geometry has exactly one auditor. This is projected by the Tauri adapter. */
export const TAURI_SURFACE_OWNER_ATTR = "data-tauri-surface-owner";
/** Tauri가 플러그인 DOM을 별도 child renderer로 소유하는 메인 문서의 자리. */
export const TAURI_PANE_RENDERER_ATTR = "data-tauri-pane-renderer";
export const TAURI_CONTENT_HOLE = `[${TAURI_HOLE_ATTR}="content"]`;
const TAURI_PANE_HOLE = `[${TAURI_HOLE_ATTR}="pane"]`;
const TAURI_CONTENT_HOLE_FRAME = `[${TAURI_HOLE_FRAME_ATTR}]`;

/**
 * layoutRectMotion이 실제로 추적하는 Tauri 외부 표면의 DOM 프레임인가.
 *
 * native bounds 원천인 content-view body는 추적 대상의 자식이므로 여기서 검사하면 제외가
 * 영원히 발동하지 않는다. 추적 ref가 붙는 pane과 tab-body만 제외해야 문서 밖 child를
 * 중간 WAAPI rect로 끌고 가지 않으며, 일반 DOM pane은 그대로 코어 보간을 사용한다.
 */
export function isTauriRectMotionExcluded(el: HTMLElement): boolean {
  return el.matches(`${TAURI_PANE_HOLE}, ${TAURI_CONTENT_HOLE_FRAME}`);
}

const installed = moduleState("framework/tauri/holeMarkers#installed", () => ({
  on: false,
  observer: null as MutationObserver | null,
  offReflow: null as (() => void) | null,
  offOwnership: null as (() => void) | null,
}));

/** 현재 DOM 사실을 Tauri private marker로 투영한다. 같은 결과의 재적용은 멱등이다. */
export function syncTauriHoleMarkers(doc: Document = document): void {
  for (const el of doc.querySelectorAll<HTMLElement>(`[${TAURI_HOLE_ATTR}]`)) {
    el.removeAttribute(TAURI_HOLE_ATTR);
  }
  for (const el of doc.querySelectorAll<HTMLElement>(`[${TAURI_HOLE_FRAME_ATTR}]`)) {
    el.removeAttribute(TAURI_HOLE_FRAME_ATTR);
  }
  for (const el of doc.querySelectorAll<HTMLElement>(`[${TAURI_SURFACE_OWNER_ATTR}]`)) {
    el.removeAttribute(TAURI_SURFACE_OWNER_ATTR);
  }

  const project = (hole: HTMLElement, owner: "direct" | "pane" | "external"): void => {
    const body = hole.closest<HTMLElement>(".tab-body");
    if (!body) return;
    // 네이티브 자식 표면의 bounds 원천은 공개 content-view body 자체다. tab-body 전체를 hole로
    // 잡으면 플러그인 toolbar와 DOM dim까지 창 crop에 섞여 실제 표면과 다른 직사각형이 된다.
    hole.setAttribute(TAURI_HOLE_ATTR, "content");
    hole.setAttribute(TAURI_SURFACE_OWNER_ATTR, owner);
    body.setAttribute(TAURI_HOLE_FRAME_ATTR, "");
    const paneId = body.dataset.pane;
    if (!paneId) return;
    for (const pane of doc.querySelectorAll<HTMLElement>(".pane[data-pane]")) {
      if (pane.dataset.pane === paneId) pane.setAttribute(TAURI_HOLE_ATTR, "pane");
    }
  };

  for (const slot of doc.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)) {
    const label = slot.getAttribute(CONTENT_VIEW_BODY);
    if (!label) continue;
    // 한 슬롯의 기하 소유자는 하나다. pane renderer가 실제 child 전체를 소유하면 pane이
    // 우선하며, 그 밖의 문서 밖 제공자는 공개 선언으로만 식별한다. 프레임워크/플러그인
    // 이름이나 DOM 구조를 추측하지 않는다.
    const owner = slot.closest(`[${TAURI_PANE_RENDERER_ATTR}]`)
      ? "pane"
      : slot.getAttribute(EXTERNAL_SURFACE_ATTR)
        ? "external"
        : tauriSurfaceOwner(label);
    if (owner) project(slot, owner);
  }
  for (const renderer of doc.querySelectorAll<HTMLElement>(`[${TAURI_PANE_RENDERER_ATTR}]`)) {
    if (!renderer.getAttribute(TAURI_PANE_RENDERER_ATTR)) continue;
    project(renderer, "pane");
  }
}

/** 사건 기반 설치. MutationObserver는 DOM attach/detach 사건이며 주기 감시가 아니다. */
export function installTauriHoleMarkers(): void {
  if (installed.on || typeof document === "undefined") return;
  installed.on = true;
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      syncTauriHoleMarkers();
    });
  };
  installed.offReflow = onPluginEvent("layout.reflow", schedule).dispose;
  installed.offOwnership = onTauriSurfaceOwnershipChanged(schedule);
  installed.observer = new MutationObserver(schedule);
  installed.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [CONTENT_VIEW_BODY, EXTERNAL_SURFACE_ATTR, TAURI_PANE_RENDERER_ATTR, "data-pane"],
  });
  schedule();
}

export function __resetTauriHoleMarkersForTest(): void {
  installed.observer?.disconnect();
  installed.observer = null;
  installed.offReflow?.();
  installed.offReflow = null;
  installed.offOwnership?.();
  installed.offOwnership = null;
  installed.on = false;
}
