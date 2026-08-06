import { describe, expect, it } from "vitest";
import { EVIDENCE_RUN_LIMIT_BYTES } from "./evidence-store.mjs";
import {
  RECORDING_BYTES_PER_FRAME,
  planBrowserRecordingEvidence,
} from "./browser-evidence-plan.mjs";

const ENGINES = ["browser", "browser-chromium", "browser-chromium-offscreen"];
const ALL_SCENARIOS = ["flow", "pin", "resize", "overlay", "scroll"];

describe("browser recording evidence plan", () => {
  it("기본 3엔진 시나리오를 실행 전에 1560 frames/780MiB로 전부 예약한다", () => {
    const plan = planBrowserRecordingEvidence({
      engines: ENGINES,
      scenarios: ALL_SCENARIOS,
      cycles: 3,
    });

    expect(RECORDING_BYTES_PER_FRAME).toBe(512 * 1024);
    expect(plan.recordings).toHaveLength(36);
    expect(plan.totalFrames).toBe(1560);
    expect(plan.totalMaxBytes).toBe(780 * 1024 ** 2);
    expect(plan.runLimitBytes).toBe(EVIDENCE_RUN_LIMIT_BYTES);
    expect(new Set(plan.recordings.map(({ relativePath }) => relativePath)).size)
      .toBe(plan.recordings.length);
    expect(plan.recordings.every(({ relativePath }) =>
      !relativePath.startsWith("/") && relativePath.endsWith("/frames"))).toBe(true);
  });

  it("선택하지 않은 시나리오의 녹화를 계획하지 않는다", () => {
    const plan = planBrowserRecordingEvidence({
      engines: ["browser"],
      scenarios: ["flow"],
      cycles: 1,
    });
    expect(plan.recordings.map(({ scenario, frames }) => [scenario, frames])).toEqual([
      ["flow", 48],
      ["flow", 48],
    ]);
    expect(plan.totalMaxBytes).toBe(48 * 2 * RECORDING_BYTES_PER_FRAME);
  });

  it("1GiB를 넘는 선택은 일부 녹화를 누락하지 않고 실행 전에 거부한다", () => {
    expect(() => planBrowserRecordingEvidence({
      engines: ENGINES,
      scenarios: ALL_SCENARIOS,
      cycles: 20,
    })).toThrow(/1GiB.*초과/);
  });

  it("엔진·시나리오·cycle의 잘못된 선언을 경로로 흘리지 않는다", () => {
    expect(() => planBrowserRecordingEvidence({
      engines: ["unknown"], scenarios: ["flow"], cycles: 1,
    })).toThrow(/engine/);
    expect(() => planBrowserRecordingEvidence({
      engines: ["browser"], scenarios: ["unknown"], cycles: 1,
    })).toThrow(/scenario/);
    expect(() => planBrowserRecordingEvidence({
      engines: ["browser"], scenarios: ["flow"], cycles: -1,
    })).toThrow(/cycles/);
  });
});
