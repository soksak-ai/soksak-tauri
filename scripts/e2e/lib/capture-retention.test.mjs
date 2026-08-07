// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reclaimCaptureRuns } from "./capture-retention.mjs";

const ROOT = path.join(os.tmpdir(), `soksak-capture-retention-${process.pid}`);

function writeRun(name, atUnixSec) {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "frame.png"), "x".repeat(1024));
  utimesSync(dir, atUnixSec, atUnixSec);
}

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

// 규칙 — 사람용 캡처도 자기 자리를 스스로 지킨다.
//
// 기계 판정 저장소는 한도와 회수를 든다. 사람용 캡처(B12 냉시동 PNG)는 그 밖이라 아무도 비우지
// 않았고, 실행마다 76MB 씩 쌓여 764MB 가 됐다 — 손으로 지우는 것이 유일한 관리였다.
// 손으로 하는 관리는 관리가 아니라 회피다.
describe("reclaimCaptureRuns", () => {
  it("남길 수보다 적으면 아무것도 지우지 않는다", () => {
    writeRun("a", 100);
    writeRun("b", 200);
    expect(reclaimCaptureRuns(ROOT, { keepRuns: 3 })).toEqual([]);
    expect(existsSync(path.join(ROOT, "a"))).toBe(true);
  });

  it("오래된 것부터 지우고 최신 N 개를 남긴다", () => {
    writeRun("old", 100);
    writeRun("mid", 200);
    writeRun("new", 300);
    expect(reclaimCaptureRuns(ROOT, { keepRuns: 2 })).toEqual(["old"]);
    expect(existsSync(path.join(ROOT, "old"))).toBe(false);
    expect(existsSync(path.join(ROOT, "new"))).toBe(true);
  });

  it("지켜야 할 이름은 오래됐어도 남긴다 — 지금 도는 실행을 지우지 않는다", () => {
    writeRun("old", 100);
    writeRun("mid", 200);
    writeRun("new", 300);
    expect(reclaimCaptureRuns(ROOT, { keepRuns: 1, keep: ["old"] })).toEqual(["mid"]);
    expect(existsSync(path.join(ROOT, "old"))).toBe(true);
  });

  it("없는 자리는 조용히 넘어간다 — 첫 실행이 실패하지 않는다", () => {
    expect(reclaimCaptureRuns(path.join(ROOT, "없음"), { keepRuns: 2 })).toEqual([]);
  });
});
