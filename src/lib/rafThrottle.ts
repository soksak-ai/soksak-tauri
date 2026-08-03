// 고빈도 이벤트(mousemove 등)를 프레임당 1회로 합치는 스로틀.
// 성능 헌법 원칙 4(docs/PERFORMANCE.md): 연속 입력은 rAF 로 coalesce 하고,
// 제스처 종료 시 flush() 로 마지막 값을 반드시 커밋한다(리스너 제거 전에 —
// 아니면 마지막 프레임이 유실돼 스냅백한다).

export interface RafThrottled<A extends unknown[]> {
  (...args: A): void;
  /** 대기 중인 호출을 버린다(언마운트/취소 경로). */
  cancel(): void;
  /** 대기 중인 호출이 있으면 지금 즉시 실행한다(mouseup 커밋 경로). */
  flush(): void;
}

export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): RafThrottled<A> {
  let rafId = 0;
  let task: MessageChannel | null = null;
  let scheduled = false;
  let lastArgs: A | null = null;

  const clearSchedule = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    task?.port1.close();
    task?.port2.close();
    task = null;
    scheduled = false;
  };

  const invoke = () => {
    clearSchedule();
    if (lastArgs === null) return;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };

  const throttled = (...args: A) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    // 전면 입력은 compositor 프레임당 1회로 합친다. 비전면 WebKit은 rAF를 멈추므로
    // 포커스를 빼앗지 않는 자동화가 마지막 값조차 커밋하지 못한다. 그 경우에만 다음 task
    // 사건으로 같은 coalesce 계약을 수행한다. timer·반복 감시·프레임워크 분기는 없다.
    if (typeof document !== "undefined" && !document.hasFocus()) {
      task = new MessageChannel();
      task.port1.onmessage = invoke;
      task.port2.postMessage(null);
    } else {
      rafId = requestAnimationFrame(invoke);
    }
  };

  throttled.cancel = () => {
    clearSchedule();
    lastArgs = null;
  };

  throttled.flush = () => {
    clearSchedule();
    invoke();
  };

  return throttled;
}
