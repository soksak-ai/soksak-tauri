// OS 알림 — 플랫폼 자원이고 프레임워크가 창구를 준다.
//
// 이름은 앱의 것이다(`notify_show`). 갈래 접두사(window_·webview_ …)를 달 수 없으므로 발견은
// **등재**로 한다(index.cjs 의 `cmd in TABLE`) — capture·project 와 같은 자리다.
//
// 알림은 창을 앞으로 내지 않는다. 사용자가 보던 화면을 알림 하나가 바꾸면 그것은 알림이 아니라
// 방해다 — 띄우기와 활성화는 별개 사건이다.
//
// 지원 여부를 먼저 묻는다. 지원하지 않는 플랫폼에서 조용히 성공하면 부른 쪽은 알림이 떴다고
// 믿고 그 위에 흐름을 세운다 — 없는 것은 이름을 달고 거절한다. 그것이 이 자리가 아는 유일한
// **사실**이다.
//
// 무엇이 유효한 알림인가는 여기서 판정하지 않는다. 그것은 규칙이고, 규칙이 프레임워크에 살면
// 두 껍데기가 같은 이름에 다른 기준을 갖는다(Tauri 쪽도 검사하지 않는다).
//
// ## 한 사건에 한 길
//
// 알림 활성화가 하는 일은 하나다 — **알림이 실어 온 것을 명령 표면의 주인에게 돌려준다.**
// 그 자리에 이름이 없으면 사람 손가락 말고는 부를 길이 없고, 부를 수 없는 사건은 동작한다고
// 말할 수 없다. 그래서 활성화를 `activate` 한 함수로 두고 **OS 클릭과 `notify_activate` 가
// 같은 함수를 부른다.** 사본을 두면 명령이 통과해도 클릭은 죽어 있을 수 있다 — 그때 검증은
// 아무것도 증명하지 않는다.
//
// 이것은 뒷문이 아니다. 새 문을 내는 것이 아니라 **이미 있는 문에 주소를 붙이는 것**이다
// (`ui.input.click` 이 사람 클릭과 같은 경로를 부르는 것과 같다).

const { Notification } = require("electron");

const { frameworkError } = require("./error.cjs");

const UNSUPPORTED = "FRAMEWORK_NOTIFICATION_UNSUPPORTED";
const UNKNOWN_HANDLE = "FRAMEWORK_NOTIFICATION_UNKNOWN";

/** 살아 있는 알림의 활성화 함수 — handle → activate. 주소가 있어야 밖에서 부를 수 있다. */
const LIVE = new Map();
let nextHandle = 1;

module.exports = {
  // 지원 여부는 **물어서 아는 사실**이다. 권한 절차가 없는 플랫폼에서 "권한 있음"을 지어내면
  // 부른 쪽이 없는 절차 위에 흐름을 세운다 — 아는 것 하나(띄울 수 있는가)를 그대로 답한다.
  notify_supported: {
    concept: "OS 알림 지원 여부",
    answer: () => Notification.isSupported(),
  },

  notify_show: {
    concept: "OS 알림 띄우기",
    answer: (ctx, args) => {
      if (!Notification.isSupported()) {
        throw frameworkError(
          UNSUPPORTED,
          "이 플랫폼은 알림을 지원하지 않는다 — 조용한 성공은 부른 쪽에 거짓을 남긴다",
        );
      }
      // 인자는 그대로 간다 — 여기서 채우거나 고르면 그것이 규칙이 된다.
      const n = new Notification({ title: args.title, body: args.body });
      // 활성화가 하는 일 — **이 한 자리에만 적는다.** 실어 온 것을 그대로 주인에게 넘기고,
      // 그것이 명령 URI 인지는 코어가 답한다(아니면 `ran:false`). 여기서 고르면 그 규칙이
      // 프레임워크마다 한 벌이 된다.
      const activate = () => ctx.deepLink(args.extra?.deepLink);
      const handle = nextHandle++;
      LIVE.set(handle, activate);
      n.on("click", activate);
      // 알림이 닫히면 그 주소는 죽는다 — 남겨 두면 없는 알림을 활성화했다고 답하게 된다.
      n.on("close", () => LIVE.delete(handle));
      n.show();
      return { handle };
    },
  },

  // 사람 손가락과 **같은 문**이다. 다른 길을 내면 이 명령이 통과해도 클릭은 죽어 있을 수 있다.
  notify_activate: {
    concept: "OS 알림 활성화(클릭과 같은 길)",
    answer: (_ctx, args) => {
      const activate = LIVE.get(args.handle);
      if (!activate) {
        // 없는 것을 조용히 성공으로 답하면, 부른 쪽은 알림이 반응했다고 믿는다.
        throw frameworkError(
          UNKNOWN_HANDLE,
          `살아 있는 알림이 아니다: handle=${args.handle}`,
        );
      }
      activate();
      return null;
    },
  },
};
