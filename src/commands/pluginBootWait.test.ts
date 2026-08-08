// @vitest-environment jsdom
// **플러그인 부팅이 끝났는지 물을 자리.**
//
// 워크스페이스 부팅 위상(`app.boot.wait`)이 준비라고 답해도 플러그인 본문은 아직 돈다 —
// 실측 2026-08-08: 그 위상을 기다린 뒤 원장을 읽었는데 번들 도장이 아직 없었다. 두 사실은
// 다른 것이고, 다른 것을 같은 이름으로 물으면 판정이 "잰 적 없음"으로 막힌다.
//
// 그 경계는 이미 코드에 있다 — `markCommandHostReady`. 부르는 쪽이 밖에서 그것을 기다릴 수
// 있어야 한다. 되묻지 않는다: 이미 지난 사실이면 즉시 답하고, 아니면 그 사건에 걸린다.
import { describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { markCommandHostReady, awaitCommandHostReady } from "./executor";
import { registerBootCatalog } from "./catalogBoot";
import { execute, getSpec } from "./registry";

registerBootCatalog();

describe("플러그인 부팅 완료를 밖에서 기다린다", () => {
  // 상한을 넘기면 "준비됐다" 가 아니라 그 사실을 답한다 — 못 기다림을 성공으로 표현할 수 없다.
  //
  // 이 검사가 **먼저** 온다. 준비는 한 번 세우면 되돌릴 수 없는 사실이고(되돌리는 문을 만들면
  // 그 문으로 제품이 준비를 잃는다), 모듈을 새로 적재해도 그 기억은 모듈 경계 밖에 산다.
  it("상한을 넘기면 이름으로 거절한다", async () => {
    await expect(awaitCommandHostReady(10)).rejects.toThrow(/부팅/);
  });

  it("명령이 있고 무엇을 답하는지 밝힌다", () => {
    const spec = getSpec("plugin.boot.wait");
    expect(spec).toBeDefined();
    expect(spec?.returns).toContain("ready");
  });

  // 이미 지난 사실을 영영 기다리면 부르는 쪽은 상한으로만 죽는다.
  it("이미 끝났으면 즉시 답한다", async () => {
    markCommandHostReady();
    await expect(awaitCommandHostReady(50)).resolves.toEqual({ ready: true });
    const out = await execute("plugin.boot.wait", { timeoutMs: 50 }, {});
    expect(out.ok).toBe(true);
  });

});
