// 픽스처 창 소유 규칙의 전수 대조 — 소켓 없이, 지도만으로.
//
// 이 규칙이 틀리면 증상은 "테스트 실패"가 아니라 **창이 쌓인다**로 나타난다. 아무도 그것을
// 실패로 보고하지 않으므로 여기서 기계가 본다.

import { describe, expect, it } from "vitest";
import {
  acquireFixtureWindow,
  emptyWorkspaceWindows,
  releaseFixtureWindow,
  releaseFixtureWindowsUnder,
  windowForRoot,
  windowsNamed,
  windowsUnder,
} from "./fixtureWindow.mjs";

const ROOT = "<machine-path>/.soksak-e2e/rail-border";

/** 최소 앱 대역 — 장부 한 벌과 호출 기록만 갖는다. */
function fakeApp({ projects = [], dead = new Set(), openLabel = "w-new" } = {}) {
  const calls = [];
  const map = [...projects];
  const rpc = async (name, params = {}, at) => {
    calls.push({ name, params, at });
    if (name === "window.projects") return { ok: true, data: { projects: [...map] } };
    if (name === "state.tree") {
      return dead.has(at)
        ? { ok: false, code: "UNKNOWN_COMMAND" }
        : { ok: true, data: { projects: [] } };
    }
    if (name === "window.close") {
      const i = map.findIndex((p) => p.window === params.label);
      if (i >= 0) map.splice(i, 1);
      return { ok: true, data: null };
    }
    if (name === "window.open") {
      map.push({ root: params.root, window: openLabel });
      return { ok: true, data: { label: openLabel } };
    }
    // 컨트롤 창 해소는 client.mjs 가 window.list 로 한다.
    if (name === "window.list") return { ok: true, data: { labels: map.map((p) => p.window) } };
    return { ok: true, data: {} };
  };
  return { rpc, calls, map, opts: { ctrl: "main", settleMs: 0 } };
}

describe("windowForRoot", () => {
  const MAP = [
    { root: "/a/one", window: "w-1" },
    { root: "/a/two", window: "w-2" },
  ];

  it("루트가 정확히 같은 창만 고른다", () => {
    expect(windowForRoot(MAP, "/a/two")).toBe("w-2");
    expect(windowForRoot(MAP, "/a")).toBeNull();
    // 접두사만 같은 이웃을 우리 것으로 오인하면 남의 창을 닫는다.
    expect(windowForRoot(MAP, "/a/one-more")).toBeNull();
  });

  it("빈 지도·없는 루트는 없음이다", () => {
    expect(windowForRoot([], "/a/one")).toBeNull();
    expect(windowForRoot(undefined, "/a/one")).toBeNull();
  });
});

describe("windowsUnder", () => {
  it("그 디렉터리 아래만 고른다 — 디렉터리 자신과 형제는 뺀다", () => {
    const map = [
      { root: "/e2e/a", window: "w-a" },
      { root: "/e2e/b", window: "w-b" },
      { root: "/e2e", window: "w-self" },
      { root: "/e2e-other/c", window: "w-x" },
    ];
    expect(windowsUnder(map, "/e2e").map((w) => w.label)).toEqual(["w-a", "w-b"]);
    // 끝 슬래시가 있든 없든 같은 답이다.
    expect(windowsUnder(map, "/e2e/").map((w) => w.label)).toEqual(["w-a", "w-b"]);
  });
});

