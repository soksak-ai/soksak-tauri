// @vitest-environment node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { namedRunReport } from "./browser-acceptance.mjs";
import { evidenceRunPath } from "./lib/evidence-store.mjs";

const ROOT = path.join(process.env.HOME ?? "/tmp", ".soksak-e2e/evidence/.acceptance-read-test");

function writeRun(runId, body = { identity: { runId } }) {
  // 경로 규칙은 저장소가 소유한다 — 손으로 지으면 이 테스트가 규칙과 갈린다.
  const dir = evidenceRunPath(ROOT, runId);
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
