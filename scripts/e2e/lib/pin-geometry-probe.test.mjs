// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findRelationNode, readPinStage } from "./pin-geometry-probe.mjs";

const relationNode = (dataset) => ({
  address: "win/w/relation/rail/space-1",
  nodePath: "relation/rail/space-1",
  nodeIdentity: "dom-node:relation:1",
  dataset,
});

function fakeRpc(nodes, { paneList = { railRelation: { side: "left" } } } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (command, params) => {
      calls.push({ command, params });
      if (command === "ui.tree") return { ok: true, data: { nodes } };
      if (command === "pane.list") return { ok: true, data: paneList };
      return { ok: false, code: "UNKNOWN_COMMAND" };
    },
  };
}

describe("pin geometry probe", () => {
  it("공개 트리에서 결부 노드를 집고 rect까지 한 트리로 읽는다", async () => {
    const nodes = [
      { address: "win/w/rail/plane", nodePath: "rail/plane", dataset: {} },
      relationNode({ side: "left", rail: "500,0,20,700", box: "0,0,500,700" }),
    ];
    const { rpc, calls } = fakeRpc(nodes);
    const stage = await readPinStage(rpc, "w", "baseline", (tree) => {
      expect(tree.nodes).toHaveLength(2);
      return { x: 0, y: 0, w: 500, h: 700 };
    });
    expect(stage.relationMeasure.dataset.rail).toBe("500,0,20,700");
    expect(stage.surfaceRect).toEqual({ x: 0, y: 0, w: 500, h: 700 });
    expect(stage.paneList.railRelation.side).toBe("left");
    expect(calls.map(({ command }) => command)).toEqual(["ui.tree", "pane.list"]);
    expect(calls[0].params).toEqual({ rects: true });
  });

  // 잴 자리가 없는 것과 계약을 어긴 것은 다른 사실이다.
  it("결부 노드 주소가 없으면 던지고, 상자를 안 실은 노드는 값으로 흘린다", async () => {
    const missing = fakeRpc([{ address: "win/w/rail/plane", nodePath: "rail/plane", dataset: {} }]);
    await expect(readPinStage(missing.rpc, "w", "baseline", () => null))
      .rejects.toThrow(/결부 공개 노드 주소가 없다/);

    const drawnNothing = fakeRpc([relationNode({ side: "left" })]);
    const stage = await readPinStage(drawnNothing.rpc, "w", "baseline", () => null);
    expect(stage.relationMeasure.dataset.rail).toBeUndefined();
  });

  it("명령이 거절하면 던진다 — 조용히 빈 값으로 넘어가지 않는다", async () => {
    const rpc = async () => ({ ok: false, code: "WINDOW_NOT_FOUND" });
    await expect(readPinStage(rpc, "w", "baseline", () => null)).rejects.toThrow(/ui\.tree/);
  });

  it("findRelationNode는 결부가 없으면 null이다", () => {
    expect(findRelationNode({ nodes: [{ nodePath: "rail/plane" }] })).toBeNull();
    expect(findRelationNode(null)).toBeNull();
  });
});
