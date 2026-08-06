// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  browserTabNodeAddress,
  browserTabActivationAddress,
} from "./browser-ui-addresses.mjs";

const tree = {
  nodes: [
    {
      address: "win/w/content/view/browser/tab/tab-left/node/adapter/plugin-view/surface-left/surface",
      nodePath: "adapter/plugin-view/surface-left/surface",
    },
    {
      address: "win/w/content/view/browser/tab/tab-left/node/adapter/plugin-view/surface-left/toolbar",
      nodePath: "adapter/plugin-view/surface-left/toolbar",
    },
    {
      address: "win/w/content/view/browser/tab/tab-right/node/adapter/plugin-view/surface-right/surface",
      nodePath: "adapter/plugin-view/surface-right/surface",
    },
    {
      address: "win/w/proj/project/chrome/tab/view/tab-left",
      nodePath: "tab/view/tab-left",
    },
  ],
};

describe("browser public UI address resolution", () => {
  it("resolves a tab-owned node by tab identity and terminal public role", () => {
    expect(browserTabNodeAddress(tree, "tab-left", "surface")).toBe(
      "win/w/content/view/browser/tab/tab-left/node/adapter/plugin-view/surface-left/surface",
    );
    expect(browserTabNodeAddress(tree, "tab-left", "toolbar")).toBe(
      "win/w/content/view/browser/tab/tab-left/node/adapter/plugin-view/surface-left/toolbar",
    );
  });

  it("does not bind another tab or a role-like prefix", () => {
    expect(() => browserTabNodeAddress(tree, "tab-missing", "surface")).toThrow(/tab-missing/);
    expect(() => browserTabNodeAddress({ nodes: [{
      address: "win/w/content/tab/tab-left/node/surface-shadow",
      nodePath: "surface-shadow",
    }] }, "tab-left", "surface")).toThrow(/surface/);
  });

  it("resolves the chrome activation node by exact public nodePath", () => {
    expect(browserTabActivationAddress(tree, "tab-left")).toBe(
      "win/w/proj/project/chrome/tab/view/tab-left",
    );
  });
});
