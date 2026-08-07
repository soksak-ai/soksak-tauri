// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callArgumentText,
  captureFedMachineJudgments,
  captureTaintedNames,
  recordingCompletenessThrows,
} from "./visual-judgment-provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

describe("캡처가 정한 판정을 이름으로 잡는다", () => {
  it("한 겹 벗겨 낸 캡처 값도 같은 출처로 번진다", () => {
    const source = [
      "const scaleEvidence = snapshotScaleForVisualEvidence(file, originalWindow);",
      "const scale = scaleEvidence.scale;",
      "const nearby = scale;",
    ].join("\n");
    expect([...captureTaintedNames(source)].sort()).toEqual(["scale", "scaleEvidence"]);
  });

  it("여러 줄에 걸친 인자도 괄호 단위로 통째로 본다", () => {
    const source = "verdict({\n  stats,\n  scaleFactor: fromPng,\n});";
    expect(callArgumentText(source, 0)).toContain("fromPng");
  });

  it("PNG에서 나온 배율이 기계 판정 입구에 들어가면 자리와 이름을 남긴다", () => {
    const source = [
      "const scaleEvidence = snapshotScaleForVisualEvidence(file, win);",
      "const scale = scaleEvidence.scale;",
      "await assertWindowedComposition(rpc, win, plugin, tabIds, labels, scale);",
    ].join("\n");
    expect(captureFedMachineJudgments(source)).toEqual([
      { sink: "assertWindowedComposition", argument: "scale", line: 3 },
    ]);
  });

  it("창의 사실을 넘기면 아무 이름도 남지 않는다", () => {
    const source = [
      "const scaleEvidence = snapshotScaleForVisualEvidence(file, originalWindow);",
      "await assertWindowedComposition(rpc, win, plugin, tabIds, labels, originalWindow);",
    ].join("\n");
    expect(captureFedMachineJudgments(source)).toEqual([]);
  });

  it("녹화 완결성으로 던지는 자리를 잡는다", () => {
    const source = [
      "if (result.recording?.status !== \"complete\"",
      "    || result.recording?.frames !== HOSTILE_RECORD_FRAMES) {",
      "  throw new Error(\"recording incomplete\");",
      "}",
    ].join("\n");
    expect(recordingCompletenessThrows(source).map((hit) => hit.line)).toEqual([1, 2]);
  });

  it("봉투 스키마를 거절하는 throw 는 완결성 게이트가 아니다", () => {
    const source = [
      "if (!recording || !RECORDING_STATUSES.has(recording.status)) {",
      "  throw new TypeError(`unknown recording status: ${String(recording?.status)}`);",
      "}",
      "const reported = optionalFrameCount(\"recording.frames\", recording.frames);",
    ].join("\n");
    expect(recordingCompletenessThrows(source)).toEqual([]);
  });

  it("창의 사실을 읽은 속성 접근을 캡처 이름으로 고발하지 않는다", () => {
    const source = [
      "const scaleEvidence = snapshotScaleForVisualEvidence(file, originalWindow);",
      "const scale = scaleEvidence.scale;",
      "gateReportStore.recordMachineEvidence({ scaleFactor: Number(originalWindow.scale) });",
    ].join("\n");
    expect(captureFedMachineJudgments(source)).toEqual([]);
  });

  it("녹화 완결성을 증거로만 실으면 아무것도 잡지 않는다", () => {
    const source = [
      "const hostileRecording = {",
      "  status: result.recording?.status ?? null,",
      "  frames: result.recording?.frames ?? null,",
      "};",
    ].join("\n");
    expect(recordingCompletenessThrows(source)).toEqual([]);
  });
});

describe("게이트는 실제 트리에서 종료코드로 판정한다", () => {
  it("현재 하니스에서 통과한다", () => {
    const run = spawnSync("node", ["scripts/gates/visual-judgment-provenance.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(`${run.stdout}${run.stderr}`.trimEnd()).toMatch(/visual-judgment: OK/);
    expect(run.status).toBe(0);
  });
});
