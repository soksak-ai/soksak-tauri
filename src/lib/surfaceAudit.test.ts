// 표면 감사 판정의 계약 — 관측은 기계적이어야 하므로 판정은 순수 함수로 고정한다.
// RED 근거(2026-07-27 실측): 콜드 부팅에서 엔진 서피스들이 오른쪽 열로 몰려 native 브라우저
// 위에 겹쳤는데(오배치 1 + 겹침 1), 카운트 기준 관측은 그것을 정상이라 판정했다.
import { describe, expect, it } from "vitest";
import { judgeSurfaces, visibleAnchorRects } from "./surfaceAudit";

const R = (x: number, y: number, w = 554, h = 341) => ({ x, y, w, h });

describe("judgeSurfaces — 서피스↔홀 정합", () => {
  it("자기 홀에 맞는 서피스는 깨끗하다(허용 오차 안)", () => {
    const v = judgeSurfaces([R(906, 100), R(906, 500)], [R(910, 104), R(906, 500)]);
    expect(v.misplaced).toEqual([]);
    expect(v.stacked).toEqual([]);
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

describe("visibleAnchorRects — 측정 앵커의 정본은 bv-area 다", () => {
  const div = (cls: string, rect: { x: number; y: number; w: number; h: number }) => {
    const el = document.createElement("div");
    el.className = cls;
    el.getBoundingClientRect = () =>
      ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }) as DOMRect;
    document.body.appendChild(el);
    return el;
  };

  it("RED 재현 — hole(툴바 포함)로 재면 정상 배치가 오배치로 오판된다", () => {
    // 실사고(2026-07-27): 서피스는 툴바(48px) 아래에 정확히 붙어 있었는데,
    // 앵커를 탭 전체(hole)로 재서 misplaced ×2 가 발행됐다 — 측정 앵커 오류.
    document.body.innerHTML = "";
    div("tab-body hole", { x: 906, y: 101, w: 554, h: 389 });
    const surface = { x: 906, y: 149, w: 554, h: 341 }; // 툴바 48px 아래 = 실제 정상
    const holeOnly = visibleAnchorRects();
    expect(holeOnly.source).toBe("hole");
    expect(judgeSurfaces([surface], holeOnly.rects).misplaced).toHaveLength(1); // 오판 재현
  });

  it("GREEN — bv-area 가 있으면 그것이 앵커고, 같은 서피스가 정합으로 판정된다", () => {
    document.body.innerHTML = "";
    div("tab-body hole", { x: 906, y: 101, w: 554, h: 389 });
    div("bv-area", { x: 906, y: 149, w: 554, h: 341 });
    const anchors = visibleAnchorRects();
    expect(anchors.source).toBe("bv-area");
    const v = judgeSurfaces([{ x: 906, y: 149, w: 554, h: 341 }], anchors.rects);
    expect(v.misplaced).toEqual([]);
    expect(v.stacked).toEqual([]);
  });

  it("shadow root 안의 bv-area 도 앵커로 잡힌다(플러그인 뷰는 shadow 에 그린다)", () => {
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
    expect(anchors.source).toBe("bv-area");
    expect(anchors.rects).toHaveLength(1);
  });
});
