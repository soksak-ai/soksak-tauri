// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  reviewVisualRecording,
  reviewVisualRecordingSafely,
} from "./visual-recording-review.mjs";

describe("human visual recording review", () => {
  it("완전한 녹화를 사람 검토 대기 증거로 보고하되 자동 제품 판정을 만들지 않는다", () => {
    expect(reviewVisualRecording({
      recording: {
        status: "complete",
        dir: "/evidence/flow",
        requestedFrames: 2,
        frames: 2,
        mode: "realtime",
      },
      expectedFrames: 2,
      artifacts: ["/evidence/flow/f0000.png", "/evidence/flow/f0001.png"],
    })).toEqual({
      kind: "human-visual-evidence",
      automatedVerdict: false,
      status: "pending",
      recordingStatus: "complete",
      mode: "realtime",
      expectedFrames: 2,
      requestedFrames: 2,
      reportedFrames: 2,
      artifactFrames: 2,
      artifacts: ["/evidence/flow/f0000.png", "/evidence/flow/f0001.png"],
      failures: [],
    });
  });

  it("녹화 실패와 파일 누락을 throw하지 않고 시각 검토 실패 사유로만 공개한다", () => {
    const review = reviewVisualRecording({
      recording: {
        status: "failed",
        dir: "/evidence/resize",
        requestedFrames: 64,
        frames: 3,
        mode: "realtime",
        reason: "byte budget exceeded",
      },
      expectedFrames: 64,
      artifacts: ["/evidence/resize/f0000.png"],
      artifactReadError: "directory unavailable",
    });

    expect(review).toMatchObject({
      kind: "human-visual-evidence",
      automatedVerdict: false,
      status: "failed",
      recordingStatus: "failed",
      expectedFrames: 64,
      requestedFrames: 64,
      reportedFrames: 3,
      artifactFrames: 1,
    });
    expect(review.failures).toEqual([
      "recording:byte budget exceeded",
      "artifacts:directory unavailable",
      "reported-frames:3/64",
      "artifact-frames:1/64",
    ]);
  });

  it("녹화를 요청하지 않은 시나리오도 명시적 상태로 남긴다", () => {
    expect(reviewVisualRecording({ recording: { status: "not-requested", mode: "realtime" } }))
      .toMatchObject({
        automatedVerdict: false,
        status: "not-requested",
        recordingStatus: "not-requested",
        artifacts: [],
        failures: [],
      });
  });

  it.each([
    ["unknown recording status", { recording: { status: "green" } }],
    ["invalid expected frame count", { recording: { status: "complete" }, expectedFrames: 0 }],
    ["non-PNG artifact", { recording: { status: "complete" }, artifacts: ["trace.json"] }],
  ])("계약 자체가 잘못된 입력은 숨기지 않는다: %s", (_name, input) => {
    expect(() => reviewVisualRecording(input)).toThrow();
  });

  it("E2E 통합 경계는 잘못된 녹화 영수증도 제품 예외로 던지지 않고 명시적 visual failure로 바꾼다", () => {
    expect(reviewVisualRecordingSafely({
      recording: undefined,
      expectedFrames: 48,
      artifacts: [],
    })).toMatchObject({
      kind: "human-visual-evidence",
      automatedVerdict: false,
      status: "failed",
      recordingStatus: "invalid",
      expectedFrames: 48,
      artifacts: [],
    });
    expect(reviewVisualRecordingSafely({
      recording: undefined,
      expectedFrames: 48,
      artifacts: [],
    }).failures[0]).toMatch(/^contract:/);
  });
});
