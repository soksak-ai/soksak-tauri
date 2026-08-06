import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isViewSurfaceVisible } from "./GroupArea";

describe("content view effective visibility", () => {
  it("content presentation host에 workspace의 논리 pane identity를 명시 전달한다", () => {
    const source = readFileSync(resolve(import.meta.dirname, "GroupArea.tsx"), "utf8");
    expect(source).toContain("logicalPaneId={group.id}");
  });

  it("프로젝트/스페이스 표면이 parked면 내부 활성 탭도 보이지 않는다", () => {
    expect(isViewSurfaceVisible(false, null, "v1", "v1")).toBe(false);
  });

  it("활성 표면에서는 pane의 활성 탭만 보인다", () => {
    expect(isViewSurfaceVisible(true, null, "v1", "v1")).toBe(true);
    expect(isViewSurfaceVisible(true, null, "v2", "v1")).toBe(false);
  });

  it("최대화 중에는 그 view 하나만 보인다", () => {
    expect(isViewSurfaceVisible(true, "v2", "v2", "v1")).toBe(true);
    expect(isViewSurfaceVisible(true, "v2", "v1", "v1")).toBe(false);
  });
});
