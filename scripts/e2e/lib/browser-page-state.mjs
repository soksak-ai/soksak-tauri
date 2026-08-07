import { B11_PAGE_KEYS } from "./browser-gates.mjs";
import {
  EVIDENCE_WIRING_KEY,
  isRecord,
  mapWithWiring,
} from "./browser-machine-judge-support.mjs";

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
