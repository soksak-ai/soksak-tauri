import { describe, expect, it } from "vitest";
import { railGeometryScopeId } from "./railMotion";

describe("평면 identity", () => {
  it("서로 다른 space 의 레일 선은 같은 좌표계가 아니다", () => {
    expect(railGeometryScopeId("c38", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c39", [0, 50, 100]),
    );
  });

  it("같은 space 도 split/merge 로 깨끗한 선 집합이 바뀌면 새 좌표계다", () => {
    expect(railGeometryScopeId("c1", [0, 50, 100])).not.toBe(
      railGeometryScopeId("c1", [0, 100 / 3, 200 / 3, 100]),
    );
  });
});
