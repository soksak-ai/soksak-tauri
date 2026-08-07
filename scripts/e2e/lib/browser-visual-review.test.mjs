// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserGateReport, serializeBrowserGateReport } from "./browser-gates.mjs";
import {
  applyVisualReview,
  parseBrowserGateReportText,
  requireHumanVisualReview,
} from "./browser-visual-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const REPORT = serializeBrowserGateReport(createBrowserGateReport({
  framework: "tauri",
  platform: "darwin",
  buildId: "build-visual",
  runId: "run-visual",
}));

const present = () => true;

describe("사람의 시각 검토는 명시된 자리에서만 기록된다", () => {
  it("직렬화한 정본 보고서를 되읽어 같은 정체성을 지킨다", () => {
    const report = parseBrowserGateReportText(REPORT);
    expect(report.identity).toEqual({
      framework: "tauri",
      platform: "darwin",
      buildId: "build-visual",
      runId: "run-visual",
    });
    expect(serializeBrowserGateReport(report)).toBe(REPORT);
  });

  it("자동으로 passed 가 되는 경로가 없다 — status 는 사람이 적어야 한다", () => {
    for (const status of [undefined, null, "", "pending", "not-applicable", "green", true]) {
      expect(() => requireHumanVisualReview({
        status,
        artifacts: ["browser/first-paint.png"],
        notes: "봤다",
        artifactExists: present,
      })).toThrow(/passed.*failed|사람/);
    }
  });

  it("검토한 artifact 와 메모가 없으면 기록하지 않는다", () => {
    expect(() => requireHumanVisualReview({
      status: "passed", artifacts: [], notes: "봤다", artifactExists: present,
    })).toThrow(/artifact/);
    expect(() => requireHumanVisualReview({
      status: "passed", artifacts: ["a.png"], notes: "", artifactExists: present,
    })).toThrow(/메모|notes/);
    expect(() => requireHumanVisualReview({
      status: "passed", artifacts: ["a.png"], notes: "봤다",
    })).toThrow(/artifactExists|확인/);
  });

  it("없는 캡처를 봤다고 적을 수 없다", () => {
    expect(() => requireHumanVisualReview({
      status: "passed",
      artifacts: ["browser/gone.png"],
      notes: "봤다",
      artifactExists: (file) => file !== "browser/gone.png",
    })).toThrow(/browser\/gone\.png/);
  });

  it("판정을 정본 보고서에 남기고 machine 상태는 건드리지 않는다", () => {
    const next = applyVisualReview(REPORT, {
      engine: "browser-chromium",
      gate: "B04",
      status: "passed",
      artifacts: ["browser-chromium/first-paint.png"],
      notes: "좌우 전환 전 프레임을 눈으로 확인",
      artifactExists: present,
    });
    const parsed = JSON.parse(next);
    expect(parsed.engines["browser-chromium"].B04.visualReview).toEqual({
      status: "passed",
      artifacts: ["browser-chromium/first-paint.png"],
      notes: "좌우 전환 전 프레임을 눈으로 확인",
    });
    expect(parsed.engines["browser-chromium"].B04.machine.status).toBe("not-run");
    expect(parsed.summary.visualReview.counts.passed).toBe(1);
    expect(parsed.summary.visualReview.counts.pending).toBe(35);
    expect(parsed.summary.machine.status).toBe("not-run");
  });

  it("같은 검토를 두 번 적어도 같은 정본이다", () => {
    const request = {
      engine: "browser",
      gate: "B07",
      status: "failed",
      artifacts: ["browser/flow-left.png"],
      notes: "레일이 왼쪽에서 겹쳐 보인다",
      artifactExists: present,
    };
    const once = applyVisualReview(REPORT, request);
    expect(applyVisualReview(once, request)).toBe(once);
  });
});

describe("시각 검토 커맨드는 재사용 가능한 자리다", () => {
  const runCli = (root, args) => spawnSync("node", ["scripts/e2e/visual-review.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  const fixture = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-"));
    writeFileSync(path.join(root, "browser-gates.json"), REPORT);
    mkdirSync(path.join(root, "browser-chromium"), { recursive: true });
    writeFileSync(path.join(root, "browser-chromium", "first-paint.png"), "not-a-real-png");
    return root;
  };

  it("사람이 게이트·판정·artifact·메모를 명시하면 정본 보고서에 남는다", () => {
    const root = fixture();
    const run = runCli(root, [
      "--report", path.join(root, "browser-gates.json"),
      "--engine", "browser-chromium",
      "--gate", "B04",
      "--status", "passed",
      "--artifact", "browser-chromium/first-paint.png",
      "--notes", "첫 페인트 캡처를 눈으로 확인했다",
    ]);
    expect(`${run.stdout}${run.stderr}`).toContain("browser-chromium/B04");
    expect(run.status).toBe(0);
    const parsed = JSON.parse(readFileSync(path.join(root, "browser-gates.json"), "utf8"));
    expect(parsed.engines["browser-chromium"].B04.visualReview).toEqual({
      status: "passed",
      artifacts: ["browser-chromium/first-paint.png"],
      notes: "첫 페인트 캡처를 눈으로 확인했다",
    });
  });

  it("status 를 빼면 아무것도 기록하지 않는다", () => {
    const root = fixture();
    const run = runCli(root, [
      "--report", path.join(root, "browser-gates.json"),
      "--engine", "browser-chromium",
      "--gate", "B04",
      "--artifact", "browser-chromium/first-paint.png",
      "--notes", "메모",
    ]);
    expect(run.status).not.toBe(0);
    expect(readFileSync(path.join(root, "browser-gates.json"), "utf8")).toBe(REPORT);
  });

  it("없는 캡처를 적으면 거절하고 보고서를 바꾸지 않는다", () => {
    const root = fixture();
    const run = runCli(root, [
      "--report", path.join(root, "browser-gates.json"),
      "--engine", "browser-chromium",
      "--gate", "B04",
      "--status", "passed",
      "--artifact", "browser-chromium/never-captured.png",
      "--notes", "메모",
    ]);
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("never-captured.png");
    expect(readFileSync(path.join(root, "browser-gates.json"), "utf8")).toBe(REPORT);
  });

  it("--list 는 아직 사람이 안 본 칸을 센다", () => {
    const root = fixture();
    const run = runCli(root, ["--report", path.join(root, "browser-gates.json"), "--list"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/pending 36/);
    expect(run.stdout).toContain("browser-chromium/B04");
  });
});
