// @vitest-environment node
// 픽스처 창 소유 규칙의 전수 대조 — 소켓 없이, 지도만으로.
//
// 이 규칙이 틀리면 증상은 "테스트 실패"가 아니라 **창이 쌓인다**로 나타난다. 아무도 그것을
// 실패로 보고하지 않으므로 여기서 기계가 본다.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acquireFixtureWindow,
  emptyWorkspaceWindows,
  forgetFixtureData,
  reclaimStoredWindowSnapshots,
  replaceFixtureWindow,
  releaseFixtureWindow,
  releaseFixtureWindowsUnder,
  windowForRoot,
  windowsForExactRoots,
  windowsUnder,
} from "./fixtureWindow.mjs";

const ROOT = "/workspace/.soksak-e2e/rail-border";

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
    if (name === "data.kv.deleteMany") {
      return {
        ok: true,
        data: { ns: "core", requested: params.keys.length, deleted: 0, absent: params.keys.length },
      };
    }
    if (name === "project.recent.remove") return { ok: true, data: {} };
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

  // 창은 프로젝트를 여럿 든다. 그중 하나가 픽스처라고 그 창을 닫으면 **같은 창에 있던 사용자
  // 프로젝트가 함께 닫힌다.**
  //
  // RED 근거(실측 2026-08-01): 사용자 창 하나가 core + 픽스처 둘을 들고 있었다. 회수가 그 창을
  // 픽스처 창으로 보고 닫았고, 스냅샷 키까지 지웠다 — 백업에서 되살렸다. 창을 닫는 판정은
  // "이 창에 픽스처가 있는가" 가 아니라 **"이 창이 픽스처뿐인가"** 여야 한다.
  it("사용자 프로젝트를 함께 든 창은 고르지 않는다 — 하나라도 밖에 있으면 남의 창이다", () => {
    const map = [
      { root: "/e2e/a", window: "w-mixed" },
      { root: "/home/me/core", window: "w-mixed" },
      { root: "/e2e/b", window: "w-pure" },
    ];
    expect(windowsUnder(map, "/e2e").map((w) => w.label)).toEqual(["w-pure"]);
  });

  it("한 창이 픽스처만 여럿 들었으면 한 번만 고른다 — 같은 창을 두 번 닫지 않는다", () => {
    const map = [
      { root: "/e2e/a", window: "w-pure" },
      { root: "/e2e/b", window: "w-pure" },
    ];
    expect(windowsUnder(map, "/e2e").map((w) => w.label)).toEqual(["w-pure"]);
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

  it("시각 검증 창은 사용자 포커스를 가져오지 않는다", async () => {
    const app = fakeApp({ openLabel: "w-background" });
    await acquireFixtureWindow(app.rpc, ROOT, app.opts);
    const opened = app.calls.find((c) => c.name === "window.open");
    expect(opened?.params).toEqual({ root: ROOT, focus: false });
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

describe("replaceFixtureWindow", () => {
  it("앞 실행의 exact fixture-only 창과 저장 상태를 회수한 뒤 새 창을 연다", async () => {
    const app = fakeApp({
      projects: [{ root: ROOT, window: "w-old" }],
      openLabel: "w-fresh",
    });
    const got = await replaceFixtureWindow(app.rpc, ROOT, app.opts);
    expect(got).toEqual({ label: "w-fresh", adopted: false });
    expect(app.calls.filter((call) => call.name === "window.close").map((call) => call.params.label))
      .toEqual(["w-old"]);
    expect(app.calls.filter((call) => call.name === "data.kv.deleteMany")).toHaveLength(1);
    expect(app.calls.filter((call) => call.name === "project.recent.remove")).toHaveLength(1);
  });

  it("fixture root가 사용자 프로젝트와 같은 창에 있으면 닫거나 재사용하지 않는다", async () => {
    const app = fakeApp({
      projects: [
        { root: ROOT, window: "w-mixed" },
        { root: "/workspace/real-project", window: "w-mixed" },
      ],
    });
    await expect(replaceFixtureWindow(app.rpc, ROOT, app.opts)).rejects.toThrow(/함께 든 창/);
    expect(app.calls.some((call) => call.name === "window.close")).toBe(false);
    expect(app.calls.some((call) => call.name === "window.open")).toBe(false);
  });
});

describe("회수", () => {
  it("우리 루트의 창만 닫고, 없으면 아무 일도 하지 않는다", async () => {
    const app = fakeApp({
      projects: [
        { root: ROOT, window: "w-ours" },
        { root: "/workspace/project", window: "w-user" },
      ],
    });
    expect(await releaseFixtureWindow(app.rpc, ROOT, app.opts)).toBe("w-ours");
    expect(app.map).toEqual([{ root: "/workspace/project", window: "w-user" }]);
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

describe("windowsForExactRoots", () => {
  it("이름이 아니라 선언된 exact root로만 소유 창을 고른다", () => {
    const map = [
      { root: "/fixtures/multiwindow/a", window: "w-a" },
      { root: "/fixtures/multiwindow/p6", window: "w-b" },
      { root: "/fixtures/multiwindow/unknown", window: "w-x" },
      { root: "/workspace/work/soksak-e2e-user-project", window: "w-user" },
      { root: "/fixtures/multiwindow/a", window: "w-mixed" },
      { root: "/workspace/work/real", window: "w-mixed" },
    ];
    expect(windowsForExactRoots(map, [
      "/fixtures/multiwindow/a",
      "/fixtures/multiwindow/p6",
    ]).map((w) => w.label)).toEqual(["w-a", "w-b"]);
  });

  it("상대경로 선언은 소유권으로 받아들이지 않고 멀티윈도우 하니스도 임시 이름 규약을 쓰지 않는다", () => {
    expect(() => windowsForExactRoots([], ["relative/fixture"])).toThrow(/절대경로/);
    const source = readFileSync(new URL("../multiwindow.mjs", import.meta.url), "utf8");
    expect(source).toContain('path.join(os.homedir(), ".soksak-e2e", "multiwindow")');
    expect(source).not.toContain("os.tmpdir()");
    expect(source).not.toContain("soksak-e2e-mw");
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

describe("저장된 픽스처 snapshot batch 회수", () => {
  const FIELD = "/workspace/.soksak-e2e";

  it("N snapshots도 entries 1회 + deleteMany 1회이며 per-key get/delete는 0회다", async () => {
    const entries = [
      { key: "windows", value: { slots: [{ label: "w-manifest" }] } },
      { key: "window/w-live", value: { projects: [{ root: `${FIELD}/live` }] } },
      { key: "window/w-manifest", value: { projects: [{ root: `${FIELD}/manifest` }] } },
      ...Array.from({ length: 200 }, (_, i) => ({
        key: `window/w-stale-${i}`,
        value: { projects: [{ root: `${FIELD}/case-${i}` }] },
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        key: `window/w-stale-${i}#prev`,
        value: { projects: [{ root: `${FIELD}/case-${i}` }] },
      })),
    ];
    const calls = [];
    const rpc = async (name, params, at) => {
      calls.push({ name, params, at });
      if (name === "data.kv.entries") return { ok: true, data: { ns: "core", entries } };
      if (name === "data.kv.deleteMany") {
        return { ok: true, data: { ns: "core", requested: params.keys.length, deleted: params.keys.length, absent: 0 } };
      }
      throw new Error(`unexpected ${name}`);
    };

    const out = await reclaimStoredWindowSnapshots(rpc, "main", {
      field: FIELD,
      liveLabels: ["w-live"],
    });

    expect(out).toMatchObject({ labels: 200, requested: 400, deleted: 400, absent: 0 });
    expect(calls.filter((c) => c.name === "data.kv.entries")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "data.kv.deleteMany")).toHaveLength(1);
    expect(calls.some((c) => c.name === "data.kv.get" || c.name === "data.kv.delete")).toBe(false);
    const deleted = calls.find((c) => c.name === "data.kv.deleteMany").params.keys;
    expect(deleted).not.toContain("window/w-live");
    expect(deleted).not.toContain("window/w-manifest");
  });

  it("한 세대라도 사용자 프로젝트를 든 snapshot은 current와 prev 모두 불가침이다", async () => {
    const calls = [];
    const rpc = async (name, params) => {
      calls.push({ name, params });
      if (name === "data.kv.entries") return {
        ok: true,
        data: {
          ns: "core",
          entries: [
            { key: "windows", value: { slots: [] } },
            { key: "window/w-user", value: { projects: [{ root: "/workspace/work" }] } },
            { key: "window/w-user#prev", value: { projects: [{ root: `${FIELD}/old-fixture` }] } },
            { key: "window/w-empty", value: { projects: [] } },
            { key: "window/w-unproven", value: { projects: [{ root: `${FIELD}/ok` }] } },
            { key: "window/w-unproven#prev", value: { projects: [] } },
            { key: "window/w-fixture", value: { projects: [{ root: `${FIELD}/ok` }] } },
            { key: "window/w-fixture#prev", value: { projects: [{ root: `${FIELD}/ok` }] } },
            { key: "window/w-user-named", value: { projects: [{ root: "/workspace/work/soksak-e2e-important" }] } },
          ],
        },
      };
      if (name === "data.kv.deleteMany") return {
        ok: true,
        data: { ns: "core", requested: params.keys.length, deleted: params.keys.length, absent: 0 },
      };
      throw new Error(`unexpected ${name}`);
    };

    await reclaimStoredWindowSnapshots(rpc, "main", { field: FIELD, liveLabels: [] });
    const keys = calls.find((c) => c.name === "data.kv.deleteMany").params.keys;
    expect(keys).toEqual([
      "window/w-fixture",
      "window/w-fixture#prev",
    ]);
    expect(keys).not.toContain("window/w-user");
    expect(keys).not.toContain("window/w-user#prev");
    expect(keys).not.toContain("window/w-empty");
    expect(keys).not.toContain("window/w-unproven");
    expect(keys).not.toContain("window/w-unproven#prev");
    expect(keys).not.toContain("window/w-user-named");
  });

  it("forgetFixtureData는 snapshot 두 key를 deleteMany 한 번으로 지운다", async () => {
    const calls = [];
    const rpc = async (name, params) => {
      calls.push({ name, params });
      if (name === "data.kv.deleteMany") {
        return { ok: true, data: { ns: "core", requested: 2, deleted: 1, absent: 1 } };
      }
      if (name === "project.recent.remove") return { ok: true, data: {} };
      throw new Error(`unexpected ${name}`);
    };

    const out = await forgetFixtureData(rpc, "main", { label: "w-fixture", root: `${FIELD}/x` });
    expect(out).toEqual({ key: true, recent: true });
    expect(calls.filter((c) => c.name === "data.kv.deleteMany")).toHaveLength(1);
    expect(calls.find((c) => c.name === "data.kv.deleteMany").params.keys).toEqual([
      "window/w-fixture",
      "window/w-fixture#prev",
    ]);
    expect(calls.some((c) => c.name === "data.kv.delete")).toBe(false);
  });
});
