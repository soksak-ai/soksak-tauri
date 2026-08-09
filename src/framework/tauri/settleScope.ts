// 정착 배리어가 **어느 뷰를 훑는가.**
//
// 뷰마다 자기 자리를 확정하고 자식에게 "다시 재라" 고 보낸 뒤 답을 기다린다. 그 왕복 하나가
// 100ms 대라, 마운트된 뷰 전부를 훑으면 비용이 탭 수에 비례한다 — 실측 2026-08-09: 3개 51ms ·
// 11개 94ms · 21개 143ms · 31개 208ms · 41개 265ms(탭당 약 5.6ms).
//
// 화면에 없는 뷰는 다시 잴 자리가 없다. 무엇이 보이는가는 **그 뷰 자신의 선언**으로 읽는다 —
// 호스트 문서로 가르면 자식 realm 이 선언한 표면이 전부 유령으로 읽혀 배리어가 통째로 사라진다
// (실사고 2026-08-09: 표면이 창 밖으로 흩어졌다).

/** 이 배리어가 훑을 뷰 — 묶였고, 살아 있고, 지금 보이는 것. */
export function settlingViews<T extends { grouped: boolean; disposed: boolean; visible: boolean }>(
  views: readonly T[],
): T[] {
  return views.filter((view) => view.grouped && !view.disposed && view.visible);
}
