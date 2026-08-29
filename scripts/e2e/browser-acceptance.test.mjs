// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { namedRunReport } from "./browser-acceptance.mjs";
import { evidenceRunPath } from "./lib/evidence-store.mjs";

const ROOT = path.join(process.env.HOME ?? "<local-evidence>", ".soksak-e2e/evidence/.acceptance-read-test");

function writeRun(runId, body = { identity: { runId } }, bucket = "runs") {
  // 경로 규칙은 저장소가 소유한다 — 손으로 지으면 이 테스트가 규칙과 갈린다.
  const dir = bucket === "runs" ? evidenceRunPath(ROOT, runId) : path.join(ROOT, bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "browser-gates.json"), JSON.stringify(body));
}

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

// 규칙 — 인수는 자기 실행을 이름으로 읽는다.
//
// mtime 으로 "가장 최근" 을 고르면, 한 실행기가 실패했을 때 그 저장소의 지난 실행이 최신으로
// 남아 인수가 서로 다른 두 실행을 잇는다. buildId 가 우연히 같으면 통과하고 다르면 던진다 —
// 같은 코드가 저장소 상태에 따라 다른 답을 낸다. 그것이 운이다.
describe("namedRunReport", () => {
  it("이름 준 실행을 읽는다", () => {
    writeRun("wanted");
    writeRun("other");
    expect(namedRunReport(ROOT, "wanted").identity.runId).toBe("wanted");
  });

  it("이름 준 실행이 없으면 다른 실행으로 대신하지 않는다", () => {
    writeRun("other");
    expect(() => namedRunReport(ROOT, "wanted")).toThrow(/wanted/);
  });

  it("이름이 없으면 추측하지 않고 이름을 달고 멈춘다", () => {
    writeRun("other");
    expect(() => namedRunReport(ROOT, undefined)).toThrow(/run id/i);
    expect(() => namedRunReport(ROOT, "")).toThrow(/run id/i);
  });

  it("빈 저장소도 같은 답이다 — 없는 것을 만들지 않는다", () => {
    mkdirSync(path.join(ROOT, "runs"), { recursive: true });
    expect(() => namedRunReport(ROOT, "wanted")).toThrow(/wanted/);
  });
});

// 규칙 — 이름이 같으면 어느 통에 있든 그 실행이다.
//
// 저장소는 판정에 따라 실행을 다른 통에 둔다(green → runs, red → last-red). 인수는 그 실행의
// 이름으로 읽는데, 한 통만 보면 red 로 끝난 실행의 보고서를 못 찾는다 — 실측 2026-08-08:
// slot-freeze 가 red 로 끝나자 집계가 ENOENT 로 죽어 36칸이 한 줄도 안 나왔다.
//
// red 인 실행의 보고서야말로 읽어야 할 것이다. 통이 아니라 이름으로 찾는다.
describe("red 로 끝난 실행도 이름으로 읽는다", () => {
  it("last-red 에 있는 실행을 찾는다", () => {
    writeRun("wanted", { identity: { runId: "wanted" } }, "last-red");
    expect(namedRunReport(ROOT, "wanted").identity.runId).toBe("wanted");
  });

  it("두 통에 다 있으면 runs 를 읽는다 — 확정본이 정본이다", () => {
    writeRun("wanted", { identity: { runId: "wanted" }, from: "runs" });
    writeRun("wanted", { identity: { runId: "wanted" }, from: "last-red" }, "last-red");
    expect(namedRunReport(ROOT, "wanted").from).toBe("runs");
  });

  it("어느 통에도 없으면 다른 실행으로 대신하지 않는다", () => {
    writeRun("other");
    writeRun("another", { identity: { runId: "another" } }, "last-red");
    expect(() => namedRunReport(ROOT, "wanted")).toThrow(/wanted/);
  });
});

// 확정 전 실행은 current 에 산다. 확정이 못 돌아도(실행이 중간에 죽어도) 그때까지 잰 값은
// 그 자리에 남아 있고, 그것이야말로 읽어야 할 것이다.
describe("확정 전 실행도 이름으로 읽는다", () => {
  it("current 에 있는 실행을 찾는다", () => {
    writeRun("wanted", { identity: { runId: "wanted" } }, "current");
    expect(namedRunReport(ROOT, "wanted").identity.runId).toBe("wanted");
  });

  it("세 통에 다 있으면 runs 를 읽는다 — 확정본이 정본이다", () => {
    writeRun("wanted", { identity: { runId: "wanted" }, from: "runs" });
    writeRun("wanted", { identity: { runId: "wanted" }, from: "last-red" }, "last-red");
    writeRun("wanted", { identity: { runId: "wanted" }, from: "current" }, "current");
    expect(namedRunReport(ROOT, "wanted").from).toBe("runs");
  });
});
