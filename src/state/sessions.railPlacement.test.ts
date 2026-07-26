import { beforeEach, describe, expect, it } from "vitest";
import { splitLeaf } from "./splitTree";
import { useSessions, type Project, type Pane } from "./sessions";

function group(id: string, viewId: string): Pane {
  return {
    id,
    activeTabId: viewId,
    tabs: [
      {
        id: viewId,
        kind: "plugin",
        title: viewId,
        pluginId: "fixture",
        view: "content",
      },
    ],
  };
}

function twoColumnProject(): Project {
  useSessions.getState().bootstrapFirstProject("/test/root");
  const base = useSessions.getState().projects[0];
  const left = group("g-left", "v-left");
  const right = group("g-right", "v-right");
  return {
    ...base,
    leftRailPlacement: { mode: "pin", station: 50 },
    spaces: [
      {
        ...base.spaces[0],
        activePaneId: right.id,
        layout: {
          type: "split",
          id: "s-columns",
          dir: "row",
          sizes: [0.5, 0.5],
          children: [splitLeaf(left), splitLeaf(right)],
        },
      },
    ],
  };
}

beforeEach(() => {
  useSessions.setState({ projects: [], activeId: "" });
});

describe("position PIN guards the clean grid line", () => {
  it("rejects a horizontal resize that would move the pinned line", () => {
    const project = twoColumnProject();
    useSessions.setState({ projects: [project], activeId: project.id });
    const before = useSessions.getState().projects[0];

    const result = useSessions
      .getState()
      .resizeSplit(project.id, "s-columns", [0.6, 0.4]);

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().projects[0]).toBe(before);
  });

  it("allows a focus change without moving the persisted PIN", () => {
    const project = twoColumnProject();
    useSessions.setState({ projects: [project], activeId: project.id });

    expect(useSessions.getState().setActiveGroup(project.id, "g-left")).toEqual({
      ok: true,
    });
    expect(useSessions.getState().projects[0].leftRailPlacement).toEqual({
      mode: "pin",
      station: 50,
    });
  });

  it("rejects maximizing a panel across an internal PIN but allows an edge PIN", () => {
    const project = twoColumnProject();
    useSessions.setState({ projects: [project], activeId: project.id });

    expect(useSessions.getState().maximizeView(project.id, "v-right")).toMatchObject({
      ok: false,
      code: "LAYOUT_CONFLICT",
    });
    expect(useSessions.getState().projects[0].spaces[0].maximizedTabId).toBeUndefined();

    useSessions.getState().setLeftRailPlacement(project.id, {
      mode: "pin",
      station: 0,
    });
    expect(useSessions.getState().maximizeView(project.id, "v-right")).toEqual({
      ok: true,
      viewId: "v-right",
    });
  });

  it("rejects removing the boundary that owns the PIN", () => {
    const project = twoColumnProject();
    useSessions.setState({ projects: [project], activeId: project.id });
    const before = useSessions.getState().projects[0];

    const result = useSessions.getState().closeGroup(project.id, "g-left");

    expect(result).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });
    expect(useSessions.getState().projects[0]).toBe(before);
  });
});
