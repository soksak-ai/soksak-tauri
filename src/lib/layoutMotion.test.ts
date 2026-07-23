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
vi.mock("../plugins/hooks", () => ({
  emitPluginEvent: (_e: string, p: { active: boolean }) => emits.push(p.active),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => {} }));

afterEach(() => {
  emits.length = 0;
  __resetLayoutMotionForTest();
});

describe("layoutMotion — 레퍼카운트 에지 통지", () => {
  it("첫 begin 에만 true, 마지막 end 에만 false", () => {
    beginLayoutMotion();
    beginLayoutMotion(); // 겹침(드래그+주행)
    endLayoutMotion();
    endLayoutMotion();
    expect(emits).toEqual([true, false]);
  });

  it("잉여 end 는 무시한다(음수 카운트 금지)", () => {
    endLayoutMotion();
    beginLayoutMotion();
    endLayoutMotion();
    expect(emits).toEqual([true, false]);
  });

  it("로컬 리스너도 같은 에지를 받고, 해지 후엔 받지 않는다", () => {
    const seen: boolean[] = [];
    const off = onLayoutMotion((a) => seen.push(a));
    beginLayoutMotion();
    beginLayoutMotion();
    endLayoutMotion();
    endLayoutMotion();
    expect(seen).toEqual([true, false]);
    off();
    beginLayoutMotion();
    expect(seen).toEqual([true, false]);
  });
});
