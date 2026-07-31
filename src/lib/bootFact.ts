// 부팅 단계 사실의 payload 단일 진실 — **어느 창의 단계인가**를 빠뜨리지 않는다.
//
// 실측(2026-08-01): 창 둘이 뜬 상태에서 하나가 아무것도 그리지 않았다. 원장에는 `painted` 와
// `boot:done` 이 둘씩 있었지만 **창이 안 적혀 있어** 어느 쪽이 그렸는지 가릴 수 없었다. 발행
// 자리가 셋인데 창을 싣는 곳이 하나뿐이었다 — 각자 payload 를 손으로 만들면 갈린다.
//
// 발행 자체는 여기서 하지 않는다. 부팅 초기는 일반 invoke 를 쓸 수 없는 구간이 있어 호출부가
// 자기 통로를 갖는다. 이 파일은 **무엇을 실을지**만 정한다.
import { currentWindowLabel } from "./webviewLabels";

/**
 * `boot.step` payload — step 과 창은 이 함수만이 붙인다.
 *
 * extra 는 그 단계 고유의 사실(소요 ms·상위 플러그인 등). step·window·message 를 덮어쓰지
 * 못한다: 덮어쓰면 같은 이름의 필드가 자리마다 다른 뜻이 된다.
 */
export function bootFactPayload(
  step: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    step,
    window: currentWindowLabel(),
    message: `· boot ${step}`,
  };
}
