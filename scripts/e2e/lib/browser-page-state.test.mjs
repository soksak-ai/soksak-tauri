// @vitest-environment node
import { describe, expect, it } from "vitest";
import { B11_PAGE_KEYS, judgeB11MachineEvidence } from "./browser-gates.mjs";
import { mapB11TabEvidence } from "./browser-live-evidence.mjs";
import {
  captureDocumentGeometry,
  fullCaptureDocumentProbeJs,
  mapPageState,
  pageStateReaderAxes,
} from "./browser-page-state.mjs";

// 실측 fixture 기하 — 문서가 뷰포트보다 960px 넘게 길어야 B11이 스크롤 가능으로 인정한다.
const FIXTURE_PAGE = Object.freeze({
  scrollX: 0,
  scrollY: 0,
  innerWidth: 608,
  innerHeight: 262,
  document: { documentElement: { scrollWidth: 608, scrollHeight: 2140 } },
});

/**
 * eval 명령은 함수 본문을 페이지 전역 스코프에서 실행한다. with로 같은 식별자 해소를
 * 재현해 하니스가 보내는 JS 자체를 실행한다 — 문자열을 grep하지 않는다.
 */
function runPageProbe(js, page) {
  return new Function("__page", `with (__page) { ${js} }`)(page);
}

function b11TabsFromProbe(raw) {
  return ["view-0", "view-1"].map((viewId) => mapB11TabEvidence({
    viewId,
    scroll: { beforeY: 0, afterY: 480, restoredY: 0 },
    fullCapture: {
      requestedPath: `/evidence/full-${viewId}.png`,
      returnedPath: `/evidence/full-${viewId}.png`,
      reportedBytes: 4096,
      fileBytes: 4096,
      width: 608,
      height: 2140,
      viewId,
      before: raw,
      after: raw,
    },
  }));
}

describe("full capture page-state probe", () => {
  it("B11이 판정하는 모든 페이지 축을 실제 probe 실행 결과로 채운다", () => {
    const raw = runPageProbe(fullCaptureDocumentProbeJs(), FIXTURE_PAGE);
    const tabs = b11TabsFromProbe(raw);

    expect(tabs[0].capture.before).toEqual({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 608,
      viewportHeight: 262,
      documentWidth: 608,
      documentHeight: 2140,
    });
    expect(judgeB11MachineEvidence({ engine: "browser", tabs })).toMatchObject({ status: "green" });
  });

  it("가로로 스크롤된 페이지의 scrollX를 0으로 지어내지 않는다", () => {
    const raw = runPageProbe(fullCaptureDocumentProbeJs(), { ...FIXTURE_PAGE, scrollX: 37 });
    const tabs = b11TabsFromProbe(raw);

    expect(tabs[0].capture.before.scrollX).toBe(37);
    expect(judgeB11MachineEvidence({ engine: "browser", tabs })).toMatchObject({ status: "green" });
  });

  it("probe가 읽는 축과 판정이 요구하는 축이 정확히 같다", () => {
    expect([...pageStateReaderAxes()].sort()).toEqual([...B11_PAGE_KEYS].sort());
  });

  it("못 읽은 축을 0으로 채우지 않는다", () => {
    expect(mapPageState({ scrollY: 0 })).toEqual({
      scrollX: null,
      scrollY: 0,
      viewportWidth: null,
      viewportHeight: null,
      documentWidth: null,
      documentHeight: null,
    });
    expect(mapPageState(undefined).documentHeight).toBeNull();
  });

  it("이미 옮긴 상태를 다시 옮겨도 같다", () => {
    // 하니스는 probe 직후 한 번, mapB11TabEvidence가 다시 한 번 옮긴다.
    const once = mapPageState(runPageProbe(fullCaptureDocumentProbeJs(), FIXTURE_PAGE));
    expect(mapPageState(once)).toEqual(once);
    expect(b11TabsFromProbe(once)[0].capture.before).toEqual(once);
  });

  it("영수증 판정이 읽는 문서 기하로 같은 축을 옮긴다", () => {
    const state = mapPageState(runPageProbe(fullCaptureDocumentProbeJs(), FIXTURE_PAGE));
    expect(captureDocumentGeometry(state)).toEqual({
      y: 0,
      viewport: { w: 608, h: 262 },
      document: { w: 608, h: 2140 },
    });
  });
});
