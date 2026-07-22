// 뷰 유효 가시성의 단일 진실 — 세 층(프로젝트·스페이스·탭)이 모두 참일 때만 보인다.
// RED 의 근거: 프로젝트 층이 빠져 있어, 비활성 프로젝트의 뷰가 "보인다"고 코어에 보고됐고
// 그 프로젝트의 네이티브 브라우저 webview 가 전환 후에도 화면에 남았다(실측 스냅샷).
import { describe, expect, it } from "vitest";
import { surfaceShown, viewSurfaceStyle } from "./viewPark";

describe("뷰 유효 가시성 — 세 층 모두", () => {
  it("프로젝트가 비활성이면 스페이스·탭이 활성이어도 보이지 않는다", () => {
    expect(surfaceShown(false, true, true)).toBe(false);
  });

  it("스페이스가 비활성이면 보이지 않는다", () => {
    expect(surfaceShown(true, false, true)).toBe(false);
  });

  it("탭이 비활성이면 보이지 않는다", () => {
    expect(surfaceShown(true, true, false)).toBe(false);
  });

  it("세 층 모두 활성일 때만 보인다", () => {
    expect(surfaceShown(true, true, true)).toBe(true);
  });
});

describe("viewSurfaceStyle — exclusive(maximize) 합성 계약", () => {
  it("일반 비활성은 세션 보존 파킹을 쓰되 display:none으로 만들지 않는다", () => {
    expect(viewSurfaceStyle(false, false).display).toBeUndefined();
    expect(viewSurfaceStyle(false, false).transform).toContain("-200vw");
  });

  it("최대화에서 제외된 슬롯은 WebGL/GPU 합성에서도 빠지도록 display:none이다", () => {
    expect(viewSurfaceStyle(false, true)).toMatchObject({
      display: "none",
      visibility: "hidden",
    });
  });

  it("최대화 대상은 평상시 활성 슬롯과 같은 표시 스타일이다", () => {
    expect(viewSurfaceStyle(true, true).display).toBeUndefined();
    expect(viewSurfaceStyle(true, true).visibility).toBe("visible");
  });
});
