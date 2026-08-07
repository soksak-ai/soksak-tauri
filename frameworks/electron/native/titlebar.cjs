// titlebar_* — 창 크롬. 신호등·오버레이는 창의 것이라 이 갈래도 프레임워크가 답한다.
//
// 부재 사유는 여기서 짓지 않는다. 이 프레임워크가 신호등 합성에 대해 무엇을 답할 수 있는지는
// 한 자리에 산다(../titlebar-provision.json) — 렌더러의 계약 선언도 같은 문장을 읽는다.
// 두 자리가 각자 문장을 들면 한쪽만 고쳐지고, 그 어긋남은 "선언은 없다는데 표는 다른 말을
// 한다"로만 나타난다.

const provision = require("../titlebar-provision.json");

module.exports = {
  // 신호등 뒤 백킹(macOS): 비활성 점의 backdrop 합성이 웹뷰 레이어를 못 샘플링해 생기는 유령을
  // 테마색 원형 뷰로 메우는 보정. 이 프레임워크에는 그 자리가 없다 — 사유는 선언이 든다.
  titlebar_backing: {
    concept: "신호등 뒤 백킹 색",
    absent: provision.backingPlane.reason,
  },
};
