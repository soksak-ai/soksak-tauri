/**
 * 표시 궤적을 여는 동안 "가려져도 그린다"는 앱의 보장을 든다.
 *
 * macOS 는 다른 앱에 완전히 덮인 창의 표시 콜백을 멈춘다. 그러면 거래 창 안에 표시 표본이 하나도
 * 안 들어오고, 그 자리는 못 잼(blocked)이 된다. 그런데 이 앱은 그 보장을 이미 낼 수 있다
 * (`window.occlusion {"enabled":false}`) — 낼 수 있는 보장을 안 내고 못 잼으로 넘기는 것은
 * 기준 회피다. 그러니 이 축은 blocked 로 남을 자리가 아니라 green/red 로 판정될 자리다.
 *
 * 이 보장은 OS 표면(UI 스크립팅·보조 접근)에 기대지 않고 창을 전면화하지도 않는다. 포커스는
 * 사용자가 요청할 때만 준다. 그래서 든 것은 반드시 놓는다 — 사용자 창에 우리 상태를 남기지 않는다.
 */

/**
 * 무장이 덮어야 하는 native webview 수 — 선언한 표면 전부와 main renderer 하나.
 *
 * `window.occlusion` 이 `webviews` 를 답하는 이유가 이것이다: "capture automation can reject a
 * main-only partial arm". 덜 무장된 것을 성공으로 읽으면, 그 다음 표본 부재는 창이 가려졌는지가
 * 아니라 우리가 무장을 덜 한 것이고, 그 사실이 blocked 라는 이름 뒤로 숨는다.
 */
export function presentationOcclusionArmFloor(surfaces) {
  return surfaces + 1;
}

/**
 * 무장 영수증이 이 궤적의 표면을 다 덮었는가. 아니면 그 자리에서 이름과 함께 거절한다.
 *
 * @param {{ webviews?: unknown }} receipt `window.occlusion` 영수증
 * @param {number} surfaces 이 궤적이 선언한 표시 표면 수
 */
export function assertPresentationOcclusionArmed(receipt, surfaces) {
  if (!Number.isInteger(surfaces) || surfaces <= 0) {
    throw new Error(`presentation occlusion surfaces=positive/${surfaces}`);
  }
  const floor = presentationOcclusionArmFloor(surfaces);
  const webviews = Number(receipt?.webviews);
  if (!Number.isFinite(webviews) || webviews < floor) {
    throw new Error(`presentation occlusion arm=${receipt?.webviews}/${floor}`);
  }
}

/**
 * @param {object} input
 * @param {(enabled: boolean) => Promise<{ occlusion: boolean, webviews: number }>} input.setOcclusion
 * @param {number} input.surfaces 이 궤적이 선언한 표시 표면 수
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 * @template T
 */
export async function withPresentationOcclusionOff({ setOcclusion, surfaces }, body) {
  if (!Number.isInteger(surfaces) || surfaces <= 0) {
    throw new Error(`presentation occlusion surfaces=positive/${surfaces}`);
  }
  const armed = await setOcclusion(false);
  try {
    assertPresentationOcclusionArmed(armed, surfaces);
  } catch (error) {
    // 무장이 덜 됐으면 원상 복구부터 하고 거절한다 — 실패한 무장의 상태를 창에 남기지 않는다.
    await setOcclusion(true);
    throw error;
  }
  try {
    return await body();
  } finally {
    await setOcclusion(true);
  }
}
