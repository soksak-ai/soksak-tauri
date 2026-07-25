// 네이티브 표면 rect 규칙 — 홀 슬롯의 분수 rect 를 표면이 실제로 설 수 있는 정수 rect 로 접는다.
//
// 표면(자식 웹뷰·사이드카)은 창 좌표의 정수 픽셀에만 선다. 슬롯은 flex/분수 폭이라 거의 항상
// 분수다(실측 340 / 632.2 / 866.42 / 416.78). 그래서 "슬롯 자리"와 "표면 자리"는 원래 다르고,
// 그 차이를 각자 접으면 계층마다 다른 자리에 선다 — 표면은 여기, 스탠드인은 저기, 캡처는 또 다른
// 자리. 실측 결과 스탠드인이 표면보다 0.8px 위에서 1.78px 늘어나 하단 콘텐츠가 2.6px 밀렸다.
//
// 규칙은 하나다: 안쪽으로 접는다(ceil-left / floor-right). 슬롯 밖을 침범하지 않는 유일한 방향이고,
// 표면 소유자(browser-view 의 bounds 계산)가 이미 쓰는 규칙이다. 캡처·스탠드인·표면이 이 함수
// 하나를 공유해야 셋이 같은 자리에 선다.
export interface SurfaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function surfaceRectOf(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): SurfaceRect {
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return { x, y, w: Math.floor(r.right) - x, h: Math.floor(r.bottom) - y };
}
