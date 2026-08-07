import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginEvidenceRun,
  finishEvidenceRun,
  inspectEvidenceStore,
  resolveEvidenceFile,
} from "./evidence-store.mjs";
import {
  recordingReportFromCommandResponse,
  runRecordingEvidenceAction,
  startRecordingEvidenceAction,
} from "./recording-evidence-action.mjs";
import { reviewVisualRecordingSafely } from "./visual-recording-review.mjs";

const TEMP_PREFIX = "soksak-recording-evidence-action-test-";

async function inRunningStore(run) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const root = path.join(sandbox, "evidence");
  try {
    await beginEvidenceRun(root, { runId: "recording-action" });
    return await run(root);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe("recording evidence product action transaction", () => {
  it("exposes product ACK before visual completion and keeps artifact open until explicit release", async () => {
    await inRunningStore(async (root) => {
      let finishCalls = 0;
      const transaction = startRecordingEvidenceAction({
        root,
        relativePath: "browser/concurrent-flow",
        maxBytes: 64,
        action: async ({ recordDir }) => {
          await writeFile(path.join(recordDir, "f0000.png"), "frame");
          return {
            actionResult: { ok: true, data: { clicked: true } },
            finish: async () => {
              finishCalls += 1;
              return { ok: true, data: { clicked: true, recording: { status: "complete" } } };
            },
          };
        },
      });
      await expect(transaction.actionResult).resolves.toMatchObject({ data: { clicked: true } });
      expect(finishCalls).toBe(0);
      transaction.release();
      await expect(transaction.outcome).resolves.toMatchObject({
        actionResult: { data: { recording: { status: "complete" } } },
      });
      expect(finishCalls).toBe(1);
    });
  });

  it("reads the recording receipt from the public command response envelope", async () => {
    await inRunningStore(async (root) => {
      const outcome = await runRecordingEvidenceAction({
        root,
        relativePath: "browser/enveloped-command",
        maxBytes: 64,
        action: async ({ recordDir }) => {
          await writeFile(path.join(recordDir, "f0000.png"), "frame");
          return {
            ok: true,
            data: {
              clicked: true,
              recording: {
                status: "complete",
                mode: "realtime",
                requestedFrames: 1,
                frames: 1,
              },
            },
          };
        },
      });

      const report = reviewVisualRecordingSafely({
        recording: recordingReportFromCommandResponse(outcome.actionResult),
        expectedFrames: 1,
        artifacts: ["f0000.png"],
      });

      expect(report).toMatchObject({
        status: "pending",
        recordingStatus: "complete",
        reportedFrames: 1,
        artifactFrames: 1,
        failures: [],
      });
    });
  });

  it("keeps a missing command recording receipt visibly failed", () => {
    const report = reviewVisualRecordingSafely({
      recording: recordingReportFromCommandResponse({ ok: true, data: { clicked: true } }),
      expectedFrames: 1,
      artifacts: ["f0000.png"],
    });

    expect(report).toMatchObject({
      status: "failed",
      recordingStatus: "invalid",
      artifactFrames: 1,
    });
    expect(report.failures).toEqual(["contract:unknown recording status: undefined"]);
  });

  it("stores one recording action and exposes only a relative rotation-safe identity", async () => {
    await inRunningStore(async (root) => {
      const calls = [];
      const actionResult = { ok: true, sequence: 7 };
      const outcome = await runRecordingEvidenceAction({
        root,
        relativePath: "browser/flow-01",
        maxBytes: 64,
        action: async (recordFields) => {
          calls.push(recordFields);
          expect(Object.keys(recordFields).sort()).toEqual(["recordDir", "recordMaxBytes"]);
          expect(recordFields.recordMaxBytes).toBe(64);
          expect(path.isAbsolute(recordFields.recordDir)).toBe(true);
          await writeFile(path.join(recordFields.recordDir, "f0000.png"), "frame");
          return actionResult;
        },
      });

      expect(calls).toHaveLength(1);
      expect(outcome.actionResult).toBe(actionResult);
      expect(outcome.visualEvidence).toEqual({
        kind: "human-visual-evidence",
        automatedVerdict: false,
        status: "pending",
        phase: "stored",
        artifact: {
          relativePath: "browser/flow-01",
          kind: "directory",
          maxBytes: 64,
          bytes: 5,
        },
        failures: [],
      });
      expect(path.isAbsolute(outcome.visualEvidence.artifact.relativePath)).toBe(false);
      expect(JSON.stringify(outcome.visualEvidence)).not.toContain(root);

      await finishEvidenceRun(root, { runId: "recording-action", status: "red" });
      const rotated = resolveEvidenceFile(
        root,
        "last-red",
        outcome.visualEvidence.artifact.relativePath,
      );
      await expect(access(path.join(rotated, "f0000.png"))).resolves.toBeUndefined();
    });
  });

  it("runs the product action once without record fields when artifact preflight fails", async () => {
    await inRunningStore(async (root) => {
      const initial = await inspectEvidenceStore(root);
      const calls = [];
      const actionResult = { ok: true, input: "committed" };
      const outcome = await runRecordingEvidenceAction({
        root,
        relativePath: "browser/preflight",
        maxBytes: 4,
        limits: {
          runLimitBytes: initial.current.bytes + 1,
          storeLimitBytes: initial.totalBytes + 2,
        },
        action: async (recordFields) => {
          calls.push(recordFields);
          return actionResult;
        },
      });

      expect(calls).toEqual([{}]);
      expect(outcome.actionResult).toBe(actionResult);
      expect(outcome.visualEvidence).toMatchObject({
        kind: "human-visual-evidence",
        automatedVerdict: false,
        status: "failed",
        phase: "preflight",
        artifact: null,
      });
      expect(outcome.visualEvidence.failures).toHaveLength(1);
      expect(outcome.visualEvidence.failures[0]).toMatch(/^artifact:/);
    });
  });

  it("never reruns an action after post-measure failure and retains its result", async () => {
    await inRunningStore(async (root) => {
      const calls = [];
      const actionResult = { ok: true, steps: 12 };
      const outcome = await runRecordingEvidenceAction({
        root,
        relativePath: "browser/oversized",
        maxBytes: 4,
        action: async (recordFields) => {
          calls.push(recordFields);
          await writeFile(path.join(recordFields.recordDir, "f0000.png"), "12345");
          return actionResult;
        },
      });

      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]).sort()).toEqual(["recordDir", "recordMaxBytes"]);
      expect(outcome.actionResult).toBe(actionResult);
      expect(outcome.visualEvidence).toMatchObject({
        status: "failed",
        phase: "store",
        artifact: null,
      });
      await expect(access(resolveEvidenceFile(root, "current", "browser/oversized")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("propagates the exact product action error even when artifact cleanup reports another error", async () => {
    await inRunningStore(async (root) => {
      const productError = new Error("pointer transaction failed");
      let calls = 0;
      let caught;
      try {
        await runRecordingEvidenceAction({
          root,
          relativePath: "browser/product-red",
          maxBytes: 4,
          action: async ({ recordDir }) => {
            calls += 1;
            await writeFile(path.join(recordDir, "f0000.png"), "12345");
            throw productError;
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(calls).toBe(1);
      expect(caught).toBe(productError);
    });
  });

  it("propagates an unrecorded product action error after preflight rejection", async () => {
    await inRunningStore(async (root) => {
      const productError = new Error("unrecorded action failed");
      const calls = [];
      let caught;
      try {
        await runRecordingEvidenceAction({
          root,
          relativePath: "../outside",
          maxBytes: 4,
          action: async (recordFields) => {
            calls.push(recordFields);
            throw productError;
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(calls).toEqual([{}]);
      expect(caught).toBe(productError);
    });
  });
});
