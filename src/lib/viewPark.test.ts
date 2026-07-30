// 뷰 유효 가시성의 단일 진실 — 세 층(프로젝트·스페이스·탭)이 모두 참일 때만 보인다.
// RED 의 근거: 프로젝트 층이 빠져 있어, 비활성 프로젝트의 뷰가 "보인다"고 코어에 보고됐고
// 그 프로젝트의 네이티브 브라우저 webview 가 전환 후에도 화면에 남았다(실측 스냅샷).
import { describe, expect, it, vi } from "vitest";
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

describe("파킹 커밋은 콘텐츠 뷰 호스트를 거친다", () => {
  // 여기서 `invoke("webview_visible")` 를 직접 부르면, 콘텐츠가 DOM 안에 사는 프레임워크에서는
  // 그 이름이 **위임**으로 거절된다(FRAMEWORK_DELEGATED). 그리고 그 거절을 `.catch(()=>{})` 가
  // 삼켜 파킹이 아예 일어나지 않는다 — 탭을 바꿔도 이전 뷰가 그대로 떠 있고, 새 뷰는 안 보인다.
  //
  // 실측(2026-07-30): 요구 원장에 그 거절이 301건 쌓여 있었고, 화면에서는 "탭을 눌러도 브라우저가
  // 복원되지 않는다"로 나타났다. 앱이 콘텐츠를 어떻게 보여주는지는 contentViews 가 단일 소유자다.
  it("DOM 호스트일 때 파킹이 실제로 DOM 에 닿는다", async () => {
    vi.resetModules();
    const seen: [string, boolean][] = [];
    vi.doMock("./contentViews", () => ({
      contentViewHost: () => ({
        visible: async (label: string, visible: boolean) => {
          seen.push([label, visible]);
        },
      }),
    }));
    vi.doMock("../plugins/hooks", () => ({ emitPluginEvent: () => {} }));
    const { commitViewVisibility, dropViewVisibility } = await import("./viewPark");

    dropViewVisibility("v-1");
    commitViewVisibility("v-1", false);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(false);

    // 멱등 — 같은 값 재커밋은 아무 일도 안 한다.
    commitViewVisibility("v-1", false);
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    commitViewVisibility("v-1", true);
    await Promise.resolve();
    expect(seen[1][1]).toBe(true);
  });
});
