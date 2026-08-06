// @vitest-environment node

import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_RUN_LIMIT_BYTES,
  EVIDENCE_STORE_LIMIT_BYTES,
  EvidenceQuotaError,
  beginEvidenceRun,
  ensureEvidenceStore,
  evidenceStorePaths,
  finishEvidenceRun,
  inspectEvidenceStore,
  planFailedRunRotation,
  projectEvidenceQuota,
  readEvidenceRun,
  resolveEvidenceFile,
  writeEvidenceFile,
} from "./evidence-store.mjs";

const TEMP_PREFIX = "soksak-evidence-store-test-";

async function inTemporaryStore(run) {
  const base = path.resolve(os.tmpdir());
  const sandbox = await mkdtemp(path.join(base, TEMP_PREFIX));
  const stat = await lstat(sandbox);
  if (!stat.isDirectory()
      || path.dirname(sandbox) !== base
      || !path.basename(sandbox).startsWith(TEMP_PREFIX)) {
    throw new Error(`테스트 임시 디렉터리 경계 검증 실패: ${sandbox}`);
  }
  try {
    return await run(path.join(sandbox, "evidence"));
  } finally {
    // 파괴 동작은 mkdtemp가 방금 만든 이 정확한 경계 안에서만 수행한다.
    if (path.dirname(sandbox) !== base || !path.basename(sandbox).startsWith(TEMP_PREFIX)) {
      throw new Error(`테스트 정리 경계 이탈: ${sandbox}`);
    }
    await rm(sandbox, { recursive: true });
  }
}

describe("증거 저장 경계", () => {
  it("current와 last-red 두 실제 디렉터리만 계획하며 timestamp archive를 만들지 않는다", async () => {
    await inTemporaryStore(async (root) => {
      const paths = evidenceStorePaths(root);
      expect(paths).toEqual({
        root: path.resolve(root),
        current: path.join(path.resolve(root), "current"),
        lastRed: path.join(path.resolve(root), "last-red"),
      });
      expect(planFailedRunRotation(root)).toEqual({
        root: path.resolve(root),
        remove: paths.lastRed,
        rename: { from: paths.current, to: paths.lastRed },
        recreate: paths.current,
      });

      await ensureEvidenceStore(root);
      expect((await readdir(root)).sort()).toEqual(["current", "last-red"]);
      expect((await readdir(paths.current)).sort()).toEqual(["run.json"]);
      expect((await readdir(paths.lastRed)).sort()).toEqual(["run.json"]);
    });
  });

  it("절대경로·상위경로·run.json 덮어쓰기를 파일 경계 밖으로 허용하지 않는다", async () => {
    await inTemporaryStore(async (root) => {
      expect(() => resolveEvidenceFile(root, "current", "../escape.png")).toThrow(/경계/);
      expect(() => resolveEvidenceFile(root, "current", path.join(root, "absolute.png"))).toThrow(/상대/);
      expect(() => resolveEvidenceFile(root, "elsewhere", "frame.png")).toThrow(/bucket/);
      expect(() => resolveEvidenceFile(root, "current", "run.json")).toThrow(/예약/);
    });
  });
});

describe("run.json 수명과 실패 회전", () => {
  it("실행 최종 상태를 machine-green/red로만 기록해 사람의 visualReview와 섞지 않는다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "verdict-vocabulary" });
      await expect(finishEvidenceRun(root, {
        runId: "verdict-vocabulary",
        status: "passed",
      })).rejects.toThrow(/machine-green 또는 red/);
      await expect(finishEvidenceRun(root, {
        runId: "verdict-vocabulary",
        status: "failed",
      })).rejects.toThrow(/machine-green 또는 red/);
      expect(await readEvidenceRun(root, "current")).toMatchObject({
        runId: "verdict-vocabulary",
        status: "running",
      });
    });
  });

  it("시작은 멱등이고 실패는 한 번만 last-red로 회전한다", async () => {
    await inTemporaryStore(async (root) => {
      const first = await beginEvidenceRun(root, { runId: "browser-flow-1", keep: true });
      const again = await beginEvidenceRun(root, { runId: "browser-flow-1", keep: true });
      expect(again).toEqual(first);
      expect(await readEvidenceRun(root, "current")).toEqual({
        schemaVersion: 1,
        runId: "browser-flow-1",
        status: "running",
        keep: true,
      });

      await writeEvidenceFile(root, "frames/001.png", Buffer.from("visual-only"), { keep: true });
      const red = await finishEvidenceRun(root, { runId: "browser-flow-1", status: "red" });
      expect(red).toMatchObject({ runId: "browser-flow-1", status: "red", rotated: true });
      expect(await readFile(path.join(root, "last-red", "frames", "001.png"), "utf8"))
        .toBe("visual-only");
      expect(await readEvidenceRun(root, "last-red")).toMatchObject({
        runId: "browser-flow-1",
        status: "red",
        keep: true,
      });
      expect(await readEvidenceRun(root, "current")).toEqual({
        schemaVersion: 1,
        runId: null,
        status: "empty",
        keep: false,
      });

      const repeated = await finishEvidenceRun(root, { runId: "browser-flow-1", status: "red" });
      expect(repeated).toMatchObject({ runId: "browser-flow-1", status: "red", rotated: false });
      expect((await readdir(root)).sort()).toEqual(["current", "last-red"]);
      expect(await readFile(path.join(root, "last-red", "frames", "001.png"), "utf8"))
        .toBe("visual-only");
    });
  });

  it("새 실행은 current만 교체하고 지난 RED는 보존한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "red-1" });
      await writeEvidenceFile(root, "red.txt", "red");
      await finishEvidenceRun(root, { runId: "red-1", status: "red" });

      await beginEvidenceRun(root, { runId: "green-2" });
      await writeEvidenceFile(root, "green.txt", "green");
      const green = await finishEvidenceRun(root, { runId: "green-2", status: "machine-green" });
      expect(green).toMatchObject({ runId: "green-2", status: "machine-green", rotated: false });
      expect(await readEvidenceRun(root, "current")).toMatchObject({
        runId: "green-2",
        status: "machine-green",
      });
      expect(await readFile(path.join(root, "current", "green.txt"), "utf8")).toBe("green");
      expect(await readFile(path.join(root, "last-red", "red.txt"), "utf8")).toBe("red");
      expect((await readdir(root)).sort()).toEqual(["current", "last-red"]);
    });
  });
});

