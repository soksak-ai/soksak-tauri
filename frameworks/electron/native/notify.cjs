// OS 알림 — 플랫폼 자원이고 프레임워크가 창구를 준다.
//
// 이름은 앱의 것이다(`notify_show`). 갈래 접두사(window_·webview_ …)를 달 수 없으므로 발견은
// **등재**로 한다(index.cjs 의 `cmd in TABLE`) — capture·project 와 같은 자리다.
//
// 알림은 창을 앞으로 내지 않는다. 사용자가 보던 화면을 알림 하나가 바꾸면 그것은 알림이 아니라
// 방해다 — 클릭 반응은 별개 표면(notification.onAction)의 몫이고 여기서는 띄우기만 한다.
//
// 지원 여부를 먼저 묻는다. 지원하지 않는 플랫폼에서 조용히 성공하면 부른 쪽은 알림이 떴다고
// 믿고 그 위에 흐름을 세운다 — 없는 것은 이름을 달고 거절한다. 그것이 이 자리가 아는 유일한
// **사실**이다.
//
// 무엇이 유효한 알림인가는 여기서 판정하지 않는다. 그것은 규칙이고, 규칙이 프레임워크에 살면
// 두 껍데기가 같은 이름에 다른 기준을 갖는다(Tauri 쪽도 검사하지 않는다).

const { Notification } = require("electron");

const { frameworkError } = require("./error.cjs");

const UNSUPPORTED = "FRAMEWORK_NOTIFICATION_UNSUPPORTED";

module.exports = {
  notify_show: {
    concept: "OS 알림 띄우기",
    answer: (_ctx, args) => {
      if (!Notification.isSupported()) {
        throw frameworkError(
          UNSUPPORTED,
          "이 플랫폼은 알림을 지원하지 않는다 — 조용한 성공은 부른 쪽에 거짓을 남긴다",
        );
      }
      // 인자는 그대로 간다 — 여기서 채우거나 고르면 그것이 규칙이 된다.
      new Notification({ title: args.title, body: args.body }).show();
      return null;
    },
  },
};
