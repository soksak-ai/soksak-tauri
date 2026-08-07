// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runsToReclaim } from "./evidence-retention.mjs";

const run = (runId, bytes, finishedAtUnixMs) => ({ runId, bytes, finishedAtUnixMs });

// 규칙 — 한도를 지키는 것은 회수의 일이지 판정의 일이 아니다.
//
// 저장소는 전체 2GiB 한도를 든다. 그 한도는 옳다 — 넘으면 파일시스템이 먼저 차서 제품과 무관한
// red 가 남는다. 그런데 지난 실행을 아무도 회수하지 않으면 언젠가 **모든** 실행이 잴 자리를 못
// 얻는다. 실측 2026-08-08: 36칸 중 15칸이 "증거 저장소 전체 2GiB hard cap 초과" 로 blocked 였다.
// 제품과 무관한 이유로 판정면의 절반이 닫혔다.
//
// 한도를 낮추지 않는다. 자리를 만든다.
describe("runsToReclaim", () => {
  it("자리가 남으면 아무것도 회수하지 않는다", () => {
    const reclaim = runsToReclaim({
      runs: [run("a", 100, 3), run("b", 100, 2)],
      storeLimitBytes: 1_000,
      needBytes: 100,
    });
    expect(reclaim).toEqual([]);
  });

  // 이미 든 1200 에서 400 을 더 담으려면 1600 이 필요하다 — 둘을 비워야 자리가 난다.
  it("모자라면 오래된 것부터, 자리가 날 때까지 회수한다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 400, 3), run("mid", 400, 2), run("old", 400, 1)],
      storeLimitBytes: 1_000,
      needBytes: 400,
    });
    expect(reclaim).toEqual(["old", "mid"]);
  });

  // 최신 하나는 언제나 남으므로 자리가 끝내 안 나도 그것까지 지우지 않는다.
  it("자리가 끝내 안 나도 최신 하나는 남긴다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 400, 3), run("mid", 400, 2), run("old", 400, 1)],
      storeLimitBytes: 1_000,
      needBytes: 900,
    });
    expect(reclaim).toEqual(["old", "mid"]);
  });

  // 가장 최근 실행은 되짚을 근거다 — 자리를 못 만들어도 그것까지 지우지 않는다.
  it("가장 최근 실행은 회수하지 않는다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 900, 2), run("old", 900, 1)],
      storeLimitBytes: 1_000,
      needBytes: 900,
    });
    expect(reclaim).toEqual(["old"]);
  });

  it("지켜야 할 이름은 오래됐어도 회수하지 않는다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 400, 3), run("keep", 400, 1), run("old", 400, 2)],
      storeLimitBytes: 1_000,
      needBytes: 900,
      keep: ["keep"],
    });
    expect(reclaim).toEqual(["old"]);
  });

  // 순서를 못 읽은 실행을 가장 오래된 것으로 읽으면 최신 기여가 먼저 사라진다.
  it("순서를 못 읽은 실행은 회수 대상이 아니다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 900, 2), run("unreadable", 900, Number.NaN)],
      storeLimitBytes: 1_000,
      needBytes: 900,
    });
    expect(reclaim).toEqual([]);
  });
});

// 규칙 — 한도를 먹는 자리를 다 세야 자리가 난다.
//
// 저장소 한도는 저장소 **전체**를 잰다(current + last-red + runs). 그런데 회수는 runs 만 세고
// 다른 두 통이 든 자리를 몰랐다 — 실측 2026-08-08: 한 실행이 471MB 를 쓰는데 last-red 470MB 와
// runs 1.0GB 가 남아 세 번째 엔진에서 2GiB 한도를 넘었고, offscreen 이 세 칸을 잃었다.
//
// 한도를 낮추지 않는다. 세는 자리를 맞춘다.
describe("한도를 먹는 자리를 다 센다", () => {
  it("다른 통이 든 자리를 빼고 남은 자리로 판단한다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 200, 3), run("old", 200, 1)],
      storeLimitBytes: 1_000,
      // 다른 통이 500 을 들고 있으면 남은 자리는 1000-500-400 = 100 뿐이다.
      otherBucketBytes: 500,
      needBytes: 300,
    });
    expect(reclaim).toEqual(["old"]);
  });

  it("다른 통이 비었으면 지금 계약 그대로다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 200, 3), run("old", 200, 1)],
      storeLimitBytes: 1_000,
      otherBucketBytes: 0,
      needBytes: 300,
    });
    expect(reclaim).toEqual([]);
  });

  // 못 읽은 자리를 0 으로 읽으면 있는 자리보다 넉넉하다고 판단한다.
  it("다른 통의 자리를 못 읽었으면 넉넉하다고 읽지 않는다", () => {
    const reclaim = runsToReclaim({
      runs: [run("new", 200, 3), run("old", 200, 1)],
      storeLimitBytes: 1_000,
      otherBucketBytes: Number.NaN,
      needBytes: 300,
    });
    expect(reclaim).toEqual(["old"]);
  });
});
