// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  judgeB01MachineEvidence,
  judgeB02MachineEvidence,
  judgeB11MachineEvidence,
} from "./browser-gates.mjs";
import {
  mapB01NavigationEvidence,
  mapB01TabEvidence,
  mapB11TabEvidence,
  mapImeObservation,
} from "./browser-live-evidence.mjs";

const engine = "browser";

function liveB01Tab(index, { nodePath = "urlbar" } = {}) {
  const viewId = `view-${index}`;
  const nonce = `nonce-${index}`;
  const identityUrl = `https://fixture.invalid/b01-identity?slot=${index}&nonce=${nonce}`;
  const expectedUrl = `https://fixture.invalid/?slot=${index}`;
  return mapB01TabEvidence({
    viewId,
    expectedUrl,
    mountReceipt: { mounted: true },
    navigations: [
      mapB01NavigationEvidence({
        requestedViewId: viewId,
        url: identityUrl,
        expectedTitle: `B01 Identity ${nonce}`,
        expectedBodyIncludes: nonce,
        navigateReceipt: { viewId },
        urlbarMeasure: { dataset: { node: nodePath }, value: identityUrl },
        pageIdentity: {
          url: identityUrl,
          title: `B01 Identity ${nonce}`,
          bodyText: `B01 identity view ${nonce}`,
        },
        observationError: null,
      }),
      mapB01NavigationEvidence({
        requestedViewId: viewId,
        url: expectedUrl,
        expectedTitle: "Browser Boundary",
        expectedBodyIncludes: "Browser Boundary",
        navigateReceipt: { viewId },
        urlbarMeasure: { dataset: { node: nodePath }, value: expectedUrl },
        pageIdentity: {
          url: expectedUrl,
          title: "Browser Boundary",
          bodyText: "Browser Boundary DOM slot ↔ live browser surface",
        },
        observationError: null,
      }),
    ],
  });
}

const B11_PAGE = Object.freeze({
  scrollX: 0,
  scrollY: 0,
  viewportWidth: 640,
  viewportHeight: 480,
  documentWidth: 640,
  documentHeight: 1600,
});

function liveB11Tab(index) {
  const viewId = `view-${index}`;
  const requestedPath = `/evidence/full-${index}.png`;
  return {
    viewId,
    scroll: { beforeY: 0, afterY: 480, restoredY: 0 },
    fullCapture: {
      requestedPath,
      fileBytes: 4096,
      before: B11_PAGE,
      after: B11_PAGE,
      viewId,
      returnedPath: requestedPath,
      reportedBytes: 4096,
      width: 640,
      height: 1600,
    },
  };
}

describe("live browser evidence mappers", () => {
  it("maps every real navigation's mount, address bar, page identity, and navigate receipt into B01", () => {
    const tabs = [0, 1].map((index) => liveB01Tab(index));
    expect(tabs.map((tab) => tab.navigations.length)).toEqual([2, 2]);
    expect(judgeB01MachineEvidence({ engine, tabs }).status).toBe("green");
  });

  it("maps a discovered namespaced public node path to its exact urlbar role", () => {
    const tabs = [0, 1].map((index) => liveB01Tab(index, {
      nodePath: `tauri/plugin-view/b-window-view-${index}/urlbar`,
    }));

    expect(tabs.flatMap((tab) => tab.navigations.map((step) => step.toolbarAddress.dataNode)))
      .toEqual(["urlbar", "urlbar", "urlbar", "urlbar"]);
    expect(judgeB01MachineEvidence({ engine, tabs }).status).toBe("green");
  });

  it("keeps missing public B01 receipt facts null so the judge stays RED", () => {
    const step = mapB01NavigationEvidence({
      requestedViewId: "view-0",
      url: "https://fixture.invalid/",
      expectedTitle: "Browser Boundary",
      expectedBodyIncludes: "Browser Boundary",
    });
    expect(step.returnedViewId).toBeNull();
    expect(step.pageIdentity).toEqual({ url: null, title: null, bodyText: null });
    const tab = mapB01TabEvidence({
      viewId: "view-0",
      expectedUrl: "https://fixture.invalid/",
      navigations: [step, step],
    });
    expect(tab.mounted).toBeNull();
    expect(judgeB01MachineEvidence({ engine, tabs: [tab, tab] }).status).toBe("red");
  });

  it("carries a live observation failure as a named B01 fact instead of throwing", () => {
    const step = mapB01NavigationEvidence({
      requestedViewId: "view-0",
      url: "https://fixture.invalid/",
      expectedTitle: "Browser Boundary",
      expectedBodyIncludes: "Browser Boundary",
      observationError: "dom.wait-for TIMEOUT(8000ms)",
    });
    expect(step.observation).toEqual({ error: "dom.wait-for TIMEOUT(8000ms)" });
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
    // probe가 실제로 내보내는 축 이름 그대로다 — mapper가 받아 주는 별도 모양을
    // 지어내면 fixture만 green이 되고 실측은 null로 남는다.
    const tabs = [0, 1].map((index) => mapB11TabEvidence(liveB11Tab(index)));
    expect(judgeB11MachineEvidence({ engine, tabs }).status).toBe("green");
  });

  it("records a clean B11 tab wiring ledger on the green path", () => {
    expect(mapB11TabEvidence(liveB11Tab(0)).evidenceWiring).toEqual({
      source: "B11.tab",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
  });

  it("names a drifted B11 tab field on both sides instead of losing the capture", () => {
    const value = liveB11Tab(0);
    value.capture = value.fullCapture;
    delete value.fullCapture;
    const tab = mapB11TabEvidence(value);
    expect(tab.evidenceWiring).toEqual({
      source: "B11.tab",
      unconsumed: ["capture"],
      unproduced: ["fullCapture"],
      error: null,
    });
    const verdict = judgeB11MachineEvidence({ engine, tabs: [tab, mapB11TabEvidence(liveB11Tab(1))] });
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.capture=produced-not-consumed");
    expect(verdict.evidence).toContain("B11:wiring.B11.tab.fullCapture=consumed-not-produced");
  });

  it("names a B11 tab field that throws instead of killing the harness", () => {
    const value = liveB11Tab(0);
    Object.defineProperty(value, "scroll", {
      enumerable: true,
      get() {
        throw new TypeError("wheel receipt read failed");
      },
    });
    let verdict;
    expect(() => {
      verdict = judgeB11MachineEvidence({
        engine,
        tabs: [mapB11TabEvidence(value), mapB11TabEvidence(liveB11Tab(1))],
      });
    }).not.toThrow();
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toContain(
      'B11:wiring.B11.tab=mapper-threw/"TypeError: wheel receipt read failed"',
    );
  });
});
