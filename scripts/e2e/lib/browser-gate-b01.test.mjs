// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  B01_IDENTITY_PATH,
  b01NavigationPlan,
  collectB01LiveEvidence,
  renderB01IdentityFixture,
} from "./browser-gate-b01.mjs";
import { judgeB01MachineEvidence } from "./browser-gates.mjs";

const PAGE_URL = "http://127.0.0.1:4242/";
const ENGINE = "browser";
const PLUGIN = "soksak-plugin-browser";

function nonceFor(index) {
  return `b01-nonce-${index}${"0".repeat(4)}`;
}

/** 살아있는 앱 대신 공개 명령의 답만 흉내 낸다. 실패 주입은 fail(method) 로 이름을 준다. */
function fakeApp({ tabIds, fail = () => null, urlbarExposed = () => true, staleUrlbar = false }) {
  const location = new Map(tabIds.map((id) => [id, "about:blank"]));
  const shown = new Map(tabIds.map((id) => [id, "about:blank"]));
  const calls = [];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    const failure = fail(method, params);
    if (failure) return { ok: false, code: "E", message: failure };
    if (method === `plugin.${PLUGIN}.navigate`) {
      location.set(params.viewId, params.url);
      if (!staleUrlbar) shown.set(params.viewId, params.url);
      return { ok: true, data: { viewId: params.viewId } };
    }
    if (method === `plugin.${PLUGIN}.eval`) {
      const url = location.get(params.viewId);
      const document = renderB01IdentityFixture({ url: url.slice(PAGE_URL.length - 1) });
      return {
        ok: true,
        data: {
          viewId: params.viewId,
          value: {
            url,
            title: document
              ? document.match(/<title>([^<]*)<\/title>/)[1]
              : "Browser Boundary",
            bodyText: document
              ? `B01 identity ${document.match(/id="b01-nonce">([^<]*)</)[1]}`
              : "Browser Boundary DOM slot ↔ live browser surface",
          },
        },
      };
    }
    if (method === "ui.tree") {
      return {
        ok: true,
        data: {
          nodes: tabIds.filter(urlbarExposed).map((id) => ({
            address: `w/tab/${id}/urlbar`,
            nodePath: "plugin-view/urlbar",
          })),
        },
      };
    }
    if (method === "ui.measure") {
      const tabId = tabIds.find((id) => params.address.includes(`/tab/${id}/`));
      return {
        ok: true,
        data: { dataset: { node: "plugin-view/urlbar" }, value: shown.get(tabId) ?? null },
      };
    }
    return { ok: true, data: {} };
  };
  return { rpc, calls };
}

async function collect(options = {}) {
  const tabIds = options.tabIds ?? ["view-left", "view-right"];
  const app = fakeApp({ ...options, tabIds });
  const result = await collectB01LiveEvidence({
    rpc: app.rpc,
    win: "w-fixture",
    plugin: PLUGIN,
    engine: ENGINE,
    pageUrl: PAGE_URL,
    tabIds,
    mountReceipts: options.mountReceipts ?? [{ mounted: true }, { mounted: true }],
    newNonce: (() => {
      let index = 0;
      return () => nonceFor(index++);
    })(),
  });
  return { ...result, calls: app.calls };
}

