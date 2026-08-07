// B01(최초 mount + 주소표시줄 + 페이지 신원)의 실측 소유자.
//
// 한 번만 연 문서로는 주소표시줄이 신원을 따라왔다는 사실을 잴 수 없다. 그래서 탭마다 실제
// 항해를 두 번 시킨다: view 마다 다른 문서(고유 nonce)로 한 번, 뒤 게이트가 딛고 설 정본
// 문서로 한 번. 두 번 모두 주소표시줄·문서 제목·본문을 읽어 judge 에 싣는다.
//
// 계약 위반은 던지지 않는다. 항해가 실패하거나 주소가 노출되지 않은 사실은 observation.error 로
// 실려 judge 가 RED 로 판정하고 보고서에 이름으로 남는다. 던지는 것은 측정 자체가 불가능할 때
// (창이 답을 안 하거나 layout 을 못 읽을 때)뿐이다.

import { randomUUID } from "node:crypto";
import { must } from "./client.mjs";
import { browserTabNodeAddress } from "./browser-ui-addresses.mjs";
import { FIXTURE_PAGE_TITLE, unwrapEvalValue } from "./browser-matrix.mjs";
import {
  mapB01NavigationEvidence,
  mapB01TabEvidence,
} from "./browser-live-evidence.mjs";

export const B01_IDENTITY_PATH = "b01-identity";
export const B01_IDENTITY_TITLE_PREFIX = "B01 Identity ";
export const B01_IDENTITY_BODY_PREFIX = "B01 identity view ";
const NONCE_PATTERN = /^[a-z0-9-]{8,64}$/;

/** 페이지가 자기 신원을 스스로 답한다. 요청 URL에서 제목이나 본문을 지어내지 않는다. */
export const B01_PAGE_IDENTITY_JS = [
  "const body = document.body;",
  "const raw = body ? (typeof body.innerText === 'string' ? body.innerText : body.textContent) : null;",
  "return {",
  "  url: location.href,",
  "  title: document.title,",
  "  bodyText: typeof raw === 'string' ? raw.replace(/\\s+/g, ' ').trim().slice(0, 240) : null,",
  "};",
].join("\n");

export function b01IdentityFixtureHtml(nonce) {
  if (!NONCE_PATTERN.test(String(nonce))) {
    throw new Error(`B01 identity nonce는 ${NONCE_PATTERN} 여야 한다: ${nonce}`);
  }
  return `<!doctype html><html data-b01-nonce="${nonce}"><head><meta charset="utf-8">`
    + `<title>${B01_IDENTITY_TITLE_PREFIX}${nonce}</title></head>`
    + `<body style="margin:0;background:#101820;color:#f7f4df;font:24px system-ui">`
    + `<main><h1>B01 identity</h1><p id="b01-nonce">${B01_IDENTITY_BODY_PREFIX}${nonce}</p></main>`
    + `</body></html>`;
}

/** 픽스처 서버의 B01 구간. 이 경로가 아니면 null 이라 나머지는 정본 문서가 답한다. */
export function renderB01IdentityFixture(request) {
  const target = new URL(String(request?.url ?? "/"), "http://127.0.0.1");
  if (target.pathname !== `/${B01_IDENTITY_PATH}`) return null;
  const nonce = target.searchParams.get("nonce");
  return NONCE_PATTERN.test(String(nonce)) ? b01IdentityFixtureHtml(nonce) : null;
}

/**
 * 한 탭이 실제로 밟을 항해 목록. 마지막 항목은 언제나 정본 문서다 — 뒤 게이트가 그 문서를 딛고
 * 선다. 첫 항목은 이 view 만이 답할 수 있는 nonce 문서라 다른 view 의 답을 받아 오면 갈린다.
 */
export function b01NavigationPlan({ pageUrl, slot, nonce }) {
  if (!NONCE_PATTERN.test(String(nonce))) {
    throw new Error(`B01 identity nonce는 ${NONCE_PATTERN} 여야 한다: ${nonce}`);
  }
  const identityUrl = `${pageUrl}${B01_IDENTITY_PATH}?slot=${slot}&nonce=${nonce}`;
  return [
    {
      url: identityUrl,
      expectedTitle: `${B01_IDENTITY_TITLE_PREFIX}${nonce}`,
      expectedBodyIncludes: `${B01_IDENTITY_BODY_PREFIX}${nonce}`,
      readySelector: `html[data-b01-nonce="${nonce}"] #b01-nonce`,
    },
    {
      url: `${pageUrl}?slot=${slot}`,
      expectedTitle: FIXTURE_PAGE_TITLE,
      expectedBodyIncludes: FIXTURE_PAGE_TITLE,
      readySelector: `html[data-slot="${slot}"] #ime`,
    },
  ];
}

function failureText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 한 항해를 관측한다.
 *
 * 두 실패를 가른다. 문서가 그 view 에 서지 못한 것(pageError)은 뒤 게이트가 딛고 설 바닥이
 * 없다는 뜻이라 측정 불가로 이어진다. 주소표시줄이 노출되지 않은 것은 B01 이 판정할 계약
 * 위반이지 다른 게이트의 측정을 막을 이유가 아니다. 둘 다 observation.error 로 이름을 얻는다.
 */
