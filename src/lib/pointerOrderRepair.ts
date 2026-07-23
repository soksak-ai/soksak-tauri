// 포인터 순서 복구 — 유령 홀드 닫기.
//
// 실측(포커스 trace): macOS 창 활성화 클릭은 mouseup 을 유실하거나 mousedown 보다 먼저
// 배달할 수 있다(6104ms mousedown → 다음 up 2.7s 뒤). up 을 못 받은 소비자(xterm·ghostty
// 선택 서비스 등)는 버튼이 눌린 줄 알고 이후의 물리 이동을 드래그 선택으로 그린다 —
// "클릭만 했는데 거대 선택". 코어 입력 경계가 홀드 상태를 추적하고, buttons=0(실제로
// 안 눌림)인 mousemove 가 오면 마지막 mousedown 대상에 mouseup 을 합성해 즉시 닫는다.
// 정상 드래그(buttons=1)와 실 mouseup 경로는 건드리지 않는다. 리스너 3개, 폴링 없음.
export function startPointerOrderRepair(): () => void {
  let heldTarget: EventTarget | null = null;

  const onDown = (e: MouseEvent) => {
    heldTarget = e.target;
  };
  const onUp = () => {
    heldTarget = null;
  };
  const onMove = (e: MouseEvent) => {
    if (!heldTarget || e.buttons !== 0) return;
    const target = heldTarget;
    heldTarget = null; // 재진입 방지 — 합성 up 이 onUp 을 다시 태워도 무해
    target.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        composed: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: 0,
        buttons: 0,
      }),
    );
  };

  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("mousemove", onMove, true);
  return () => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("mousemove", onMove, true);
  };
}
