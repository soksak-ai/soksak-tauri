// @vitest-environment jsdom
// 레이아웃 모션 신호(단일 진실) — 디바이더 드래그·레일 주행·FLIP 이 같은 사실("표면이
// 움직이는 중")을 겹칠 수 있으므로 레퍼카운트로 시작/끝 짝을 보장한다. 소비자(브라우저
// freeze-frame·CEF 릴레이)는 에지에서만 통지받는다. 실측 근거: 주행 중 DOM 은 미끄러지는데
// 네이티브 child 는 끝에서 점프(영상 f062 — 파일트리가 Google 위로 슬라이드).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLayoutMotion,
  endLayoutMotion,
  onLayoutMotion,
  __resetLayoutMotionForTest,
} from "./layoutMotion";

const emits: boolean[] = [];
const payloads: { active: boolean; kinds: string[] }[] = [];
vi.mock("../plugins/hooks", () => ({
  emitPluginEvent: (_e: string, p: { active: boolean; kinds: string[] }) => {
    emits.push(p.active);
    payloads.push(p);
  },
}));
vi.mock("../platform", () => ({ invoke: async () => {} }));

afterEach(() => {
  emits.length = 0;
  payloads.length = 0;
  __resetLayoutMotionForTest();
});

describe("layoutMotion — 레퍼카운트 에지 통지", () => {
  it("첫 begin 에만 true, 마지막 end 에만 false", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("move"); // 겹침(주행 두 겹)
    endLayoutMotion("move");
    endLayoutMotion("move");
    expect(emits).toEqual([true, false]);
  });

  it("잉여 end 는 무시한다(음수 카운트 금지)", () => {
    endLayoutMotion("move");
    beginLayoutMotion("move");
    endLayoutMotion("move");
    expect(emits).toEqual([true, false]);
  });

  it("로컬 리스너도 같은 에지를 받고, 해지 후엔 받지 않는다", () => {
    const seen: boolean[] = [];
    const off = onLayoutMotion((a) => seen.push(a));
    beginLayoutMotion("move");
    beginLayoutMotion("move");
    endLayoutMotion("move");
    endLayoutMotion("move");
    expect(seen).toEqual([true, false]);
    off();
    beginLayoutMotion("move");
    expect(seen).toEqual([true, false]);
  });
});

describe("layoutMotion — kind 축(move|resize)", () => {
  it("페이로드 kinds 가 활성 종별을 싣는다", () => {
    beginLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("활성 중 종별 구성이 바뀌면 active:true 를 재발화한다(freeze 재평가 근거)", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("resize"); // 주행 중 디바이더 개입
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move", "resize"] });
    endLayoutMotion("resize");
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("같은 종별 겹침은 재발화하지 않는다(중복 억제)", () => {
    beginLayoutMotion("move");
    beginLayoutMotion("move");
    expect(payloads.length).toBe(1);
  });

  it("종별별 잉여 end 는 무시한다", () => {
    beginLayoutMotion("move");
    endLayoutMotion("resize"); // resize 는 시작된 적 없다
    expect(payloads[payloads.length - 1]).toEqual({ active: true, kinds: ["move"] });
  });
});

describe("layoutMotion — 로컬 리스너 kinds 전달", () => {
  it("리스너는 (active, kinds)를 받고, 활성 중 종별 변화도 통지받는다", () => {
    const seen: [boolean, string[]][] = [];
    onLayoutMotion((a, k) => seen.push([a, k]));
    beginLayoutMotion("move");
    beginLayoutMotion("resize");
    endLayoutMotion("resize");
    endLayoutMotion("move");
    expect(seen).toEqual([
      [true, ["move"]],
      [true, ["move", "resize"]],
      [true, ["move"]],
      [false, []],
    ]);
  });
});

describe("layoutMotion — 채널은 사실만, 범위는 로컬 소비자에게", () => {
  it("플러그인 채널은 범위를 싣지 않는다 — 대상 통지는 view.veiled 가 정확히 한다", () => {
    beginLayoutMotion("move", ["vA"]);
    expect(payloads[payloads.length - 1]).toEqual({
      active: true,
      kinds: ["move"],
    });
    endLayoutMotion("move");
    expect(payloads[payloads.length - 1]).toEqual({ active: false, kinds: [] });
  });

  it("범위가 바뀌면 로컬 소비자에게 재통지한다 — 중복 억제 키가 범위를 안다", () => {
    // 키가 범위를 모르면 두 번째 스코프 위상의 시작이 삼켜지고, 실제로 움직이는 표면이
    // 자기 위상을 통보받지 못한다(실사고). active·kinds 가 같아도 범위는 다른 사실이다.
    const seen: (string[] | null)[] = [];
    const off = onLayoutMotion((_active, _kinds, scope) =>
      seen.push(scope ? [...scope].sort() : null),
    );
    beginLayoutMotion("move", ["vA"]);
    beginLayoutMotion("move", ["vB"]);
    endLayoutMotion("move");
    endLayoutMotion("move");
    off();
    // 종료 통지의 범위는 뜻이 없다(활성 위상 0) — 소비자는 active:false 에 전부 해동한다.
    expect(seen).toEqual([["vA"], ["vA", "vB"], ["vA"], []]);
  });
});
