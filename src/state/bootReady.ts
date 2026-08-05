import { useBootPhase } from "./bootPhase";

/** 폴링 없이 boot phase의 ready 사건을 기다리는 유한 barrier. */
export function awaitBootReady(timeoutMs = 30_000): Promise<{ phase: "ready" }> {
  if (useBootPhase.getState().phase === "ready") return Promise.resolve({ phase: "ready" });
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve({ phase: "ready" });
    };
    const timer = setTimeout(
      () => finish(new Error(`boot ready 시간 초과: ${timeoutMs}ms`)),
      timeoutMs,
    );
    unsubscribe = useBootPhase.subscribe((state) => {
      if (state.phase === "ready") finish();
    });
    // subscribe 직전 ready 전이와의 경쟁을 닫는다.
    if (useBootPhase.getState().phase === "ready") finish();
  });
}