async function observeB01Navigation({ rpc, win, plugin, viewId, step }) {
  let navigateReceipt = null;
  let pageIdentity = null;
  let urlbarMeasure = null;
  let pageError = null;
  let addressError = null;
  try {
    navigateReceipt = must(
      await rpc(`plugin.${plugin}.navigate`, { viewId, url: step.url }, win),
      `navigate ${viewId}`,
    );
    // 최초 CEF 표면은 child readiness(유한 8s) 뒤 페이지 MutationObserver(유한 8s)가 이어진다.
    // 라우터 기본 10s로 거래를 중간 절단하지 않고 이 장기 명령이 자기 상한을 명시한다.
    must(
      await rpc(
        `plugin.${plugin}.dom.wait-for`,
        { selector: step.readySelector, timeoutMs: 8_000, viewId },
        win,
        { timeoutMs: 30_000 },
      ),
      `browser ready ${viewId}`,
    );
    pageIdentity = unwrapEvalValue(must(
      await rpc(`plugin.${plugin}.eval`, { viewId, js: B01_PAGE_IDENTITY_JS }, win),
      `page identity ${viewId}`,
    ));
  } catch (error) {
    pageError = failureText(error);
  }

  // Child PluginView의 공개 node projection은 main DOM layout과 별도 renderer 사건이다.
  // page readiness만으로는 programmatic urlbar value의 projection ACK가 보장되지 않는다.
  // 공용 event-driven layout barrier가 child 측정을 요청하고 native presentation까지
  // 정착시킨 뒤에만 B01 값을 읽는다(고정 대기·재시도·private DOM 조회 없음).
  must(
    await rpc("ui.layout.wait-settled", { timeoutMs: 8_000 }, win, { timeoutMs: 10_000 }),
    "B01 projected urlbar settled",
  );
  const tree = must(await rpc("ui.tree", { rects: true }, win), "ui.tree");
  try {
    urlbarMeasure = must(
      await rpc("ui.measure", { address: browserTabNodeAddress(tree, viewId, "urlbar") }, win),
      `urlbar measure ${viewId}`,
    );
  } catch (error) {
    addressError = failureText(error);
  }

  return {
    pageError,
    navigation: mapB01NavigationEvidence({
      requestedViewId: viewId,
      url: step.url,
      expectedTitle: step.expectedTitle,
      expectedBodyIncludes: step.expectedBodyIncludes,
      navigateReceipt,
      urlbarMeasure,
      pageIdentity,
      observationError: pageError ?? addressError,
    }),
  };
}

/**
 * 두 탭의 B01 증거를 실측으로 채운다.
 *
 * blockedReason 은 뒤 게이트가 딛고 설 정본 문서가 서지 못했다는 사실만 담는다. 그 값이 있어도
 * B01 판정은 이미 기록된 뒤다 — 계약 위반은 차단 이전에 이름을 얻는다.
 */
export async function collectB01LiveEvidence({
  rpc,
  win,
  plugin,
  engine,
  pageUrl,
  tabIds,
  mountReceipts,
  newNonce = () => randomUUID(),
}) {
  const tabs = [];
  const blocked = [];
  for (let index = 0; index < tabIds.length; index += 1) {
    const candidate = tabIds[index];
    const viewId = typeof candidate === "string" && candidate.trim() !== "" ? candidate : null;
    const plan = b01NavigationPlan({ pageUrl, slot: index, nonce: newNonce() });
    const expectedUrl = plan.at(-1).url;
    if (viewId === null) {
      blocked.push(`tab[${index}] view id 없음: ${JSON.stringify(candidate)}`);
      tabs.push(mapB01TabEvidence({
        viewId,
        expectedUrl,
        mountReceipt: mountReceipts[index],
        navigations: plan.map((step) => mapB01NavigationEvidence({
          requestedViewId: viewId,
          url: step.url,
          expectedTitle: step.expectedTitle,
          expectedBodyIncludes: step.expectedBodyIncludes,
          observationError: "탭 view id 가 없어 항해를 요청하지 못했다",
        })),
      }));
      continue;
    }
    must(await rpc("tab.activate", { tab: viewId }, win), `tab.activate ${viewId}`);
    const navigations = [];
    let canonicalPageError = null;
    for (const step of plan) {
      const observed = await observeB01Navigation({ rpc, win, plugin, viewId, step });
      navigations.push(observed.navigation);
      canonicalPageError = observed.pageError;
    }
    if (canonicalPageError !== null) {
      blocked.push(`tab[${index}] 정본 문서 미도달: ${canonicalPageError}`);
    }
    tabs.push(mapB01TabEvidence({
      viewId,
      expectedUrl,
      mountReceipt: mountReceipts[index],
      navigations,
    }));
  }
  return {
    evidence: { engine, tabs },
    blockedReason: blocked.length > 0 ? blocked.join("; ") : null,
  };
}
