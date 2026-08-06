// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  judgeB01MachineEvidence,
  judgeB02MachineEvidence,
  judgeB11MachineEvidence,
} from "./browser-gates.mjs";
import { mapB01TabEvidence, mapB11TabEvidence, mapImeObservation } from "./browser-live-evidence.mjs";

const engine = "browser";

describe("live browser evidence mappers", () => {
  it("maps public mount, DOM value, page identity, and navigate receipts into B01", () => {
    const tabs = [0, 1].map((index) => {
      const viewId = `view-${index}`;
      const expectedUrl = `https://fixture.invalid/?slot=${index}`;
      return mapB01TabEvidence({
        viewId,
        expectedUrl,
        mountReceipt: { mounted: true },
        urlbarMeasure: { dataset: { node: "urlbar" }, value: expectedUrl },
        pageIdentity: { viewId, url: expectedUrl },
        navigateReceipt: { viewId },
      });
    });
    expect(judgeB01MachineEvidence({ engine, tabs }).status).toBe("green");
  });

  it("keeps missing public B01 receipt facts null so the judge stays RED", () => {
    const tab = mapB01TabEvidence({ viewId: "view-0", expectedUrl: "https://fixture.invalid/" });
    expect(tab.commandReceipt.returnedViewId).toBeNull();
    expect(judgeB01MachineEvidence({ engine, tabs: [tab, tab] }).status).toBe("red");
  });

  it("maps the actual IME event ledger without synthesizing counters", () => {
    expect(mapImeObservation({
      value: "한글 입력",
      active: true,
      ledger: { beforeInput: 1, inputEvents: 1, values: ["한글 입력"] },
    })).toEqual({
      value: "한글 입력",
      active: true,
      ledger: { beforeInput: 1, inputEvents: 1, values: ["한글 입력"] },
    });
    expect(mapImeObservation({}).ledger.beforeInput).toBeNull();
    expect(judgeB02MachineEvidence(undefined).status).toBe("not-run");
  });

  it("maps wheel and full-capture command/file receipts into B11", () => {
    const tabs = [0, 1].map((index) => {
      const viewId = `view-${index}`;
      const requestedPath = `/evidence/full-${index}.png`;
      const dimensions = {
        y: 0,
        x: 0,
        viewport: { w: 640, h: 480 },
        document: { w: 640, h: 1600 },
      };
      return mapB11TabEvidence({
        viewId,
        scroll: { beforeY: 0, afterY: 480, restoredY: 0 },
        fullCapture: {
          requestedPath,
          fileBytes: 4096,
          before: dimensions,
          after: dimensions,
          viewId,
          returnedPath: requestedPath,
          reportedBytes: 4096,
          width: 640,
          height: 1600,
        },
      });
    });
    expect(judgeB11MachineEvidence({ engine, tabs }).status).toBe("green");
  });
});
