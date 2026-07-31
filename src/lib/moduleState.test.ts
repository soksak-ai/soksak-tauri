// 모듈 전역 상태는 사라질 수 없어야 한다 — dev 갈아끼우기 경계.
//
// 실측(2026-07-31): 코어 명령 카탈로그가 통째로 사라졌다. 창은 살아 있고 플러그인 명령은
// 답하는데 `ui.*`·`state.*`·`window.*` 만 전부 UNKNOWN_COMMAND. 사용자에게는 "탭의 + 로
// 생성이 안 된다"로 보였다 — + 는 등록 프로그램이 0이면 사라지는 버튼이다.
//
// 원인은 등록이 **모듈 평가의 부수효과**라는 것이다. 등록부(Map)와 그것을 채우는 자리
// (executor 의 started 플래그)가 다른 모듈에 살아 따로 갈린다. Map 만 갈리면 새 빈 Map 이
// 되고, 채우는 쪽은 자기가 이미 돌았다고 알고 있어 다시 채우지 않는다 — 영영 빈 채로 남는다.
//
// 여기서는 그 갈아끼우기를 모듈 캐시 초기화로 재현한다. 같은 모듈을 두 번 평가했을 때
// 앞서 담은 것이 살아 있어야 한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("moduleState — 갈아끼워도 사라지지 않는다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("모듈이 다시 평가돼도 같은 것을 돌려준다", async () => {
    const first = await import("./moduleState");
    const boxA = first.moduleState("t/box", () => new Map<string, number>());
    boxA.set("x", 1);

    // dev 갈아끼우기 등가 — 모듈 인스턴스가 새로 평가된다.
    vi.resetModules();
    const second = await import("./moduleState");
    expect(second).not.toBe(first); // 오라클 생존: 정말 다시 평가됐는가
    const boxB = second.moduleState("t/box", () => new Map<string, number>());

    expect(boxB).toBe(boxA);
    expect(boxB.get("x")).toBe(1);
  });

  it("이름이 다르면 서로 섞이지 않는다", async () => {
    const m = await import("./moduleState");
    const a = m.moduleState("t/a", () => new Map<string, number>());
    const b = m.moduleState("t/b", () => new Map<string, number>());
    a.set("k", 1);
    expect(b.size).toBe(0);
  });
});

// 같은 이름을 다른 자리가 쓰면 **소리가 나야 한다** — 조용히 남의 값을 주면 그 상태는
// 자기 필드가 없는 채로 돌고, 그 침묵은 오류를 내지 않는다.
// 실측(2026-07-31): 한 파일에서 두 상태가 `#state` 를 함께 써서 뒤엣것이 앞엣것을 받았다.
describe("moduleState — 이름 충돌은 조용할 수 없다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("다른 모양이 같은 이름을 쓰면 거절한다", async () => {
    const m = await import("./moduleState");
    m.moduleState("t/clash", () => ({ a: 1 }));
    expect(() => m.moduleState("t/clash", () => ({ b: 2 }))).toThrow(/t\/clash/);
  });

  it("같은 자리의 재평가는 통과한다 — make 가 새 함수여도 모양이 같다", async () => {
    const m = await import("./moduleState");
    const first = m.moduleState("t/same", () => ({ a: 1 }));
    first.a = 9;
    const again = m.moduleState("t/same", () => ({ a: 1 }));
    expect(again).toBe(first);
    expect(again.a).toBe(9);
  });
});
