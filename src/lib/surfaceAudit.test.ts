// 표면 감사 판정의 계약 — 관측은 기계적이어야 하므로 판정은 순수 함수로 고정한다.
// RED 근거(2026-07-27 실측): 콜드 부팅에서 엔진 서피스들이 오른쪽 열로 몰려 native 브라우저
// 위에 겹쳤는데(오배치 1 + 겹침 1), 카운트 기준 관측은 그것을 정상이라 판정했다.
import { describe, expect, it } from "vitest";
import { judgeSurfaces } from "./surfaceAudit";

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
});
