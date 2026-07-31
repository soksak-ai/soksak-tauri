// 절름거리는 축은 **모든 응답이 말한다** — 따로 물어봐야 아는 사실은 아무도 안 묻는다.
//
// 실측(2026-07-31): 활동 허브 발행이 끊긴 채로 앱은 멀쩡히 명령에 답했다. 그 사실을 알아내려면
// 원장을 두 번 조회해 최신 시각을 비교해야 했다 — 진단이 아니라 수작업이다. 무엇을 물었든
// 코어가 절름거리면 그 답에 실려 와야 한다.
//
// 판정에는 "언제부터 그것이 있어야 하는가"가 필요하다. 부팅이 배선을 끝냈다고 선언하기 전에는
// 미설치가 결함이 아니다(아직 붙이는 중이거나 그 부분을 안 켠 하니스다). 그 선언이 없으면
// 부팅 중인 앱과 고장난 앱이 똑같아 보인다.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

const SPEC = {
  description: "fixture",
  params: {},
  returns: "void",
  message: () => "ok",
  handler: () => ({}),
};

describe("응답이 절름거리는 축을 말한다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("배선 완료 선언 전에는 아무 말도 하지 않는다", async () => {
    const reg = await import("./registry");
    reg.register("d.fixture", SPEC as never);
    const r = await reg.execute("d.fixture", {}, {});
    expect(r.ok).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  it("배선 완료 뒤 계측 sink 가 없으면 응답이 그렇게 말한다", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    reg.register("d.fixture", SPEC as never);
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // 실행은 성공한다 — 관측이 죽었다고 동작을 막지 않는다.
    expect(r.ok).toBe(true);
    // 그러나 침묵하지 않는다.
    expect(r.degraded?.some((d) => d.includes("계측 sink"))).toBe(true);
  });

  it("허브 발행을 한 번도 시도하지 않았으면 그 사실도 말한다", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    reg.register("d.fixture", SPEC as never);
    obs.setCommandTraceSink(() => {});
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // 시도 0 은 "건강"이 아니라 미확인이다 — 배선이 통째로 빠진 창과 잘 도는 창을 가른다.
    expect(r.degraded?.some((d) => d.includes("한 번도 시도"))).toBe(true);
  });

  it("배선이 성하면 축을 말하지 않는다", async () => {
    const reg = await import("./registry");
    const obs = await import("./commandObservation");
    const health = await import("../state/activityHealth");
    reg.register("d.fixture", SPEC as never);
    obs.setCommandTraceSink(() => {});
    health.notePublish(true, 1000);
    obs.markRuntimeReady();

    const r = await reg.execute("d.fixture", {}, {});
    // 오라클 생존 — 성한 배선에서도 축이 뜨면 이 검사는 아무것도 가르지 못한다.
    expect(r.degraded).toBeUndefined();
  });
});
