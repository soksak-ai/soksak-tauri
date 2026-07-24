// 파라메트릭 위상 구동의 계약 — DOM(rail-flip-x)과 같은 곡선·같은 시간이어야 두 컴포지터가
// 같은 궤도를 달린다. 곡선이 갈라지면 "따라오다 어긋나는" 새 이질감이 생긴다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PHASE_EASING,
  phaseOffsetPx,
  translateXOf,
  viewIdFromSlotNode,
} from "./holePhaseAnimate";
import { RAIL_TRAVEL_MS } from "./railMotion";

describe("holePhaseAnimate — DOM 곡선 동조 계약", () => {
  it("easing 은 App.css rail-flip-x 의 cubic-bezier 와 문자 그대로 일치한다", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "..", "App.css"), "utf8");
    const expected = `cubic-bezier(${PHASE_EASING.join(", ")})`;
    expect(css).toContain(`animation: rail-flip-x var(--rail-travel-ms) ${expected}`);
  });

  it("duration 은 레일 주행 시간(RAIL_TRAVEL_MS)을 그대로 쓴다", () => {
    expect(RAIL_TRAVEL_MS).toBeGreaterThan(0);
  });

  it("슬롯 주소에서 viewId 를 추출한다(형식 밖 null)", () => {
    expect(viewIdFromSlotNode("layout/slot/v6")).toBe("v6");
    expect(viewIdFromSlotNode("layout/slot/v12")).toBe("v12");
    expect(viewIdFromSlotNode("layout/panel/g5")).toBeNull();
    expect(viewIdFromSlotNode(undefined)).toBeNull();
  });

  it("살아있는 translate 문자열에서 x(px)를 읽는다 — 재구동의 남은 이동량 원천", () => {
    expect(translateXOf("none")).toBe(0);
    expect(translateXOf("")).toBe(0);
    expect(translateXOf("-224px 0px")).toBe(-224);
    expect(translateXOf("136.5px")).toBe(136.5);
  });

  it("위상 오프셋 = rail-flip(px) + focus-flip(%)×슬롯폭 — 두 위상 합성", () => {
    expect(phaseOffsetPx(224, 0, 720)).toBe(224);
    expect(phaseOffsetPx(0, 50, 720)).toBe(360);
    expect(phaseOffsetPx(-224, -50, 720)).toBe(-584);
    expect(phaseOffsetPx(0, 0, 720)).toBe(0);
  });
});
