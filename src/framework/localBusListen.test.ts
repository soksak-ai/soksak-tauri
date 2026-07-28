// 구독 하나가 **두 출처**를 받는다 — 프레임워크가 미는 것과 이 창이 뿌리는 것.
//
// RED 근거(실측 2026-07-28, 살아있는 앱): 브라우저 콘텐츠 뷰가 example.com 을 렌더했는데
// 주소창은 about:blank 에 멈춰 있었다. 항해 사건(browser-nav)은 이 창 안에서 나는 사실이라
// emitLocal 로 뿌려지는데, 플러그인은 전역 listen 으로 구독한다 — 그 전역 listen 이 프레임워크
// push 채널만 잇고 로컬 버스를 안 이어 사건이 영영 도착하지 않았다.
//
// 창-스코프 listen 은 이미 둘을 잇고 그 자리에 이유까지 적혀 있다("나뉘면 호출자가 어느
// 쪽인지 알아야 하고, 아는 순간 경계가 샌다"). 전역만 그 법을 어겼다.
//
// 침묵은 오류로 보고되지 않는다: 뿌린 쪽은 성공했고 구독자는 그냥 안 불린다. 그래서 여기서
// 기계가 본다 — 뿌린 것이 구독자에게 **도착하는지**.

import { describe, expect, it, vi } from "vitest";

/** preload 창구 대역 — 프레임워크 push 채널만 갖는다(로컬 버스는 어댑터의 것). */
function stubBridge() {
  const pushed = new Map<string, Set<(p: unknown) => void>>();
  (globalThis as Record<string, unknown>).__soksakFramework = {
    name: "electron",
    label: "w-test",
    invoke: async () => ({ ok: true, value: null }),
    native: async () => ({ ok: true, value: null }),
    onEvent: (event: string, cb: (p: unknown) => void) => {
      let set = pushed.get(event);
      if (!set) pushed.set(event, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
    onWindowEvent: () => () => {},
    createStream: () => ({ __frameworkStream: "s-test" }),
  };
  return {
    push: (event: string, payload: unknown) => {
      for (const cb of pushed.get(event) ?? []) cb(payload);
    },
  };
}

async function load() {
  vi.resetModules();
  return import("./electron");
}

describe("전역 구독은 두 출처를 받는다", () => {
  it("이 창이 뿌린 사건이 전역 구독자에게 도착한다", async () => {
    stubBridge();
    const { electronFramework: fw } = await load();
    const seen: unknown[] = [];
    await fw.listen("browser-nav", (e) => seen.push(e.payload));

    fw.emitLocal("browser-nav", { label: "b-1", url: "https://example.com" });

    expect(seen, "로컬 사건이 전역 구독자에게 안 왔다 — 주소창이 멈추는 자리다").toEqual([
      { label: "b-1", url: "https://example.com" },
    ]);
  });

  it("프레임워크가 민 사건도 같은 구독으로 온다", async () => {
    const b = stubBridge();
    const { electronFramework: fw } = await load();
    const seen: unknown[] = [];
    await fw.listen("boot.step", (e) => seen.push(e.payload));

    b.push("boot.step", { step: "ready" });

    expect(seen).toEqual([{ step: "ready" }]);
  });

  /** 해지는 양쪽을 다 끊는다 — 한쪽이 남으면 죽은 구독자가 계속 불린다. */
  it("해지하면 어느 출처의 사건도 오지 않는다", async () => {
    const b = stubBridge();
    const { electronFramework: fw } = await load();
    const seen: unknown[] = [];
    const off = await fw.listen("x", (e) => seen.push(e.payload));
    await off();

    fw.emitLocal("x", 1);
    b.push("x", 2);

    expect(seen).toEqual([]);
  });
});
