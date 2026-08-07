import { B11_PAGE_KEYS } from "./browser-gate-b11.mjs";
import {
  EVIDENCE_WIRING_KEY,
  isRecord,
  mapWithWiring,
} from "./browser-machine-judge-support.mjs";
import { unwrapEvalValue } from "./browser-matrix.mjs";

/**
 * 각 페이지 축을 페이지에서 읽는 식. 축 목록은 판정(B11_PAGE_KEYS)이 소유하고
 * 여기서는 읽는 방법만 적는다. 축이 늘면 읽는 식 없는 축에서 probe가 즉시 죽는다 —
 * 판정이 요구하는 축을 조용히 null로 흘려보내지 않는다.
 */
const PAGE_AXIS_READERS = Object.freeze({
  scrollX: "scrollX",
  scrollY: "scrollY",
  viewportWidth: "innerWidth",
  viewportHeight: "innerHeight",
  documentWidth: "Math.max(innerWidth,document.documentElement.scrollWidth)",
  documentHeight: "Math.max(innerHeight,document.documentElement.scrollHeight)",
});

/** probe가 읽는 축. 판정이 요구하는 축과 정확히 같아야 한다. */
export function pageStateReaderAxes() {
  return Object.keys(PAGE_AXIS_READERS);
}

/**
 * 하니스가 보내는 eval 본문. 문자열을 호출부에 다시 적으면 검사받지 않는 사본이 생긴다.
 */
export function fullCaptureDocumentProbeJs() {
  const missing = B11_PAGE_KEYS.filter((axis) => !Object.hasOwn(PAGE_AXIS_READERS, axis));
  if (missing.length > 0) {
    throw new Error(`page-state probe에 읽는 식이 없는 축: ${missing.join(",")}`);
  }
  const fields = B11_PAGE_KEYS.map((axis) => `${axis}:(${PAGE_AXIS_READERS[axis]})`).join(",");
  return `return {${fields}};`;
}

/**
 * eval 봉투가 페이지 답 위에 얹는 자기 축.
 *
 * 봉투는 "누가 답했는가"(viewId)를 싣는다. 페이지는 그 이름으로 답하지 않는다 — probe 가 답하는
 * 축은 PAGE_AXIS_READERS 가 전부다. 그리고 이 축은 판정의 사실도 아니다: 읽기는 매번 뷰를 명시해
 * 보내고(viewId: tabId), 두 구현 모두 그 뷰를 못 찾으면 명령 자체를 거절해 must() 가 던진다.
 * 돌아온 이름은 우리가 보낸 이름을 같은 등록부에서 다시 푼 값이라 자기 자신과 맞대는 영수증이다.
 *
 * 여기 적힌 이름만 걷어낸다. 봉투가 다른 축을 더 실으면 그 이름은 그대로 남아 배선 장부가
 * produced-not-consumed 로 부른다 — 모르는 것을 조용히 버리지 않는다.
 */
const EVAL_REPLY_ENVELOPE_KEYS = Object.freeze(["viewId"]);

/**
 * eval 봉투를 열어 페이지가 답한 기록만 남긴다.
 *
 * 두 구현이 같은 질문에 다른 모양으로 답한다. WKWebView 구현은 페이지 답을 value 아래 싣고
 * (unwrapEvalValue 가 그 포장을 소유한다), Chromium 구현은 봉투에 펼쳐 실어 자기 축이 페이지
 * 축과 한자리에 섞인다. 펼친 쪽을 열지 않으면 봉투 축이 페이지 기록에 남아 판정이 그 이름을
 * 부른다(실측 2026-08-07 browser-chromium B11: wiring.B11.page.viewId=produced-not-consumed).
 *
 * 봉투를 여는 자리는 하나다. 포장 차이를 판정이나 mapper 가 알게 하면 게이트가 엔진마다 다른
 * 질문을 하게 된다.
 */
export function openPageStateReply(reply) {
  const unwrapped = unwrapEvalValue(reply);
  if (!isRecord(unwrapped)) return unwrapped;
  const page = {};
  for (const [key, value] of Object.entries(unwrapped)) {
    if (!EVAL_REPLY_ENVELOPE_KEYS.includes(key)) page[key] = value;
  }
  return page;
}

const finiteOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * probe 결과를 판정이 읽는 축으로 옮긴다. 못 읽은 축은 null로 남긴다 — 0으로 채우면
 * 실패가 성공값으로 둔갑한다.
 *
 * 읽은 축과 probe가 실제로 내보낸 축은 배선 장부로 맞댄다. eval 응답을 벗기지 않고 넘기면
 * 여섯 축이 한꺼번에 null이 되는데, 그 원인은 봉투 이름 하나다 — 값 증상 여섯 개가 아니라
 * 그 이름이 판정에 실려야 한다.
 *
 * 이미 장부를 든 상태는 다시 재지 않고 그 장부를 그대로 잇는다. 배선은 probe와 첫 독자 사이의
 * 사실이라 두 번째 독자가 다시 잴 수 없다 — 다시 재면 두 번째 옮김이 첫 장부를 지운다.
 */
export function mapPageState(raw) {
  if (isRecord(raw) && raw[EVIDENCE_WIRING_KEY] !== undefined) {
    const state = {};
    for (const axis of B11_PAGE_KEYS) state[axis] = finiteOrNull(raw[axis]);
    state[EVIDENCE_WIRING_KEY] = raw[EVIDENCE_WIRING_KEY];
    return state;
  }
  return mapWithWiring(raw, "B11.page", (checkpoint) => {
    const state = {};
    for (const axis of B11_PAGE_KEYS) state[axis] = finiteOrNull(checkpoint.take(axis));
    return state;
  });
}

/**
 * fullCaptureReceiptVerdict가 읽는 문서 기하 모양. 축의 뜻은 하나고 모양만 옮긴다.
 */
export function captureDocumentGeometry(state) {
  return {
    y: state?.scrollY ?? null,
    viewport: { w: state?.viewportWidth ?? null, h: state?.viewportHeight ?? null },
    document: { w: state?.documentWidth ?? null, h: state?.documentHeight ?? null },
  };
}
