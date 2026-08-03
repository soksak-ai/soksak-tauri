// system.hello 계약 테스트 — 등록(발견성) + 실행이 ipc_hello_info 코어 커맨드로 위임(단일 소스). invoke 는 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  framework: { name: "test-adapter" },
  engineProvision: {
    chromium: true,
    nativeChildWebview: false,
    engineModules: false,
    supportsDocumentStart: false,
    supportsInputInjection: true,
  },
}));

import { registerSystemCatalog } from "./catalogSystem";
import { execute, getSpec, unregister } from "./registry";

beforeEach(() => {
  invoke.mockReset();
  registerSystemCatalog();
});
afterEach(() => {
  vi.useRealTimers();
  unregister("system.hello");
  unregister("app.quit");
  unregister("app.environment");
  unregister("framework.provision");
});

describe("app.quit — 성공 응답 뒤 자기 파괴", () => {
  it("호출자 응답이 끝난 다음 이벤트 차례에만 네이티브 종료를 요청", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce(undefined);

    const result = await execute("app.quit", {}, {});
    expect(result).toMatchObject({ ok: true });
    expect(invoke).not.toHaveBeenCalledWith("app_quit");

    await vi.runOnlyPendingTimersAsync();
    expect(invoke).toHaveBeenCalledWith("app_quit");
  });
});

describe("app.environment — core identity와 unit source mode를 분리해 노출", () => {
  it("세 CLI에서 공통 발견되는 status command이고 core 단일 소스로 위임", async () => {
    invoke.mockResolvedValueOnce({
      coreBuild: "release",
      identity: "com.soksak.app",
      cli: "sok",
      home: "/Users/test/.soksak",
      buildProfile: "release",
      updaterEnabled: true,
      unitMode: "mixed",
      developmentUnits: [{ kind: "plugin", id: "weather", source: "/work/weather" }],
    });

    const spec = getSpec("app.environment");
    expect(spec).toBeDefined();
    // 예제는 명령 형태만 담는다 — 바이너리 이름은 데이터가 아니라 표시자(CLI)의 정체성이다.
    expect(spec!.examples).toEqual(["app.environment"]);
    const r = await execute("app.environment", {}, {});
    expect(invoke).toHaveBeenCalledWith("app_environment");
    expect(r).toMatchObject({
      ok: true,
      data: { coreBuild: "release", cli: "sok", unitMode: "mixed" },
    });
  });
});

describe("system.hello 등록(발견성)", () => {
  it("params 없음 + returns/examples 선언, VERSION_SKEW 는 errors 아님", () => {
    const spec = getSpec("system.hello");
    expect(spec).toBeDefined();
    expect(Object.keys(spec!.params)).toHaveLength(0);
    expect(spec!.returns).toContain("protocol");
    expect(spec!.examples).toContain("hello");
    // 이 커맨드 자체는 스큐를 내지 않는다(스큐는 transport 게이트의 봉투) — errors 에 없어야 한다.
    expect(spec!.errors ?? []).not.toContain("VERSION_SKEW");
  });
});

describe("system.hello 실행(단일 소스 위임)", () => {
  it("ipc_hello_info 코어 커맨드를 호출해 그 payload 를 그대로 반환", async () => {
    invoke.mockResolvedValueOnce({
      protocol: 1,
      minClientProtocol: 0,
      appVersion: "9.9.9",
      identity: "com.soksak.test",
      pid: 4242,
      startedAt: 1_700_000_000_000,
      capabilities: ["hello.v1"],
    });
    const r = await execute("system.hello", {}, {});
    expect(invoke).toHaveBeenCalledWith("ipc_hello_info");
    expect(r).toMatchObject({
      ok: true,
      data: { protocol: 1, minClientProtocol: 0, capabilities: ["hello.v1"] },
    });
  });
});

describe("framework.provision 공개 capability", () => {
  it("제품 동작 차이를 adapter 이름이 아니라 명시적 축으로 노출한다", async () => {
    const r = await execute("framework.provision", {}, {});
    expect(r).toMatchObject({
      ok: true,
      data: {
        name: "test-adapter",
        supportsDocumentStart: false,
        supportsInputInjection: true,
      },
    });
  });
});
