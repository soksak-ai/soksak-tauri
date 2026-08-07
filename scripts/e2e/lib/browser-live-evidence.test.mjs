// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeB01MachineEvidence, judgeB02MachineEvidence } from "./browser-gates.mjs";
import {
  mapB01NavigationEvidence,
  mapB01TabEvidence,
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
});

// 규칙 — 읽는 필드는 답하는 쪽이 내는 이름이어야 한다.
//
// 실측 2026-08-08: `ui.focus.state` 가 활성 뷰를 `activeTabId` 로 답하는데 소비처가
// `activeElement.viewId` 를 읽었다. 없는 필드는 조용히 undefined 라 두 탭이 나란히 null 을
// 답했고, 판정은 "아무도 안 밝혔다" 로 읽어 세 엔진의 B02 가 red 가 됐다. 오류는 없었고 답만
// 틀렸다.
describe("포커스 소유는 창이 답한 이름에서 읽는다", () => {
  it("activeTabId 를 소유자로 읽는다", () => {
    // 이 관측이 어느 탭에서 났는지는 부르는 쪽이 안다 — 창은 "지금 누가 쥐었나" 만 답한다.
    const mapped = mapImeObservation({ value: "가", active: true, tabId: "tab-a" }, {
      activeTabId: "tab-a",
    });
    expect(mapped.inputFocus).toEqual({ owner: "tab-a", self: true });
  });

  it("요청한 탭이 아니면 self 가 아니다 — 창의 소유자는 여전히 하나다", () => {
    const mapped = mapImeObservation({ tabId: "tab-b" }, { activeTabId: "tab-a" });
    expect(mapped.inputFocus).toEqual({ owner: "tab-a", self: false });
  });

  it("창이 아무도 안 쥐었다고 답하면 그 사실을 그대로 싣는다", () => {
    expect(mapImeObservation({}, { activeTabId: null }).inputFocus)
      .toEqual({ owner: null, self: false });
  });

  it("못 물어봤으면 그 자리를 비운다 — 없는 것과 다른 답이다", () => {
    expect(mapImeObservation({}).inputFocus).toBeUndefined();
    expect(mapImeObservation({}, null).inputFocus).toBeUndefined();
  });
});
