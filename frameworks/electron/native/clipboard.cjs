// OS 클립보드 — 플랫폼 자원이고 프레임워크가 창구를 준다.
//
// 이름은 앱의 것이다(`clipboard_*`). 갈래 접두사를 달 수 없으므로 발견은 **등재**로 한다
// (index.cjs 의 `cmd in TABLE`) — capture·project·notify 와 같은 자리다.
//
// 읽기·쓰기는 이 프레임워크가 그대로 답한다. **감시는 답하지 않는다**: 이 프레임워크에는
// 클립보드 변경 사건이 없다. 없는 사건을 폴링으로 흉내 내면 그것은 감시가 아니라 주기 질의이고,
// 이 저장소는 폴링을 메인 메커니즘으로 두지 않는다 — 정공법(사건)이 없을 때의 최후 수단이다.
// 조용히 성공시키면 UI 는 감시가 선 줄 알고 변화를 기다리다 영영 안 오는 것을 기다린다.

const { clipboard } = require("electron");

module.exports = {
  clipboard_read: {
    concept: "클립보드 텍스트 읽기",
    // 비텍스트(이미지·파일)면 빈 문자열 — 부른 쪽은 텍스트만 다룬다(Tauri 쪽과 같은 답).
    answer: () => clipboard.readText(),
  },

  clipboard_write: {
    concept: "클립보드 텍스트 쓰기",
    answer: (_ctx, args) => {
      // 인자는 그대로 간다 — 여기서 채우거나 고르면 그것이 규칙이 된다.
      clipboard.writeText(args.text);
      return null;
    },
  },

  clipboard_watch_start: {
    concept: "클립보드 변경 감시",
    absent:
      "이 프레임워크는 클립보드 변경 사건을 주지 않는다 — 폴링으로 흉내 내면 그것은 감시가 아니라 주기 질의이고, 조용히 성공시키면 UI 가 오지 않을 변화를 기다린다.",
  },

  clipboard_watch_stop: {
    concept: "클립보드 감시 중단",
    absent:
      "설 감시가 없으니 멈출 것도 없다. 성공을 돌려주면 '감시가 있었다'는 거짓이 남는다.",
  },
};
