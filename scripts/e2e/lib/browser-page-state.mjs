import { B11_PAGE_KEYS } from "./browser-gates.mjs";

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
 * probe 결과를 판정이 읽는 축으로 옮긴다. 못 읽은 축은 null로 남긴다 — 0으로 채우면
 * 실패가 성공값으로 둔갑한다.
 */
export function mapPageState(raw) {
  const state = {};
  for (const axis of B11_PAGE_KEYS) {
    const value = raw?.[axis];
    state[axis] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return state;
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
