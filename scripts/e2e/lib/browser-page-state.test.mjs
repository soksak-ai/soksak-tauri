// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB11MachineEvidence } from "./browser-gates.mjs";
import { mapB11TabEvidence } from "./browser-live-evidence.mjs";
import { fullCaptureDocumentProbeJs } from "./browser-page-state.mjs";

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
});