describe("쓰기 전 hard quota", () => {
  it("기본 한도는 실행당 1GiB, 두 디렉터리 전체 2GiB이며 KEEP도 해제하지 않는다", () => {
    expect(EVIDENCE_RUN_LIMIT_BYTES).toBe(1024 ** 3);
    expect(EVIDENCE_STORE_LIMIT_BYTES).toBe(2 * 1024 ** 3);

    expect(projectEvidenceQuota({
      bucketBytes: EVIDENCE_RUN_LIMIT_BYTES - 1,
      otherBucketBytes: EVIDENCE_RUN_LIMIT_BYTES,
      existingFileBytes: 0,
      incomingBytes: 1,
      keep: true,
    })).toMatchObject({
      projectedBucketBytes: EVIDENCE_RUN_LIMIT_BYTES,
      projectedStoreBytes: EVIDENCE_STORE_LIMIT_BYTES,
    });

    expect(() => projectEvidenceQuota({
      bucketBytes: EVIDENCE_RUN_LIMIT_BYTES,
      otherBucketBytes: 0,
      existingFileBytes: 0,
      incomingBytes: 1,
      keep: true,
    })).toThrow(EvidenceQuotaError);
    expect(() => projectEvidenceQuota({
      bucketBytes: EVIDENCE_RUN_LIMIT_BYTES,
      otherBucketBytes: EVIDENCE_RUN_LIMIT_BYTES,
      existingFileBytes: 1,
      incomingBytes: 2,
      keep: true,
    })).toThrow(/2GiB/);

    expect(() => projectEvidenceQuota({
      bucketBytes: 0,
      otherBucketBytes: 0,
      existingFileBytes: 0,
      incomingBytes: 1,
      runLimitBytes: EVIDENCE_RUN_LIMIT_BYTES + 1,
      storeLimitBytes: EVIDENCE_STORE_LIMIT_BYTES,
    })).toThrow(/1GiB hard cap/);
    expect(() => projectEvidenceQuota({
      bucketBytes: 0,
      otherBucketBytes: 0,
      existingFileBytes: 0,
      incomingBytes: 1,
      runLimitBytes: EVIDENCE_RUN_LIMIT_BYTES,
      storeLimitBytes: EVIDENCE_STORE_LIMIT_BYTES + 1,
    })).toThrow(/2GiB hard cap/);
  });

  it("실제 쓰기 전에 계산해 거부하며 기존 파일은 손대지 않는다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "quota" });
      const initial = await inspectEvidenceStore(root);
      const limits = {
        runLimitBytes: initial.current.bytes + 4,
        storeLimitBytes: initial.totalBytes + 8,
      };

      await writeEvidenceFile(root, "frame.bin", Buffer.from("1234"), { limits, keep: true });
      await expect(writeEvidenceFile(
        root,
        "frame.bin",
        Buffer.from("12345"),
        { limits, keep: true },
      )).rejects.toThrow(EvidenceQuotaError);
      expect(await readFile(path.join(root, "current", "frame.bin"), "utf8")).toBe("1234");
    });
  });

  it("동시 쓰기도 같은 사전 quota 거래로 직렬화해 hard cap을 넘지 않는다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "concurrent-quota" });
      const initial = await inspectEvidenceStore(root);
      const limits = {
        runLimitBytes: initial.current.bytes + 4,
        storeLimitBytes: initial.totalBytes + 8,
      };
      const results = await Promise.allSettled([
        writeEvidenceFile(root, "a.bin", "1234", { limits, keep: true }),
        writeEvidenceFile(root, "b.bin", "5678", { limits, keep: true }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")?.reason)
        .toBeInstanceOf(EvidenceQuotaError);
      expect((await inspectEvidenceStore(root)).current.bytes).toBe(initial.current.bytes + 4);
    });
  });
});
