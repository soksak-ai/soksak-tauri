// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_ACCEPTANCE_ENGINES, judgeB11MachineEvidence } from "./browser-gates.mjs";

// 게이트 이름의 세 축(pane resize · wheel · full capture)을 한 봉투에 담은 실측 모양이다.
// gutter를 오른쪽으로 80px 끌면 왼쪽 pane은 80 넓어지고 오른쪽 pane은 80 좁아지며 x가 80 밀린다.
const DX = 80;
// 산출물 배율은 파이프라인마다 다르다(WebKit PDF 1x, Electron 타일 합성 device pixel).
const CAPTURE_SCALE = 2;

function wheelLedger(scrollSeq, wheelEvents, wheelDeltaY) {
  return { scrollSeq, wheelEvents, wheelDeltaY };
}

/** pane 한 순간 — pane rect, 그 위 native surface rect, 그 안 문서 뷰포트 폭을 함께 든다. */
function paneStage(settledAtUnixMs, { paneX, paneWidth, viewportWidth }) {
  return {
    settledAtUnixMs,
    paneX,
    paneWidth,
    surfaceX: paneX + 8,
    surfaceWidth: paneWidth - 16,
    viewportWidth,
  };
}

function b11Evidence(engine = "browser") {
  return {
    engine,
    tabs: ["left", "right"].map((side, index) => {
      const viewId = `${engine}-${side}`;
      const sign = side === "left" ? 1 : -1;
      const baseline = { paneX: index * 660, paneWidth: 660, viewportWidth: 640 };
      const wider = {
        paneX: baseline.paneX + (side === "left" ? 0 : DX),
        paneWidth: baseline.paneWidth + sign * DX,
        viewportWidth: baseline.viewportWidth + sign * DX,
      };
      const page = {
        scrollX: 0,
        scrollY: 0,
        viewportWidth: baseline.viewportWidth,
        viewportHeight: 480,
        documentWidth: baseline.viewportWidth,
        documentHeight: 1600 + index * 100,
      };
      return {
        viewId,
        wheel: {
          positions: [0, 480, 0],
          requestedDy: [480, -480],
          settledAtUnixMs: 1_000 + index,
          ledger: {
            before: wheelLedger(0, 0, 0),
            after: wheelLedger(6, 4, 480),
            restored: wheelLedger(11, 8, 0),
          },
        },
        capture: {
          before: page,
          receipt: {
            requestedViewId: viewId,
            returnedViewId: viewId,
            requestedPath: `/evidence/${engine}/${side}-full.png`,
            returnedPath: `/evidence/${engine}/${side}-full.png`,
            reportedBytes: 4096 + index,
            fileBytes: 4096 + index,
            width: page.documentWidth,
            docHeight: page.documentHeight,
            capturedWidth: page.documentWidth * CAPTURE_SCALE,
            capturedHeight: page.documentHeight * CAPTURE_SCALE,
          },
          after: { ...page },
        },
        paneResize: {
          paneId: `pane-${side}`,
          side,
          requestedDx: DX,
          stages: {
            baseline: paneStage(2_000 + index, baseline),
            wider: paneStage(3_000 + index, wider),
            restored: paneStage(4_000 + index, baseline),
          },
        },
      };
    }),
  };
}

