// @vitest-environment node

import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_RUN_LIMIT_BYTES,
  EVIDENCE_STORE_LIMIT_BYTES,
  EvidenceQuotaError,
  beginEvidenceRun,
  ensureEvidenceStore,
  evidenceRunPath,
  evidenceStorePaths,
  finishEvidenceRun,
  inspectEvidenceStore,
  produceEvidenceArtifact,
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
  it("current·last-red와 runId 정본 저장소만 선언한다", async () => {
    await inTemporaryStore(async (root) => {
      const paths = evidenceStorePaths(root);
      expect(paths).toEqual({
        root: path.resolve(root),
        current: path.join(path.resolve(root), "current"),
        lastRed: path.join(path.resolve(root), "last-red"),
        runs: path.join(path.resolve(root), "runs"),
      });

      await ensureEvidenceStore(root);
      expect((await readdir(root)).sort()).toEqual(["current", "last-red", "runs"]);
      expect((await readdir(paths.current)).sort()).toEqual(["run.json"]);
      expect((await readdir(paths.lastRed)).sort()).toEqual(["run.json"]);
      expect(await readdir(paths.runs)).toEqual([]);
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
  it("연속 RED의 run별 원본은 불변 보존하고 last-red만 최신 실패로 갱신한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "red-preserved-1" });
      await writeEvidenceFile(root, "marker.txt", "first-red");
      await finishEvidenceRun(root, { runId: "red-preserved-1", status: "red" });

      await beginEvidenceRun(root, { runId: "red-preserved-2" });
      await writeEvidenceFile(root, "marker.txt", "second-red");
      await finishEvidenceRun(root, { runId: "red-preserved-2", status: "red" });

      const archived = await readdir(path.join(root, "runs"));
      expect(archived).toHaveLength(2);
      const originals = await Promise.all(archived.map(async (entry) => ({
        state: JSON.parse(await readFile(path.join(root, "runs", entry, "run.json"), "utf8")),
        marker: await readFile(path.join(root, "runs", entry, "marker.txt"), "utf8"),
      })));
      expect(originals.map(({ state }) => state.runId).sort()).toEqual([
        "red-preserved-1",
        "red-preserved-2",
      ]);
      expect(originals.map(({ marker }) => marker).sort()).toEqual(["first-red", "second-red"]);
      expect(await readEvidenceRun(root, "last-red")).toMatchObject({
        runId: "red-preserved-2",
        status: "red",
      });
      expect(await readFile(path.join(root, "last-red", "marker.txt"), "utf8"))
        .toBe("second-red");
      const firstAgain = await beginEvidenceRun(root, { runId: "red-preserved-1" });
      expect(firstAgain).toMatchObject({ runId: "red-preserved-1", status: "red" });
      await expect(writeEvidenceFile(root, "marker.txt", "mutated"))
        .rejects.toThrow(/running 실행만/);
      expect(await readFile(
        path.join(evidenceRunPath(root, "red-preserved-1"), "marker.txt"),
        "utf8",
      ))
        .toBe("first-red");
    });
  });

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
      expect((await readdir(root)).sort()).toEqual(["current", "last-red", "runs"]);
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
      expect((await readdir(root)).sort()).toEqual(["current", "last-red", "runs"]);
    });
  });

  it("machine-green도 다음 current 시작과 무관한 run 정본으로 남긴다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "green-preserved" });
      await writeEvidenceFile(root, "green.txt", "machine evidence");
      await finishEvidenceRun(root, { runId: "green-preserved", status: "machine-green" });
      await beginEvidenceRun(root, { runId: "next-running" });

      const archived = await readdir(path.join(root, "runs"));
      expect(archived).toHaveLength(1);
      expect(JSON.parse(await readFile(
        path.join(root, "runs", archived[0], "run.json"),
        "utf8",
      ))).toMatchObject({ runId: "green-preserved", status: "machine-green" });
      expect(await readFile(path.join(root, "runs", archived[0], "green.txt"), "utf8"))
        .toBe("machine evidence");
      expect(await readEvidenceRun(root, "current")).toMatchObject({
        runId: "next-running",
        status: "running",
      });
    });
  });

  it("기존 last-red만 있는 저장소도 최초 점검에서 run 정본으로 승격한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "legacy-last-red" });
      await writeEvidenceFile(root, "legacy.txt", "preserve me");
      await finishEvidenceRun(root, { runId: "legacy-last-red", status: "red" });

      const paths = evidenceStorePaths(root);
      await rm(paths.runs, { recursive: true });
      await mkdir(paths.runs);
      await ensureEvidenceStore(root);

      expect(await readFile(
        path.join(evidenceRunPath(root, "legacy-last-red"), "legacy.txt"),
        "utf8",
      )).toBe("preserve me");
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

describe("외부 snapshot/record/full producer quota 거래", () => {
  it("예약이 한도를 넘으면 producer를 호출하지 않고 기존 artifact도 보존한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "producer-preflight" });
      await writeEvidenceFile(root, "capture.bin", "keep");
      const initial = await inspectEvidenceStore(root);
      const limits = {
        runLimitBytes: initial.current.bytes + 4,
        storeLimitBytes: initial.totalBytes + 8,
      };
      let calls = 0;
      await expect(produceEvidenceArtifact(
        root,
        "capture.bin",
        { kind: "file", maxBytes: 9, limits, keep: true },
        async () => { calls += 1; },
      )).rejects.toThrow(EvidenceQuotaError);
      expect(calls).toBe(0);
      expect(await readFile(path.join(root, "current", "capture.bin"), "utf8")).toBe("keep");
    });
  });

  it("기존 directory를 빈 경계로 안전 교체하고 중첩 파일 전체 byte를 합산한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "producer-directory" });
      const target = path.join(root, "current", "recording");
      await mkdir(path.join(target, "old"), { recursive: true });
      await writeFile(path.join(target, "old", "stale.bin"), "stale");

      const result = await produceEvidenceArtifact(
        root,
        "recording",
        { kind: "directory", maxBytes: 12 },
        async ({ path: outputPath, maxBytes }) => {
          expect(path.isAbsolute(outputPath)).toBe(true);
          expect(outputPath).toBe(target);
          expect(maxBytes).toBe(12);
          expect(await readdir(outputPath)).toEqual([]);
          await writeFile(path.join(outputPath, "a.bin"), "123");
          await mkdir(path.join(outputPath, "nested"));
          await writeFile(path.join(outputPath, "nested", "b.bin"), "4567");
          return "recorded";
        },
      );

      expect(result).toEqual({
        path: target,
        kind: "directory",
        maxBytes: 12,
        bytes: 7,
        result: "recorded",
      });
      await expect(access(path.join(target, "old", "stale.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("동시 producer를 직렬화해 첫 예약 이후 두 번째를 callback 전에 거부한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "producer-concurrent" });
      const initial = await inspectEvidenceStore(root);
      const limits = {
        runLimitBytes: initial.current.bytes + 4,
        storeLimitBytes: initial.totalBytes + 8,
      };
      let calls = 0;
      let releaseFirst;
      let signalFirst;
      const firstStarted = new Promise((resolve) => { signalFirst = resolve; });
      const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
      const first = produceEvidenceArtifact(
        root,
        "a.bin",
        { kind: "file", maxBytes: 4, limits },
        async ({ path: outputPath }) => {
          calls += 1;
          signalFirst();
          await holdFirst;
          await writeFile(outputPath, "1234");
        },
      );
      await firstStarted;
      const second = produceEvidenceArtifact(
        root,
        "b.bin",
        { kind: "file", maxBytes: 4, limits },
        async ({ path: outputPath }) => {
          calls += 1;
          await writeFile(outputPath, "5678");
        },
      );
      releaseFirst();
      const results = await Promise.allSettled([first, second]);

      expect(calls).toBe(1);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")?.reason)
        .toBeInstanceOf(EvidenceQuotaError);
      expect(await readFile(path.join(root, "current", "a.bin"), "utf8")).toBe("1234");
      await expect(access(path.join(root, "current", "b.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("maxBytes를 넘긴 producer artifact만 제거하고 quota 오류를 반환한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "producer-rollback" });
      await writeEvidenceFile(root, "sibling.bin", "safe");
      let error;
      try {
        await produceEvidenceArtifact(
          root,
          "oversized/frame.bin",
          { kind: "file", maxBytes: 4 },
          async ({ path: outputPath }) => writeFile(outputPath, "12345"),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EvidenceQuotaError);
      expect(error?.code).toBe("EVIDENCE_QUOTA_EXCEEDED");
      await expect(access(path.join(root, "current", "oversized", "frame.bin")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(root, "current", "sibling.bin"), "utf8")).toBe("safe");
    });
  });

  it("producer 오류의 cap 이내 partial은 보존하고 cap 초과 partial은 제거하며 cause를 보존한다", async () => {
    await inTemporaryStore(async (root) => {
      await beginEvidenceRun(root, { runId: "producer-partial" });
      const withinCause = new Error("snapshot interrupted");
      let withinError;
      try {
        await produceEvidenceArtifact(
          root,
          "partial.bin",
          { kind: "file", maxBytes: 8 },
          async ({ path: outputPath }) => {
            await writeFile(outputPath, "1234");
            throw withinCause;
          },
        );
      } catch (caught) {
        withinError = caught;
      }
      expect(withinError).toBe(withinCause);
      expect(await readFile(path.join(root, "current", "partial.bin"), "utf8")).toBe("1234");

      const overCause = new Error("recording interrupted");
      let overError;
      try {
        await produceEvidenceArtifact(
          root,
          "partial-recording",
          { kind: "directory", maxBytes: 4 },
          async ({ path: outputPath }) => {
            await writeFile(path.join(outputPath, "frame.bin"), "12345");
            throw overCause;
          },
        );
      } catch (caught) {
        overError = caught;
      }
      expect(overError).toBeInstanceOf(EvidenceQuotaError);
      expect(overError?.cause).toBe(overCause);
      await expect(access(path.join(root, "current", "partial-recording")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("running이 아니거나 경계를 벗어난 요청은 producer 전에 거부한다", async () => {
    await inTemporaryStore(async (root) => {
      await ensureEvidenceStore(root);
      let calls = 0;
      const producer = async () => { calls += 1; };
      await expect(produceEvidenceArtifact(
        root,
        "idle.bin",
        { kind: "file", maxBytes: 1 },
        producer,
      )).rejects.toThrow(/running/);
      await beginEvidenceRun(root, { runId: "producer-boundary" });
      await expect(produceEvidenceArtifact(
        root,
        "../escape.bin",
        { kind: "file", maxBytes: 1 },
        producer,
      )).rejects.toThrow(/경계/);
      await expect(produceEvidenceArtifact(
        root,
        path.join(root, "absolute.bin"),
        { kind: "file", maxBytes: 1 },
        producer,
      )).rejects.toThrow(/상대/);
      expect(calls).toBe(0);
    });
  });
});
