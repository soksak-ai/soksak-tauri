// 렌더러 오류 원장 — 침묵 실패는 어떤 경우에도 허가하지 않는다(사용자 확정 2026-07-27).
// React 렌더 예외는 비동기 커밋이라 mount 호출부의 try/catch 가 못 잡고 콘솔에만 죽는다
// (실사고: 브라우저 뷰가 빈 absolute 래퍼만 남기고 침묵 — 화면은 빈공간, 원장은 무음).
// window error/unhandledrejection 을 활동 허브(renderer.error)로 발행해 어떤 창의 어떤
// 예외든 `sok events --kinds renderer.error` 로 기계 판독되게 한다. 발행 실패는 삼킨다
// (관측이 본체를 못 막는다). 같은 메시지의 반복은 창당 8회로 상한(폭주 억제 — 원인
// 1건이면 충분하고, 상한 도달 사실도 남긴다).
import { invoke } from "../framework";

const seen = new Map<string, number>();
const CAP = 8;

function publish(kind: "error" | "unhandledrejection", message: string, stack: string | null): void {
  const key = `${kind}:${message}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  if (n > CAP) return;
  void invoke("activity_publish", {
    kind: "renderer.error",
    source: "renderer",
    payload: {
      errorKind: kind,
      error: message.slice(0, 400),
      stack: stack?.slice(0, 1200) ?? null,
      repeat: n,
      capped: n === CAP,
      origin: "internal",
      message: `· renderer ${kind}: ${message.slice(0, 120)}`,
    },
  }).catch(() => {});
}

let installed = false;

export function installErrorLedger(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    const err = e.error as Error | undefined;
    publish("error", String(err?.message ?? e.message ?? "unknown"), err?.stack ?? null);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    publish("unhandledrejection", String(r?.message ?? e.reason ?? "unknown"), r?.stack ?? null);
  });
}