describe("B11 pane-resize/scroll/full-capture judge", () => {
  it("세 축을 모두 실측으로 증명한 증거만 green이다", () => {
    for (const engine of BROWSER_ACCEPTANCE_ENGINES) {
      expect(judgeB11MachineEvidence(b11Evidence(engine))).toMatchObject({ status: "green", reason: null });
    }
    expect(judgeB11MachineEvidence(null)).toEqual({ status: "not-run", evidence: [], reason: null });
    expect(judgeB11MachineEvidence({ engine: "browser", tabs: [] }).status).toBe("red");
  });

  it("자기 자신만 맞대는 옛 봉투는 green이 될 수 없다", () => {
    // 옛 모양: wheel은 자기 입력을 되돌려준 좌표 세 개뿐이고, capture 범위는 요청에 쓴 문서
    // 크기와 하니스가 같은 식으로 읽은 문서 크기를 맞댄 순환이며, pane resize는 아예 없다.
    const legacy = {
      engine: "browser",
      tabs: b11Evidence().tabs.map((tab) => ({
        viewId: tab.viewId,
        wheel: { positions: tab.wheel.positions },
        capture: {
          before: tab.capture.before,
          receipt: {
            requestedViewId: tab.capture.receipt.requestedViewId,
            returnedViewId: tab.capture.receipt.returnedViewId,
            requestedPath: tab.capture.receipt.requestedPath,
            returnedPath: tab.capture.receipt.returnedPath,
            reportedBytes: tab.capture.receipt.reportedBytes,
            fileBytes: tab.capture.receipt.fileBytes,
            width: tab.capture.receipt.width,
            docHeight: tab.capture.receipt.docHeight,
          },
          after: tab.capture.after,
        },
      })),
    };
    expect(judgeB11MachineEvidence(legacy).status).toBe("red");
  });

  it("pane resize를 재지 않은 증거는 게이트 이름의 절반을 증명하지 못한다", () => {
    const noPane = b11Evidence();
    for (const tab of noPane.tabs) delete tab.paneResize;
    expect(judgeB11MachineEvidence(noPane).status).toBe("red");

    const halfPane = b11Evidence();
    delete halfPane.tabs[1].paneResize.stages.restored;
    expect(judgeB11MachineEvidence(halfPane).status).toBe("red");
  });

  it("pane이 요청한 만큼 움직이지 않거나 돌아오지 않으면 red다", () => {
    const frozenPane = b11Evidence();
    frozenPane.tabs[0].paneResize.stages.wider.paneWidth
      = frozenPane.tabs[0].paneResize.stages.baseline.paneWidth;
    expect(judgeB11MachineEvidence(frozenPane).status).toBe("red");

    const shortDrag = b11Evidence();
    shortDrag.tabs[1].paneResize.stages.wider.paneX -= 12;
    expect(judgeB11MachineEvidence(shortDrag).status).toBe("red");

    const notRestored = b11Evidence();
    notRestored.tabs[0].paneResize.stages.restored.paneWidth += 40;
    expect(judgeB11MachineEvidence(notRestored).status).toBe("red");
  });

  it("표면과 문서 뷰포트가 자기 pane을 따라가지 않으면 red다", () => {
    const strandedSurface = b11Evidence();
    strandedSurface.tabs[0].paneResize.stages.wider.surfaceWidth
      = strandedSurface.tabs[0].paneResize.stages.baseline.surfaceWidth;
    expect(judgeB11MachineEvidence(strandedSurface).status).toBe("red");

    const strandedViewport = b11Evidence();
    strandedViewport.tabs[1].paneResize.stages.wider.viewportWidth
      = strandedViewport.tabs[1].paneResize.stages.baseline.viewportWidth;
    expect(judgeB11MachineEvidence(strandedViewport).status).toBe("red");
  });

  it("두 pane은 서로 반대로 움직이고 선언한 side는 실측 좌표와 맞아야 한다", () => {
    const sameSide = b11Evidence();
    sameSide.tabs[1].paneResize.side = "left";
    expect(judgeB11MachineEvidence(sameSide).status).toBe("red");

    const swappedSide = b11Evidence();
    swappedSide.tabs[0].paneResize.side = "right";
    swappedSide.tabs[1].paneResize.side = "left";
    expect(judgeB11MachineEvidence(swappedSide).status).toBe("red");
  });

  it("측정 시점이 뭉개진 증거는 두 사건을 함께 증명한 것이 아니다", () => {
    const oneMoment = b11Evidence();
    for (const tab of oneMoment.tabs) {
      const { stages } = tab.paneResize;
      stages.wider.settledAtUnixMs = stages.baseline.settledAtUnixMs;
      stages.restored.settledAtUnixMs = stages.baseline.settledAtUnixMs;
    }
    expect(judgeB11MachineEvidence(oneMoment).status).toBe("red");

    const captureAfterResize = b11Evidence();
    captureAfterResize.tabs[0].wheel.settledAtUnixMs
      = captureAfterResize.tabs[0].paneResize.stages.restored.settledAtUnixMs + 1;
    expect(judgeB11MachineEvidence(captureAfterResize).status).toBe("red");
  });

  it("영수증이 자기 요청을 되돌려주는 것만으로는 full capture 범위를 증명하지 못한다", () => {
    // 실측 이전의 봉투 모양 — receipt.width/docHeight는 캡처 요청에 쓴 문서 크기를 그대로
    // 되돌려준 값이고 capture.before는 하니스가 같은 식으로 읽은 값이다. 산출물은 없다.
    const circular = b11Evidence();
    for (const tab of circular.tabs) {
      delete tab.capture.receipt.capturedWidth;
      delete tab.capture.receipt.capturedHeight;
    }
    expect(judgeB11MachineEvidence(circular).status).toBe("red");

    // 못 읽은 크기를 0으로 채우면 실패가 성공값으로 둔갑한다 — null도 red다.
    const unreadable = b11Evidence();
    unreadable.tabs[0].capture.receipt.capturedWidth = null;
    unreadable.tabs[0].capture.receipt.capturedHeight = null;
    expect(judgeB11MachineEvidence(unreadable).status).toBe("red");
  });

  it("뷰포트 한 장만 담긴 산출물을 full capture로 인정하지 않는다", () => {
    const viewportOnly = b11Evidence();
    for (const tab of viewportOnly.tabs) {
      tab.capture.receipt.capturedHeight = tab.capture.before.viewportHeight * CAPTURE_SCALE;
    }
    expect(judgeB11MachineEvidence(viewportOnly).status).toBe("red");

    const shrunk = b11Evidence();
    for (const tab of shrunk.tabs) {
      tab.capture.receipt.capturedWidth = Math.round(tab.capture.before.documentWidth / 2);
      tab.capture.receipt.capturedHeight = Math.round(tab.capture.before.documentHeight / 2);
    }
    expect(judgeB11MachineEvidence(shrunk).status).toBe("red");

    const stretched = b11Evidence();
    stretched.tabs[0].capture.receipt.capturedHeight += 200;
    expect(judgeB11MachineEvidence(stretched).status).toBe("red");
  });

  it("1x 파이프라인이 그대로 담은 산출물도 green이다", () => {
    // 배율은 파이프라인마다 다르다 — 절대 크기가 아니라 두 축의 배율 일치와 축소 없음이 기준이다.
    const onePixelPerCss = b11Evidence();
    for (const tab of onePixelPerCss.tabs) {
      tab.capture.receipt.capturedWidth = tab.capture.before.documentWidth;
      tab.capture.receipt.capturedHeight = tab.capture.before.documentHeight;
    }
    expect(judgeB11MachineEvidence(onePixelPerCss).status).toBe("green");
  });

  it("휠 사건 없이 움직인 스크롤은 wheel 증거가 아니다", () => {
    const noWheelEvent = b11Evidence();
    noWheelEvent.tabs[0].wheel.ledger.after.wheelEvents
      = noWheelEvent.tabs[0].wheel.ledger.before.wheelEvents;
    expect(judgeB11MachineEvidence(noWheelEvent).status).toBe("red");

    const noScrollEvent = b11Evidence();
    noScrollEvent.tabs[1].wheel.ledger.restored.scrollSeq
      = noScrollEvent.tabs[1].wheel.ledger.after.scrollSeq;
    expect(judgeB11MachineEvidence(noScrollEvent).status).toBe("red");

    const wrongDirection = b11Evidence();
    wrongDirection.tabs[0].wheel.ledger.restored.wheelDeltaY
      = wrongDirection.tabs[0].wheel.ledger.after.wheelDeltaY + 480;
    expect(judgeB11MachineEvidence(wrongDirection).status).toBe("red");

    const missingLedger = b11Evidence();
    delete missingLedger.tabs[0].wheel.ledger;
    expect(judgeB11MachineEvidence(missingLedger).status).toBe("red");
  });

  it("요청한 휠 델타와 관측한 이동량이 어긋나면 red다", () => {
    const wrongWheel = b11Evidence();
    wrongWheel.tabs[0].wheel.positions = [0, 479, 0];
    expect(judgeB11MachineEvidence(wrongWheel).status).toBe("red");

    const wrongRequest = b11Evidence();
    wrongRequest.tabs[0].wheel.requestedDy = [240, -240];
    expect(judgeB11MachineEvidence(wrongRequest).status).toBe("red");
  });

  it("명시한 view·경로·바이트·문서 상태 계약은 그대로 유지된다", () => {
    const wrongView = b11Evidence();
    wrongView.tabs[0].capture.receipt.returnedViewId = wrongView.tabs[1].viewId;
    expect(judgeB11MachineEvidence(wrongView).status).toBe("red");

    for (const field of [
      "requestedPath", "returnedPath", "reportedBytes", "fileBytes", "width", "docHeight",
    ]) {
      const missingReceipt = b11Evidence();
      delete missingReceipt.tabs[0].capture.receipt[field];
      expect(judgeB11MachineEvidence(missingReceipt).status).toBe("red");
    }

    const wrongPathAndBytes = b11Evidence();
    wrongPathAndBytes.tabs[0].capture.receipt.returnedPath = "/evidence/wrong.png";
    wrongPathAndBytes.tabs[0].capture.receipt.fileBytes += 1;
    expect(judgeB11MachineEvidence(wrongPathAndBytes).status).toBe("red");

    const changedScroll = b11Evidence();
    changedScroll.tabs[0].capture.after.scrollY = 480;
    expect(judgeB11MachineEvidence(changedScroll).status).toBe("red");

    const changedDimensions = b11Evidence();
    changedDimensions.tabs[1].capture.after.documentHeight += 1;
    expect(judgeB11MachineEvidence(changedDimensions).status).toBe("red");

    // 픽셀을 푼 값(마커·색)은 여전히 기계 판정의 입력이 아니다 — 사람의 시각 검토가 소유한다.
    const pixelInput = b11Evidence();
    pixelInput.tabs[0].capture.receipt.markerPixels = { red: 64 };
    expect(judgeB11MachineEvidence(pixelInput).status).toBe("red");
  });
});
