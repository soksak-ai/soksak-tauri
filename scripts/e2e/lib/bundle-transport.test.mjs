// 판정기 자신의 검사 — 이 판정이 무엇을 통과시키고 무엇을 막는지 값으로 고정한다.
import { describe, expect, it } from "vitest";
import { bundleTransportVerdict } from "./bundle-transport.mjs";

const stamp = (step) => ({ step });

describe("bundleTransportVerdict", () => {
  it("전부 지나고 예산 안이면 통과", () => {
    const out = bundleTransportVerdict({ steps: [stamp("plugins:prefetched:34/34:41ms")] });
    expect(out.status).toBe("green");
    expect(out.evidence).toContain("bundles=34/34");
  });

  // 통로가 막히면 부팅이 안 죽는다 — 활성화가 하나씩 다시 읽어 느려진 채로 정상처럼 돈다.
  it("하나라도 못 지나면 red 이고 몇 개인지 말한다", () => {
    const out = bundleTransportVerdict({
      steps: [stamp("plugins:prefetched:0/34:1ms"), stamp("prefetch-failed:34:Load failed")],
    });
    expect(out.status).toBe("red");
    expect(out.reason).toContain("34개");
    expect(out.reason).toContain("Load failed");
  });

  it("예산을 넘으면 red — 그것이 IPC 로 되돌아간 신호다", () => {
    const out = bundleTransportVerdict({ steps: [stamp("plugins:prefetched:34/34:818ms")] });
    expect(out.status).toBe("red");
    expect(out.evidence).toContain("transport=818ms/200ms");
  });

  // 잰 적 없음은 통과가 아니다.
  it("도장이 없으면 blocked", () => {
    expect(bundleTransportVerdict({ steps: [] }).status).toBe("blocked");
  });

  // 0/0 을 통과로 읽으면 플러그인이 하나도 안 뜬 부팅이 가장 빠른 부팅이 된다.
  it("원한 것이 없으면 blocked — 0/0 은 통과가 아니다", () => {
    expect(bundleTransportVerdict({ steps: [stamp("plugins:prefetched:0/0:0ms")] }).status).toBe("blocked");
  });
});
