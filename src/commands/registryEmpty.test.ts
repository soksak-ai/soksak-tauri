// 빈 등록부는 "그 이름이 없다"와 다른 사실이다 — 뭉개면 원인을 못 읽는다.
//
// 실측(2026-07-31): 코어 명령이 통째로 사라졌는데 응답은 `UNKNOWN_COMMAND: 알 수 없는 명령:
// ui.validate` 였다. 그 문장은 "그 이름은 원래 없다"와 글자 그대로 같아서, 밖에서는 등록부가
// 비었다는 사실을 읽을 방법이 없었다. 원인을 찾는 데 두 시간이 걸렸고, 사용자에게는 "탭의
// + 로 생성이 안 된다"라는 엉뚱한 증상으로만 보였다.
//
// 0 은 두 얼굴이다: "찾아봤는데 없음"과 "찾을 곳 자체가 빔". 두 번째는 결함이고, 결함은
// 자기 이름으로 답해야 한다.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("빈 등록부는 자기 이름으로 답한다", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("등록부가 비면 UNKNOWN_COMMAND 가 아니라 REGISTRY_EMPTY 다", async () => {
    const reg = await import("./registry");
    // 오라클 생존 — 채워진 상태에서 REGISTRY_EMPTY 가 나오면 이 검사는 아무 말도 못 한다.
    expect(reg.catalogJson().length).toBe(0);

    const r = await reg.execute("ui.validate", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("REGISTRY_EMPTY");
    // 사람이 읽는 자리에도 사실이 있어야 한다 — 코드만 바꾸고 문장을 그대로 두면 화면은 여전히 거짓말한다.
    expect(r.message).toMatch(/등록/);
  });

  it("등록부가 차 있으면 없는 이름은 그대로 UNKNOWN_COMMAND 다", async () => {
    const exec = await import("./executor");
    exec.startExecutor();
    const reg = await import("./registry");
    expect(reg.catalogJson().length).toBeGreaterThan(0);

    const r = await reg.execute("no.such.command.at.all", {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
  });
});
