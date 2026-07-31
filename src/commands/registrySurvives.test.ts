// 명령 레지스트리는 사라질 수 없다 — 되던 것이 우연처럼 안 되면 안 된다.
//
// 실측(2026-07-31): 창은 살아 있고 플러그인 명령은 답하는데 `ui.*`·`state.*`·`window.*` 가
// 전부 UNKNOWN_COMMAND 였다. 사용자에게는 "탭의 + 로 생성이 안 된다"로 보였다 — + 는 등록
// 프로그램이 0이면 사라지는 버튼이라, 결함이 "버튼이 없다"로 위장했다.
//
// 원인은 등록이 모듈 평가의 부수효과라는 것이다. 등록부(registry Map)와 그것을 채우는 자리
// (executor 의 started 플래그)가 다른 모듈에 살아 **따로 갈린다**. Map 만 갈리면 새 빈 Map 이
// 되고, 채우는 쪽은 자기가 이미 돌았다고 알아 다시 채우지 않는다 — 영영 빈 채로 남는다.
//
// 두 방향을 다 못 박는다: 등록부만 갈려도 살고, 채우는 쪽만 갈려도 두 벌로 늘지 않는다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("명령 레지스트리 — 갈아끼워도 사라지지 않는다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("등록부 모듈만 다시 평가돼도 등록이 살아 있다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const before = await import("./registry");
    const names = before.catalogJson().map((c) => c.name);
    // 오라클 생존 — 처음부터 비어 있으면 이 검사는 아무것도 판정하지 못한다("0 의 두 얼굴").
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("state.commands");

    // dev 갈아끼우기 등가: 등록부 모듈만 새로 평가된다(채우던 쪽은 이미 돌았다고 안다).
    vi.resetModules();
    const after = await import("./registry");
    expect(after).not.toBe(before); // 정말 다시 평가됐는가

    expect(after.getSpec("state.commands")).toBeDefined();
    expect(after.catalogJson().length).toBe(names.length);
  });

  it("채우는 쪽이 다시 돌아도 두 벌로 늘지 않는다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    const n = reg.catalogJson().length;
    expect(n).toBeGreaterThan(0);

    // 채우는 쪽만 갈린 경우 — started 가 false 로 돌아와 다시 채우려 든다.
    vi.resetModules();
    const exec2 = await import("./executor");
    exec2.startExecutor();

    const reg2 = await import("./registry");
    // 중복 등록은 register 가 오류로 막는다. 그 오류가 부팅을 깨지 않고, 수도 그대로여야 한다.
    expect(reg2.catalogJson().length).toBe(n);
  });
});
