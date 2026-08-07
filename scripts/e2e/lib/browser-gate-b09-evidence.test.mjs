// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildB09Sample,
  deriveChromeControl,
  deriveHitOwners,
  pickOverlapSurface,
  probePointFor,
} from "./browser-gate-b09-evidence.mjs";

const SURFACE = Object.freeze({
  viewId: "tab-right",
  surfaceId: "b-w-b09-tab-right",
  topologyPath: "window/w-b09/view/tab-right/content/b-w-b09-tab-right",
  chromeAboveHost: true,
  live: true,
  visible: true,
  presented: true,
  rect: { x: 513, y: 149, w: 281, h: 421 },
});

describe("B09 표본은 명령 응답에서 파생된다", () => {
  it("소유자 사슬과 최상위 소유자를 ui.hit 응답에서만 읽는다", () => {
    expect(deriveHitOwners({ owners: ["modal/project-new/card", "modal/project-new"] }))
      .toEqual(["modal/project-new/card", "modal/project-new"]);
    // 응답이 사슬을 답하지 않으면 비어 있다 — 다른 필드로 대신 채우지 않는다.
    expect(deriveHitOwners({ dataset: { node: "rail/add" }, painters: [{ node: "rail" }] }))
      .toEqual([]);
    expect(deriveHitOwners(null)).toEqual([]);
    expect(deriveHitOwners({ owners: ["rail/add", "", "rail/add", "rail", 7] }))
      .toEqual(["rail/add", "rail"]);
  });

  it("chrome 조작면 사실을 ui.measure 응답에서 읽는다 — 도달 불가는 던지지 않고 값이 된다", () => {
    expect(deriveChromeControl({
      occlusion: { reachable: true, topTag: "button", topNode: "rail/add" },
      style: { zIndex: "420" },
    })).toEqual({ reachable: true, planeZ: 420 });
    expect(deriveChromeControl({ occlusion: { reachable: false }, style: { zIndex: "auto" } }))
      .toEqual({ reachable: false, planeZ: null });
    expect(deriveChromeControl(null)).toEqual({ reachable: false, planeZ: null });
    // 평면은 다른 노드에서 읽을 수 있다 — modal 은 card 의 도달성과 root 의 평면이 짝이다.
    expect(deriveChromeControl(
      { occlusion: { reachable: true }, style: { zIndex: "auto" } },
      { style: { zIndex: "300" } },
    )).toEqual({ reachable: true, planeZ: 300 });
  });

  it("층 stack 을 응답이 답한 소유자 사슬 + 실측 chromeAboveHost 로 쌓는다", () => {
    const sample = buildB09Sample({
      target: "modal/project-new",
      relation: "point-overlap",
      chromeRect: { x: 400, y: 200, w: 300, h: 200 },
      chromeControl: { reachable: true, planeZ: 400 },
      nativeSurface: SURFACE,
      point: { x: 600, y: 300 },
      hit: { owners: ["modal/project-new/card", "modal/project-new"] },
    });
    expect(sample.hit.topmostOwner).toBe("modal/project-new/card");
    expect(sample.hit.stack).toEqual([
      { kind: "chrome", owner: "modal/project-new/card", surfaceId: null },
      { kind: "chrome", owner: "modal/project-new", surfaceId: null },
      { kind: "native-surface", owner: "tab-right", surfaceId: "b-w-b09-tab-right" },
    ]);
    expect(Object.keys(sample).sort())
      .toEqual(["chromeControl", "chromeRect", "hit", "nativeSurface", "relation", "target"]);
  });

  it("실측이 chrome 위가 아니라고 답하면 native 층을 쌓지 않는다 — 없는 순서를 적지 않는다", () => {
    const sample = buildB09Sample({
      target: "sidebar/right",
      relation: "point-overlap",
      chromeRect: { x: 600, y: 140, w: 200, h: 400 },
      chromeControl: { reachable: true, planeZ: 200 },
      nativeSurface: { ...SURFACE, chromeAboveHost: false },
      point: { x: 700, y: 300 },
      hit: { owners: ["sidebar/right"] },
    });
    expect(sample.hit.stack).toEqual([
      { kind: "chrome", owner: "sidebar/right", surfaceId: null },
    ]);
    expect(sample.nativeSurface.chromeAboveHost).toBe(false);
  });

  it("겹치는 surface 가 없어도 비교 대상과 히트 좌표를 남긴다 — 던져서 지우지 않는다", () => {
    const chromeRect = { x: 0, y: 0, w: 20, h: 20 };
    const far = { ...SURFACE, rect: { x: 500, y: 500, w: 100, h: 100 } };
    const near = { ...SURFACE, viewId: "tab-left", rect: { x: 10, y: 10, w: 100, h: 100 } };
    expect(pickOverlapSurface(chromeRect, [far, near])).toBe(near);
    expect(pickOverlapSurface(chromeRect, [far])).toBe(far);
    expect(pickOverlapSurface(chromeRect, [])).toBeNull();
    expect(pickOverlapSurface(chromeRect, [{ ...SURFACE, rect: null }]))
      .toMatchObject({ rect: null });

    // 겹치면 교집합 중심, 안 겹치면 chrome 중심 — 둘 다 chrome rect 안이다.
    expect(probePointFor(chromeRect, near.rect)).toEqual({ x: 15, y: 15 });
    expect(probePointFor(chromeRect, far.rect)).toEqual({ x: 10, y: 10 });
    expect(probePointFor(chromeRect, null)).toEqual({ x: 10, y: 10 });
    // 1px 미만 겹침을 반올림으로 밖으로 밀지 않는다.
    expect(probePointFor(chromeRect, { x: 19.5, y: 0, w: 100, h: 20 }))
      .toEqual({ x: 19.75, y: 10 });
  });

  it("사슬이 비면 최상위 소유자는 null 이다 — target 을 대신 적지 않는다", () => {
    const sample = buildB09Sample({
      target: "rail/add",
      relation: "global-layer-order",
      chromeRect: { x: 8, y: 200, w: 36, h: 36 },
      chromeControl: { reachable: false, planeZ: null },
      nativeSurface: SURFACE,
      point: { x: 26, y: 218 },
      hit: { owners: [] },
    });
    expect(sample.hit.topmostOwner).toBeNull();
    expect(sample.hit.stack).toEqual([
      { kind: "native-surface", owner: "tab-right", surfaceId: "b-w-b09-tab-right" },
    ]);
  });
});
