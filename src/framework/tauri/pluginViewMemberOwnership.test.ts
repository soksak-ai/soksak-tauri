import { describe, expect, it } from "vitest";
import { PluginViewMemberOwnership } from "./pluginViewMemberOwnership";

describe("plugin native member 세대 소유권", () => {
  it("새 renderer가 label을 인수하면 이전 cleanup은 닫을 수 없다", () => {
    const owners = new PluginViewMemberOwnership();
    owners.claim("b-tab-1", "pv-old");
    owners.claim("b-tab-1", "pv-new");
    expect(owners.release("b-tab-1", "pv-old")).toBe(false);
    expect(owners.release("b-tab-1", "pv-new")).toBe(true);
  });
});
