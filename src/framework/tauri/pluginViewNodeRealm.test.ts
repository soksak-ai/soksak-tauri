// @vitest-environment jsdom
// 투영된 노드는 **자기가 사는 realm** 을 밝힌다.
//
// 자식 renderer 가 자기 노드의 자리를 부모에게 보고할 때, 여태 실어 보낸 이름은 그 뷰의
// **콘텐츠 표면**(`b-<창>-<탭>`)이었다. 노드는 거기 살지 않는다 — renderer 문서(`pv-<창>-N`)에
// 산다. 그래서 투영 주소가 가리키는 realm 은 그 노드가 없는 realm 이었다.
//
// 실측 2026-08-08: 브라우저 주소줄에 값을 넣으려고 주소가 지목한 realm 에 물었더니 그 문서엔
// `[data-node]` 가 하나도 없었고(`about:blank`), 진짜 노드는 `pv-…` 에 있었다. 관측면은
// 그럭저럭 돌았지만(좌표는 부모가 붙인다) 조작은 갈 곳을 못 찾았다.
//
// 주인을 아는 쪽이 이름을 댄다. 그러면 주소 하나로 관측도 조작도 같은 realm 에 닿는다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectPluginViewNode } from "./pluginViewPresentation";
import type { PluginViewNodeFrame } from "./pluginViewProtocol";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

const frame = (over: Partial<PluginViewNodeFrame> = {}): PluginViewNodeFrame => ({
  label: "b-w-1-tab-1",
  realm: "pv-w-1-2",
  focused: false,
  realmFocused: false,
  node: "urlbar",
  control: { kind: "input", value: "about:blank" },
  x: 4, y: 8, w: 300, h: 24, rootW: 800, rootH: 600,
  revision: 1, reportedAtUnixMs: 0,
  ...over,
});

describe("노드 프레임은 자기 realm 을 싣는다", () => {
  it("계약에 realm 이 있다", () => {
    expect(read("./pluginViewProtocol.ts")).toMatch(/realm:\s*string/);
  });

  it("보내는 쪽은 콘텐츠 표면이 아니라 자기 renderer 를 댄다", () => {
    const renderer = read("./pluginViewRenderer.ts");
    expect(renderer).toContain("realm: renderer");
  });
});

describe("투영 주소는 그 realm 을 가리킨다", () => {
  it("주소가 노드가 사는 realm 으로 지어진다", () => {
    const container = document.createElement("div");
    const el = projectPluginViewNode(container, frame());
    expect(el.dataset.node).toBe("tauri/plugin-view/pv-w-1-2/urlbar");
  });

  // 콘텐츠 표면 이름으로 지으면 조작이 노드가 없는 realm 으로 간다.
  it("콘텐츠 표면 이름으로 짓지 않는다", () => {
    const container = document.createElement("div");
    const el = projectPluginViewNode(container, frame());
    expect(el.dataset.node).not.toContain("b-w-1-tab-1");
  });
});
