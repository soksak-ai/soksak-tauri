// titlebar_* — 창 크롬. 신호등·오버레이는 창의 것이라 이 갈래도 프레임워크가 답한다.

module.exports = {
  // 신호등 뒤 백킹(macOS): 비활성 점의 backdrop 합성이 웹뷰 레이어를 못 샘플링해 생기는 유령을
  // 테마색 원형 뷰로 메우는 보정. Electron 의 신호등 API 는 위치·가시성뿐(trafficLightPosition·
  // setWindowButtonPosition·setWindowButtonVisibility) — 뒤에 무엇을 깔 자리가 없다.
  // setBackgroundColor 는 이것의 대응이 아니다: 그쪽은 창 배경(window_set_background)이고 색도
  // 다르다(bg vs side). 한 표면에 둘을 쓰면 나중 호출이 창 전체를 타이틀바 색으로 칠한다.
  titlebar_backing: {
    concept: "신호등 뒤 백킹 색",
    absent:
      "Electron 의 신호등 API 는 위치·가시성뿐이라 버튼 뒤에 뷰를 깔 자리가 없다. setBackgroundColor 는 창 배경(window_set_background)의 대응이며 색이 다르다(bg vs side) — 겸용하면 창 전체가 타이틀바 색이 된다. setTitleBarOverlay 는 win32/linux 전용이고 Window Controls Overlay 창을 요구한다.",
  },
};
