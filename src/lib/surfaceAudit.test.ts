// 표면 감사 판정의 계약 — 관측은 기계적이어야 하므로 판정은 순수 함수로 고정한다.
// RED 근거(2026-07-27 실측): 콜드 부팅에서 엔진 서피스들이 오른쪽 열로 몰려 native 브라우저
// 위에 겹쳤는데(오배치 1 + 겹침 1), 카운트 기준 관측은 그것을 정상이라 판정했다.
import { describe, expect, it } from "vitest";
import {
  judgeSurfaces,
  normalizeNativeSurfaces,
  visibleAnchorFacts,
  visibleAnchorRects,
} from "../framework/tauri/surfaceAudit";

const R = (x: number, y: number, w = 554, h = 341) => ({ x, y, w, h });

describe("judgeSurfaces — 서피스↔홀 정합", () => {
  it("자기 홀에 맞는 서피스는 깨끗하다(허용 오차 안)", () => {
    const v = judgeSurfaces([R(906, 100), R(906, 500)], [R(907, 101), R(906, 500)]);
    expect(v.misplaced).toEqual([]);
    expect(v.stacked).toEqual([]);
  });

  it("반올림 범위를 넘는 3px 어긋남은 정합으로 숨기지 않는다", () => {
    const v = judgeSurfaces([R(906, 100)], [R(909, 100)]);
    expect(v.misplaced).toHaveLength(1);
    expect(v.missing).toHaveLength(1);
  });

  it("어느 홀과도 안 맞는 가시 서피스는 오배치다 — 실사고의 우상단 겹침", () => {
    const v = judgeSurfaces([R(906, 100)], [R(160, 100)]);
    expect(v.misplaced).toHaveLength(1);
  });

  it("한 홀을 둘이 차지하면 겹침이다 — 실사고의 우하단 2겹", () => {
    const v = judgeSurfaces([R(906, 100), R(908, 102)], [R(906, 100)]);
    expect(v.stacked).toHaveLength(1);
    expect(v.stacked[0]).toHaveLength(2);
  });

  it("홀이 없는데 서피스가 보이면 전부 오배치다(빈 창 위 브라우저)", () => {
    const v = judgeSurfaces([R(906, 100)], []);
    expect(v.misplaced).toHaveLength(1);
  });

  it("보이는 홀에 맞는 가시 서피스가 없으면 missing 이다 — '안뜸'의 판정 축", () => {
    // 실사고(2026-07-27): 활성 구글 페인이 검게 비어 있었는데 misplaced 축만 보던
    // 감사는 침묵했다 — "보여야 하는데 안 보임"도 위반이다.
    const v = judgeSurfaces([], [R(906, 100)]);
    expect(v.missing).toHaveLength(1);
    const ok = judgeSurfaces([R(906, 100)], [R(906, 100)]);
    expect(ok.missing).toEqual([]);
  });
});