describe("B01 라이브 수집", () => {
  it("픽스처 서버는 자기 경로에서만 view 고유 문서를 답한다", () => {
    const nonce = nonceFor(0);
    const html = renderB01IdentityFixture({ url: `/${B01_IDENTITY_PATH}?slot=0&nonce=${nonce}` });
    expect(html).toContain(`<title>B01 Identity ${nonce}</title>`);
    expect(html).toContain(`data-b01-nonce="${nonce}"`);
    expect(renderB01IdentityFixture({ url: "/?slot=0" })).toBeNull();
    expect(renderB01IdentityFixture({ url: `/${B01_IDENTITY_PATH}?slot=0` })).toBeNull();
    expect(renderB01IdentityFixture({ url: `/${B01_IDENTITY_PATH}?nonce=<script>` })).toBeNull();
  });

  it("항해 계획은 view 고유 문서로 시작해 정본 문서로 끝난다", () => {
    const plan = b01NavigationPlan({ pageUrl: PAGE_URL, slot: 1, nonce: nonceFor(1) });
    expect(plan).toHaveLength(2);
    expect(plan[0].url).toBe(`${PAGE_URL}${B01_IDENTITY_PATH}?slot=1&nonce=${nonceFor(1)}`);
    expect(plan[0].readySelector).toBe(`html[data-b01-nonce="${nonceFor(1)}"] #b01-nonce`);
    expect(plan.at(-1).url).toBe(`${PAGE_URL}?slot=1`);
    expect(plan.at(-1).expectedTitle).toBe("Browser Boundary");
    expect(() => b01NavigationPlan({ pageUrl: PAGE_URL, slot: 0, nonce: "x" })).toThrow(/nonce/);
  });

  it("탭마다 실제 항해를 두 번 밟고 그 증거가 judge에서 green이다", async () => {
    const { evidence, blockedReason, calls } = await collect();
    expect(blockedReason).toBeNull();
    expect(evidence.tabs.map((tab) => tab.navigations.length)).toEqual([2, 2]);
    expect(calls.filter(({ method }) => method === `plugin.${PLUGIN}.navigate`)).toHaveLength(4);
    expect(judgeB01MachineEvidence(evidence)).toMatchObject({ status: "green", reason: null });
  });

  it("주소표시줄이 옛 문서에 멈추면 던지지 않고 그 값을 이름으로 남긴다", async () => {
    const { evidence, blockedReason } = await collect({ staleUrlbar: true });
    expect(blockedReason).toBeNull();
    const verdict = judgeB01MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("\n")).toContain("navigations[0].toolbarAddress.value=");
  });

  it("항해 실패는 관측 실패로 실리고 정본 문서 미도달만 뒤 측정을 막는다", async () => {
    const { evidence, blockedReason } = await collect({
      fail: (method) => (method === `plugin.${PLUGIN}.dom.wait-for` ? "TIMEOUT(8000ms)" : null),
    });
    expect(blockedReason).toMatch(/정본 문서 미도달/);
    const verdict = judgeB01MachineEvidence(evidence);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence.join("\n")).toContain("observation.error=null/");
  });

  it("주소표시줄 노드가 안 보이면 그 사실만 red로 남고 수집은 계속한다", async () => {
    const { evidence, blockedReason } = await collect({
      urlbarExposed: (id) => id !== "view-right",
    });
    expect(blockedReason).toBeNull();
    expect(evidence.tabs[1].navigations[0].toolbarAddress).toEqual({ dataNode: null, value: null });
    expect(judgeB01MachineEvidence(evidence).status).toBe("red");
  });

  it("탭 id가 없으면 항해를 요청하지 않고 그 사실을 판정과 차단 사유로 함께 남긴다", async () => {
    const { evidence, blockedReason, calls } = await collect({ tabIds: ["view-left", null] });
    expect(blockedReason).toMatch(/view id 없음/);
    expect(calls.filter(({ method }) => method === `plugin.${PLUGIN}.navigate`)).toHaveLength(2);
    expect(evidence.tabs[1].viewId).toBeNull();
    expect(judgeB01MachineEvidence(evidence).status).toBe("red");
  });

  it("mount 영수증이 거짓이어도 던지지 않고 mounted 사실로 판정한다", async () => {
    const { evidence, blockedReason } = await collect({
      mountReceipts: [{ mounted: false }, { mounted: true }],
    });
    expect(blockedReason).toBeNull();
    expect(judgeB01MachineEvidence(evidence).evidence).toContain("B01:tabs[0].mounted=true/false");
  });
});
