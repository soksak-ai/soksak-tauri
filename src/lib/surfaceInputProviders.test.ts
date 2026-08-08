// **표면의 주인이 그 표면의 입력을 배달한다.**
//
// 코어가 쥔 표면(프레임워크 자식 웹뷰)에만 포인터가 들어갔다. 플러그인이 엔진 사이드카로 그리는
// 표면은 코어의 통로가 닿지 않아 "webview 없음" 으로 거절됐다 — 실측 2026-08-08: 브라우저 세 종
// 중 하나만 게스처가 됐고 둘은 이름만 다른 거절을 받았다.
//
// 코어가 그 엔진을 알아서는 안 된다. 아는 쪽은 그 표면을 만든 플러그인이고, 코어가 할 일은
// **누가 주인인지 묻는 자리**를 두는 것뿐이다. 주인이 있으면 그리로, 없으면 프레임워크로.
//
// 주인은 라벨 문법으로 추측하지 않는다 — 접두사로 가르면 그 문법이 바뀌는 날 남의 표면으로
// 배달된다. 주인이 스스로 "이 라벨은 내 것" 이라고 답한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSurfaceInputProvidersForTest,
  registerSurfaceInputProvider,
  surfaceInputProvider,
} from "./surfaceInputProviders";

beforeEach(() => __resetSurfaceInputProvidersForTest());

const provider = (owns: (label: string) => boolean) => ({
  owns,
  sendInput: vi.fn(async () => {}),
  inputState: vi.fn(async () => ({ attached: true })),
});

describe("표면 입력 주인", () => {
  it("주인이 없으면 없다고 답한다 — 프레임워크가 그 자리를 맡는다", () => {
    expect(surfaceInputProvider("b-main-t1")).toBeNull();
  });

  it("자기 것이라고 답한 주인에게 간다", () => {
    const p = provider((label) => label.startsWith("chromium-"));
    registerSurfaceInputProvider("soksak-plugin-browser-chromium", p);
    expect(surfaceInputProvider("chromium-tab-1")).toBe(p);
    expect(surfaceInputProvider("b-main-t1")).toBeNull();
  });

  // 두 주인이 같은 표면을 자기 것이라 하면 배달이 어디로 갈지 값으로 모른다.
  it("두 주인이 같은 표면을 주장하면 이름을 달고 던진다", () => {
    registerSurfaceInputProvider("plugin-a", provider(() => true));
    registerSurfaceInputProvider("plugin-b", provider(() => true));
    expect(() => surfaceInputProvider("x")).toThrow(/plugin-a.*plugin-b|plugin-b.*plugin-a/);
  });

  // 같은 플러그인이 다시 걸면 갈아끼운다 — 두 벌이 되면 위 규칙이 자기 자신과 충돌한다.
  it("같은 주인의 재등록은 갈아끼운다", () => {
    registerSurfaceInputProvider("plugin-a", provider(() => true));
    const second = provider(() => true);
    registerSurfaceInputProvider("plugin-a", second);
    expect(surfaceInputProvider("x")).toBe(second);
  });

  // 뷰가 사라지면 그 주인도 사라진다 — 남기면 죽은 사이드카로 계속 보낸다.
  it("해지하면 다시 주인이 없다", () => {
    const dispose = registerSurfaceInputProvider("plugin-a", provider(() => true));
    dispose();
    expect(surfaceInputProvider("x")).toBeNull();
  });

  // 주인이 판단 중에 죽으면 그 사실을 삼키지 않는다 — 삼키면 배달이 조용히 프레임워크로 샌다.
  it("주인의 판단이 던지면 그 사실이 이름과 함께 나온다", () => {
    registerSurfaceInputProvider("plugin-a", {
      owns: () => { throw new Error("깨진 판단"); },
      sendInput: vi.fn(),
      inputState: vi.fn(),
    });
    expect(() => surfaceInputProvider("x")).toThrow(/plugin-a/);
  });
});
