// framework.info 계약 테스트 — 활성 프레임워크의 이름과 계약 능력의 존재 여부를 밖에서 읽는다.
// 프레임워크는 mock 한다: 이 명령의 답이 상수가 아니라 **그때의 활성 어댑터**를 읽는다는 것이 요점이므로,
// 어댑터 이름을 바꿔가며 답이 따라오는지 본다. 능력은 부르지 않는다 — 미구현은 부를 때 던진다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 계약 모양 그대로의 가짜 어댑터. 값은 호출되지 않는다(존재 여부만 읽힌다).
// vi.hoisted — mock 팩토리는 파일 맨 위로 끌어올려지므로 이 객체도 같이 올라가야 한다.
const { framework } = vi.hoisted(() => ({
  framework: {
    name: "tauri",
    invoke: async () => undefined,
    createStream: () => ({ onmessage: () => {} }),
    listen: async () => () => {},
    currentWindow: () => {
      throw new Error("테스트 어댑터에는 창이 없다");
    },
    windowByLabel: async () => null,
    app: { name: async () => "", version: async () => "" },
    path: { tempDir: async () => "", join: async () => "" },
    dialog: { openDirectory: async () => null },
    notification: {
      isPermissionGranted: async () => false,
      requestPermission: async () => "denied",
      send: () => {},
      onAction: async () => () => {},
    },
    deepLink: { onOpenUrl: async () => () => {}, current: async () => null },
  },
}));

vi.mock("../framework", () => ({
  framework,
  invoke: async () => undefined,
  currentWindow: () => framework.currentWindow(),
}));

import { registerFrameworkCatalog } from "./catalogFramework";
import { execute, getSpec, unregister } from "./registry";
import { useSettings } from "../state/settings";

beforeEach(() => {
  framework.name = "tauri";
  registerFrameworkCatalog();
});
afterEach(() => {
  unregister("framework.info");
});

describe("framework.info 등록(발견성)", () => {
  it("params 없음 + returns/examples 선언", () => {
    const spec = getSpec("framework.info");
    expect(spec).toBeDefined();
    expect(Object.keys(spec!.params)).toHaveLength(0);
    expect(spec!.returns).toContain("framework");
    expect(spec!.returns).toContain("capabilities");
    expect(spec!.examples).toContain("framework.info");
  });
});

describe("framework.info 실행(활성 어댑터 보고)", () => {
  it("활성 프레임워크 이름을 돌려준다", async () => {
    const r = await execute("framework.info", {}, {});
    expect(r).toMatchObject({ ok: true, data: { framework: "tauri" } });
  });

  it("프레임워크가 바뀌면 답도 바뀐다 — 상수가 아니라 활성 어댑터를 읽는다", async () => {
    framework.name = "electron";
    const r = await execute("framework.info", {}, {});
    expect(r).toMatchObject({ ok: true, data: { framework: "electron" } });
  });

  it("계약 능력을 이름으로 싣는다 — 중첩 묶음은 점 경로로 편다", async () => {
    const r = await execute("framework.info", {}, {});
    const caps = (r.data as { capabilities: string[] }).capabilities;
    expect(caps).toContain("invoke");
    expect(caps).toContain("currentWindow");
    expect(caps).toContain("app.version");
    expect(caps).toContain("notification.send");
    expect(caps).toContain("deepLink.onOpenUrl");
    // 이름은 능력이 아니라 정체성이다 — framework 필드가 그것을 말한다.
    expect(caps).not.toContain("name");
    // 결정적 순서 — 밖에서 대조하는 원장이 순서 흔들림에 흔들리지 않는다.
    expect(caps).toEqual([...caps].sort());
  });

  // 핸들러가 넘기는 이름과 문장의 자리표시자가 갈리면 치환이 일어나지 않고 리터럴이 그대로
  // 사용자에게 나간다 — ok:true 라 아무도 못 본다. 두 언어 모두 실제 문장으로 확인한다.
  it.each(["ko", "en"] as const)("%s 문장이 프레임워크 이름을 채운다 — 자리표시자가 새지 않는다", async (language) => {
    const before = useSettings.getState().language;
    useSettings.setState({ language });
    try {
      const r = await execute("framework.info", {}, {});
      expect(r.ok).toBe(true);
      expect(r.message).toContain("tauri");
      expect(r.message).not.toMatch(/\{[a-zA-Z]+\}/);
    } finally {
      useSettings.setState({ language: before });
    }
  });

  it("능력을 부르지 않는다 — 미구현 어댑터에서도 답이 나온다", async () => {
    const boom = vi.fn(() => {
      throw new Error("미구현");
    });
    const before = framework.windowByLabel;
    (framework as unknown as { windowByLabel: unknown }).windowByLabel = boom;
    try {
      const r = await execute("framework.info", {}, {});
      expect(r.ok).toBe(true);
      expect(boom).not.toHaveBeenCalled();
    } finally {
      (framework as unknown as { windowByLabel: unknown }).windowByLabel = before;
    }
  });
});