describe("acquireFixtureWindow", () => {
  it("앞 판이 두고 간 우리 창을 물려받는다 — 새로 열지 않는다", async () => {
    const app = fakeApp({ projects: [{ root: ROOT, window: "w-old" }] });
    const got = await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    expect(got).toEqual({ label: "w-old", adopted: true });
    expect(app.calls.some((c) => c.name === "window.open")).toBe(false);
    expect(app.map).toHaveLength(1);
  });

  it("없으면 연다", async () => {
    const app = fakeApp({ openLabel: "w-fresh" });
    const got = await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    expect(got).toEqual({ label: "w-fresh", adopted: false });
  });

  /** 굳은 창을 그대로 쓰면 판정이 아니라 타임아웃이 나오고, 그건 결함처럼 보이지 않는다. */
  it("물려받은 창이 답하지 못하면 닫고 다시 연다", async () => {
    const app = fakeApp({
      projects: [{ root: ROOT, window: "w-wedged" }],
      dead: new Set(["w-wedged"]),
      openLabel: "w-fresh",
    });
    const got = await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    expect(got).toEqual({ label: "w-fresh", adopted: false });
    expect(app.calls.filter((c) => c.name === "window.close").map((c) => c.params.label)).toEqual([
      "w-wedged",
    ]);
    expect(app.map).toEqual([{ root: ROOT, window: "w-fresh" }]);
  });

  /** 두 번 불러도 창은 하나다 — 멱등의 정의. */
  it("연달아 두 번 확보해도 창은 하나다", async () => {
    const app = fakeApp({ openLabel: "w-fresh" });
    const a = await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    const b = await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    expect(b.label).toBe(a.label);
    expect(b.adopted).toBe(true);
    expect(app.map).toHaveLength(1);
  });

  /** 라벨만 믿지 않는다 — 장부가 그 창이 우리 루트를 든다고 말해야 우리 창이다. */
  it("장부가 뒷받침하지 않는 라벨은 거부한다", async () => {
    const app = fakeApp();
    app.rpc = async (name, params = {}, at) => {
      if (name === "window.projects") return { ok: true, data: { projects: [] } };
      if (name === "window.open") return { ok: true, data: { label: "w-somebody-elses" } };
      return { ok: true, data: {} };
    };
    await expect(
      acquireFixtureWindow(app.rpc, ROOT, { ctrl: "main", settleMs: 0, confirmTries: 2 }),
    ).rejects.toThrow(/장부가 말하지 않는다/);
  });
});

describe("회수", () => {
  it("우리 루트의 창만 닫고, 없으면 아무 일도 하지 않는다", async () => {
    const app = fakeApp({
      projects: [
        { root: ROOT, window: "w-ours" },
        { root: "<machine-path>/project", window: "w-user" },
      ],
    });
    expect(await releaseFixtureWindow(app.rpc, ROOT, app.opts)).toBe("w-ours");
    expect(app.map).toEqual([{ root: "<machine-path>/project", window: "w-user" }]);
    // 두 번째 호출은 조용히 없음이다.
    expect(await releaseFixtureWindow(app.rpc, ROOT, app.opts)).toBeNull();
  });

  it("밭 아래 창을 전부 걷고 밖은 건드리지 않는다", async () => {
    const app = fakeApp({
      projects: [
        { root: "/e2e/a", window: "w-a" },
        { root: "/e2e/b", window: "w-b" },
        { root: "/home/me/real", window: "w-user" },
      ],
    });
    const swept = await releaseFixtureWindowsUnder(app.rpc, "/e2e", app.opts);
    expect(swept.map((w) => w.label)).toEqual(["w-a", "w-b"]);
    expect(app.map).toEqual([{ root: "/home/me/real", window: "w-user" }]);
  });
});

describe("windowsNamed", () => {
  /** 공용 임시 밭은 디렉터리로 가를 수 없다 — 이름 규약만이 우리 것임을 말한다. */
  it("루트 이름 접두사로만 고른다", () => {
    const map = [
      { root: "/tmp/T/soksak-e2e-mw-a", window: "w-a" },
      { root: "/tmp/T/soksak-e2e-p6", window: "w-b" },
      { root: "/tmp/T/someone-else", window: "w-x" },
      { root: "<machine-path>/soksak-e2e-lookalike/deep", window: "w-y" },
    ];
    expect(windowsNamed(map, "soksak-e2e-").map((w) => w.label)).toEqual(["w-a", "w-b"]);
  });
});

describe("emptyWorkspaceWindows", () => {
  /** 빈 창은 기본 회수 대상이 아니다 — 고르기만 하고, 닫을지는 부르는 쪽이 정한다. */
  it("프로젝트를 안 든 w-* 만 고른다 — 컨트롤 플레인은 뺀다", () => {
    const labels = ["main", "w-held", "w-empty1", "w-empty2"];
    const projects = [{ root: "/x", window: "w-held" }];
    expect(emptyWorkspaceWindows(labels, projects)).toEqual(["w-empty1", "w-empty2"]);
    // 지도가 비면 모든 워크스페이스 창이 빈 창이다.
    expect(emptyWorkspaceWindows(labels, [])).toEqual(["w-held", "w-empty1", "w-empty2"]);
  });
});
