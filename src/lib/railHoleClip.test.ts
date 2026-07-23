// 레일-홀 클립 순수부 — 모션 중 레일 평면이 홀(네이티브 임베드) 영역을 칠하지 않는 계약.
import { describe, expect, it } from "vitest";
import { holeClipPath, visibleHoles } from "./railHoleClip";

describe("holeClipPath", () => {
  it("홀이 없으면 클립도 없다(빈 문자열 = 스타일 해제)", () => {
    expect(holeClipPath({ w: 800, h: 600 }, [])).toBe("");
  });

  it("외곽 + 홀 서브패스를 evenodd 로 합성한다", () => {
    const clip = holeClipPath({ w: 800, h: 600 }, [
      { x: 100, y: 50, w: 200, h: 150 },
    ]);
    expect(clip).toBe(
      'path(evenodd, "M0 0H800V600H0ZM100 50h200v150h-200Z")',
    );
  });

  it("홀 여러 개가 각자 서브패스로 들어간다", () => {
    const clip = holeClipPath({ w: 100, h: 100 }, [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 50, y: 50, w: 20, h: 20 },
    ]);
    expect(clip).toContain("M0 0h10v10h-10Z");
    expect(clip).toContain("M50 50h20v20h-20Z");
  });

  it("소수 좌표는 1/100px 로 반올림한다(경로 문자열 폭주 방지)", () => {
    const clip = holeClipPath({ w: 100.333333, h: 100 }, [
      { x: 10.126, y: 0, w: 5.001, h: 5 },
    ]);
    expect(clip).toContain("H100.33V100");
    expect(clip).toContain("M10.13 0h5v5h-5Z");
  });
});

describe("visibleHoles", () => {
  const host = { left: 100, top: 50, width: 800, height: 600 };

  it("호스트 상대 좌표로 옮긴다", () => {
    expect(
      visibleHoles(host, [{ left: 300, top: 150, width: 200, height: 100 }]),
    ).toEqual([{ x: 200, y: 100, w: 200, h: 100 }]);
  });

  it("호스트 밖·0 크기(파킹된 콘텐츠)는 버린다", () => {
    expect(
      visibleHoles(host, [
        { left: -5000, top: 150, width: 200, height: 100 },
        { left: 300, top: 150, width: 0, height: 100 },
      ]),
    ).toEqual([]);
  });

  it("걸친 홀은 호스트와의 교집합으로 자른다", () => {
    expect(
      visibleHoles(host, [{ left: 0, top: 0, width: 300, height: 100 }]),
    ).toEqual([{ x: 0, y: 0, w: 200, h: 50 }]);
  });
});
