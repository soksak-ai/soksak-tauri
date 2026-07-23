// 클릭 확인 후 이동(§12-④ 개정) — 슬롯 활성화(와 그에 따르는 투영 주행·재배열)는
// mousedown 이 아니라 게스처 완결 시점에 실행한다.
//
// 근거(실측 포커스 trace): mousedown 즉시 이동을 시작하면 이동막·재배열이 게스처의 남은
// 구간과 후속 클릭의 이벤트를 캡처해 죽인다. 또한 macOS 창 활성화 클릭은 mouseup 이
// mousedown 보다 먼저 배달되는 뒤엉킴이 실측됐다 — mouseup 만 기다리면 활성화가 다음
// 무관한 클릭에 잘못 귀속된다("되었다 안 되었다"). 완결 신호는 셋 중 선착이다:
//  ① mouseup(정상 게스처) ② 다음 mousedown(= 이전 게스처는 확실히 끝났다) ③ 350ms 타이머
//    (신호 유실 폴백 — 홀드 중이어도 350ms 후 활성화, 종전 즉시-활성화와 동일한 체감).
// 어느 신호든 활성화는 게스처를 시작한 슬롯에 귀속된다(straddle 구조적 불능).
const FALLBACK_MS = 350;

export function armSlotActivation(activate: () => void): void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    window.removeEventListener("mouseup", fire, true);
    window.removeEventListener("mousedown", fire, true);
    window.clearTimeout(timer);
    activate();
  };
  window.addEventListener("mouseup", fire, { capture: true });
  window.addEventListener("mousedown", fire, { capture: true });
  const timer = window.setTimeout(fire, FALLBACK_MS);
}