describe("visibleAnchorRects — Tauri가 공개 content-view 슬롯에서 투영한 rect가 정본이다", () => {
  const div = (cls: string, rect: { x: number; y: number; w: number; h: number }) => {
    const el = document.createElement("div");
    el.className = cls;
    el.getBoundingClientRect = () =>
      ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }) as DOMRect;
    document.body.appendChild(el);
    return el;
  };

  it("표식 없는 일반 tab-body는 Tauri 합성 앵커가 아니다", () => {
    document.body.innerHTML = "";
    div("tab-body", { x: 906, y: 101, w: 554, h: 389 });
    expect(visibleAnchorRects().rects).toEqual([]);
  });

  it("Tauri content 표식의 rect와 같은 표면은 정합이다", () => {
    document.body.innerHTML = "";
    const slot = div("tab-body", { x: 906, y: 149, w: 554, h: 341 });
    slot.dataset.tauriHole = "content";
    const anchors = visibleAnchorRects();
    expect(anchors.source).toBe("content-view-slot");
    const v = judgeSurfaces([{ x: 906, y: 149, w: 554, h: 341 }], anchors.rects);
    expect(v.misplaced).toEqual([]);
    expect(v.stacked).toEqual([]);
  });

  it("공개 앵커 상태는 콘텐츠 label과 view identity를 rect와 함께 싣는다", () => {
    document.body.innerHTML = "";
    const body = div("tab-body", { x: 20, y: 30, w: 400, h: 300 });
    body.dataset.tauriHole = "content";
    body.dataset.node = "layout/tab/tab-7";
    body.dataset.projectId = "pjt-2";
    const slot = document.createElement("div");
    slot.dataset.contentViewBody = "b-window-tab-7";
    body.appendChild(slot);
    expect(visibleAnchorFacts()).toEqual([
      {
        label: "b-window-tab-7",
        viewId: "tab-7",
        projectId: "pjt-2",
        rect: { x: 20, y: 30, w: 400, h: 300 },
      },
    ]);
  });

  it("플러그인 shadow 내부 클래스는 앵커로 추측하지 않는다", () => {
    document.body.innerHTML = "";
    const hostEl = document.createElement("div");
    hostEl.className = "tab-viewer";
    document.body.appendChild(hostEl);
    const sr = hostEl.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    inner.className = "bv-area";
    inner.getBoundingClientRect = () =>
      ({ x: 160, y: 149, width: 554, height: 341 }) as DOMRect;
    sr.appendChild(inner);
    const anchors = visibleAnchorRects();
    expect(anchors.source).toBe("content-view-slot");
    expect(anchors.rects).toHaveLength(0);
  });

  it("hidden 조상 아래에서 자식이 visible을 선언해도 합성 앵커가 아니다", () => {
    document.body.innerHTML = "";
    const project = document.createElement("div");
    project.dataset.projectPlane = "p-inactive";
    project.style.visibility = "hidden";
    const slot = div("tab-body", { x: 906, y: 149, w: 554, h: 341 });
    slot.dataset.tauriHole = "content";
    slot.style.visibility = "visible";
    project.appendChild(slot);
    document.body.appendChild(project);
    expect(visibleAnchorRects().rects).toEqual([]);
  });
});

describe("native frame 좌표 공개", () => {
  it("AppKit bottom-left 원본과 DOM top-left 변환을 둘 다 보존한다", () => {
    expect(
      normalizeNativeSurfaces(
        {
          surfaces: [
            {
              ptr: 7,
              label: "b-7",
              hidden: false,
              effectivelyHidden: false,
              frame: { x: 10, y: 50, w: 300, h: 200 },
            },
          ],
        },
        800,
      ),
    ).toEqual([
      {
        ptr: 7,
        label: "b-7",
        hidden: false,
        effectivelyHidden: false,
        nativeFrame: { x: 10, y: 50, w: 300, h: 200 },
        domFrame: { x: 10, y: 550, w: 300, h: 200 },
      },
    ]);
  });

  it("창 줌으로 확대된 AppKit frame을 DOM CSS px로 역변환한다", () => {
    expect(
      normalizeNativeSurfaces(
        {
          surfaces: [
            {
              ptr: 8,
              label: "b-8",
              hidden: false,
              effectivelyHidden: false,
              frame: { x: 125, y: 375, w: 500, h: 375 },
            },
          ],
        },
        800,
        1.25,
      )[0].domFrame,
    ).toEqual({ x: 100, y: 200, w: 400, h: 300 });
  });
});

// 포함 판정 — 집행(코어가 가림)의 조건. 슬롯 밖으로 나간 픽셀은 이웃 칸을 덮는다.
import { containedIn } from "../framework/tauri/surfaceAudit";
import { describe as dC, it as iC, expect as eC } from "vitest";

dC("containedIn — 표면은 자기 슬롯 안에 있어야 한다", () => {
  const slot = { x: 100, y: 100, w: 400, h: 300 };
  iC("정확히 겹치면 담긴다", () => {
    eC(containedIn({ x: 100, y: 100, w: 400, h: 300 }, [slot])).toBe(true);
  });
  iC("반올림 오차(±2px)는 흡수한다", () => {
    eC(containedIn({ x: 99, y: 101, w: 401, h: 299 }, [slot])).toBe(true);
  });
  iC("한 변이라도 넘으면 침범이다 — 실사고의 좌 129px", () => {
    eC(containedIn({ x: -29, y: 100, w: 529, h: 300 }, [slot])).toBe(false);
    eC(containedIn({ x: 100, y: 100, w: 400, h: 480 }, [slot])).toBe(false);
  });
  iC("앵커가 없으면 어떤 표면도 담기지 않는다(빈 창 위 표면)", () => {
    eC(containedIn({ x: 0, y: 0, w: 10, h: 10 }, [])).toBe(false);
  });
});
