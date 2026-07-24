// @vitest-environment jsdom
// 네이티브 미러 단일 기계 — 드래그바가 증명한 추종 방식의 계약: 동일-rect 스킵(IPC 0),
// 변화 시에만 적용, 위상 중 rAF 추종 + 안정 후 자기 종료, 종료 에지 정확 스냅.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerMirror,
  setMirrorPhase,
  snapRect,
  tickMirrors,
  __resetMirrorsForTest,
} from "./nativeMirror";

afterEach(() => {
  __resetMirrorsForTest();
  vi.restoreAllMocks();
});

describe("nativeMirror", () => {
  it("등록 즉시 1틱, 같은 rect 재틱은 적용하지 않는다(IPC 0)", () => {
    const applied: string[] = [];
    registerMirror(
      "a",
      () => ({ x: 10, y: 20, w: 100, h: 50 }),
      (r) => applied.push(`${r.x},${r.y},${r.w},${r.h}`),
    );
    expect(applied).toEqual(["10,20,100,50"]);
    tickMirrors();
    tickMirrors();
    expect(applied).toHaveLength(1);
  });

  it("rect 가 바뀌면 적용, measure null(숨김) 은 건드리지 않는다", () => {
    let rect: { x: number; y: number; w: number; h: number } | null = {
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    };
    const applied: number[] = [];
    registerMirror("b", () => rect, (r) => applied.push(r.x));
    rect = { x: 5, y: 0, w: 10, h: 10 };
    tickMirrors();
    rect = null;
    tickMirrors();
    expect(applied).toEqual([0, 5]);
  });

  it("해지 후에는 틱 대상이 아니다", () => {
    const applied: number[] = [];
    const off = registerMirror("c", () => ({ x: 1, y: 1, w: 1, h: 1 }), (r) => applied.push(r.x));
    off();
    tickMirrors();
    expect(applied).toHaveLength(1); // 등록 즉시 1틱뿐
  });

  it("위상 종료 에지는 동기 스냅 1틱(드래그바 gesture-end 와 동형)", () => {
    let x = 0;
    const applied: number[] = [];
    registerMirror("d", () => ({ x, y: 0, w: 10, h: 10 }), (r) => applied.push(r.x));
    x = 42;
    setMirrorPhase(false); // 종료 에지 — rAF 없이 즉시 정확 스냅
    expect(applied).toEqual([0, 42]);
  });

  it("정수 스냅 — ceil 원점 / floor 끝, 최소 1px", () => {
    expect(snapRect({ left: 10.2, top: 5.7, right: 110.9, bottom: 55.1 })).toEqual({
      x: 11,
      y: 6,
      w: 99,
      h: 49,
    });
    expect(snapRect({ left: 0, top: 0, right: 0.4, bottom: 0.4 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});
