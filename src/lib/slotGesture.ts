// 클릭 확인 후 이동(§12-④ 개정) — 슬롯 활성화(와 그에 따르는 투영 주행·재배열)는
// mousedown 이 아니라 게스처가 완결되는 mouseup 에 실행한다.
//
// 근거(실측 포커스 trace): mousedown 즉시 이동을 시작하면 이동막·재배열이 게스처의 남은
// 구간과 후속 클릭의 이벤트를 캡처해 죽이고, 포커스 재배달이 직전/첫 페인으로 가서
// "클릭한 곳에 포커스가 안 간다"가 된다. 순서를 바꾸면 게스처 전 구간이 정지한 기하
// 위에서 끝나므로 클릭은 항상 확인되고, mouseup 이 어디에 떨어지든 활성화는 게스처를
// 시작한 슬롯에 귀속된다(straddle 구조적 불능) — 주행 중 입력 차단이 필요 없어진다.
export function armSlotActivation(activate: () => void): void {
  window.addEventListener("mouseup", () => activate(), {
    capture: true,
    once: true,
  });
}
