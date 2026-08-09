// **안 보이는 뷰를 다시 재게 하지 않는다.**
//
// 정착 배리어가 마운트된 뷰 전부를 훑는다. 뷰마다 자기 자리를 확정하고 자식에게 "다시 재라" 고
// 보낸 뒤 답을 기다리는데, 그 왕복 하나가 100ms 대다. 그래서 비용이 탭 수에 비례한다 —
// 실측 2026-08-09: 3개 51ms · 11개 94ms · 21개 143ms · 31개 208ms · 41개 265ms(탭당 약 5.6ms).
// 50개면 300ms 를 넘는다.
//
// 화면에 없는 뷰는 다시 잴 자리가 없다. 그 왕복은 답을 기다리는 시간이 전부 낭비다.
//
// 무엇이 보이는가는 **그 뷰 자신의 선언**으로 읽는다. 호스트 문서로 가르면 자식 realm 이 선언한
// 표면이 전부 유령으로 읽혀 배리어가 통째로 사라진다(실사고 2026-08-09: 표면이 창 밖으로
// 흩어졌다). 같은 실수를 두 번 하지 않는다.
import { describe, expect, it } from "vitest";
import { settlingViews } from "./settleScope";

const view = (id: string, over: { grouped?: boolean; disposed?: boolean; visible?: boolean } = {}) =>
  ({ id, grouped: true, disposed: false, visible: true, ...over });

describe("정착 배리어의 범위", () => {
  it("보이는 뷰만 훑는다", () => {
    expect(settlingViews([view("a"), view("b", { visible: false })]).map((v) => v.id)).toEqual(["a"]);
  });

  it("아직 묶이지 않은 뷰는 훑지 않는다 — 잴 자리가 아직 없다", () => {
    expect(settlingViews([view("a", { grouped: false })])).toEqual([]);
  });

  it("버려진 뷰는 훑지 않는다 — 죽은 realm 으로 보낸 물음은 답이 없다", () => {
    expect(settlingViews([view("a", { disposed: true })])).toEqual([]);
  });

  // 보이는 것이 없으면 기다릴 것도 없다.
  it("전부 숨었으면 빈 목록이다", () => {
    expect(settlingViews([view("a", { visible: false }), view("b", { visible: false })])).toEqual([]);
  });
});
