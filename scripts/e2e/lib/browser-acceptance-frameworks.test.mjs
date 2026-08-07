// @vitest-environment node
import { describe, expect, it } from "vitest";
import { latestReportPerFramework } from "./browser-acceptance-frameworks.mjs";

const entry = (framework, buildId, orderedAtUnixMs) => ({
  report: { identity: { framework, platform: "darwin", buildId, runId: `${framework}-${buildId}` } },
  orderedAtUnixMs,
});

// 인수는 프레임워크마다 36칸을 요구한다. 저장소가 여러 프레임워크의 실행을 담는데 최신 하나만
// 읽으면, 나중에 돈 프레임워크가 먼저 돈 프레임워크의 기여를 덮는다 — 이미 잰 칸도 안 실린다.
describe("프레임워크마다 자기 최신 실행", () => {
  it("프레임워크별로 가장 최근 실행을 하나씩 고른다", () => {
    const picked = latestReportPerFramework([
      entry("tauri", "a", 100),
      entry("electron", "b", 90),
      entry("tauri", "c", 200),
    ]);
    expect(picked.map((r) => r.identity.framework)).toEqual(["electron", "tauri"]);
    expect(picked.find((r) => r.identity.framework === "tauri").identity.buildId).toBe("c");
  });

  it("한 프레임워크만 있으면 그 하나만 낸다 — 없는 것을 지어내지 않는다", () => {
    const picked = latestReportPerFramework([entry("tauri", "a", 100)]);
    expect(picked).toHaveLength(1);
    expect(picked[0].identity.framework).toBe("tauri");
  });

  it("빈 저장소는 빈 목록이다", () => {
    expect(latestReportPerFramework([])).toEqual([]);
  });

  // 순서를 못 읽은 실행을 최신으로 읽으면 옛 기여가 새 기여를 덮는다.
  it("순서를 못 읽은 실행은 최신 후보가 아니다", () => {
    const picked = latestReportPerFramework([
      entry("tauri", "old", 100),
      entry("tauri", "unreadable", Number.NaN),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0].identity.buildId).toBe("old");
  });

  it("모든 실행의 순서를 못 읽으면 그 프레임워크는 없는 것으로 둔다", () => {
    expect(latestReportPerFramework([entry("tauri", "x", Number.NaN)])).toEqual([]);
  });

  it("프레임워크를 선언하지 않은 실행은 어느 프레임워크에도 실리지 않는다", () => {
    expect(latestReportPerFramework([entry(undefined, "x", 100)])).toEqual([]);
  });
});
