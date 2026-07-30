// 앱 본체 원격 업데이트 — 실행물을 갈아 끼우는 일이라 **프레임워크의 것**이다.
//
// 갈래 접두사를 달 수 없으므로 발견은 등재로 한다(index.cjs 의 `cmd in TABLE`) — notify·
// clipboard 와 같은 자리다.
//
// 채널 게이트가 먼저다. dev·debug 홈의 앱 본체는 로컬 빌드라 원격 조회 자체가 성립하지
// 않는다 — 그때의 `available:false` 는 "새 판이 없다"가 아니라 **"이 채널은 원격을 안 본다"**
// 이고, 두 사실을 같은 모양으로 답하면 부른 쪽이 가릴 수 없다. 그래서 channel 을 함께 싣는다.
//
// release 채널은 아직 답하지 않는다. 이 프레임워크에는 서명 검증된 번들을 받아 설치하는
// 장치가 배선되지 않았고, 없는 것을 `available:false` 로 답하면 그것은 "최신이다"라는 거짓이
// 된다 — 사용자는 오지 않을 업데이트를 영원히 기다린다. 이름을 달고 거절한다.

const { frameworkError } = require("./error.cjs");

const NO_UPDATER = "FRAMEWORK_UPDATER_ABSENT";

/** 이 홈이 원격 앱 본체 업데이트를 받는 채널인가 — release 만 참(홈 정책). */
function remoteChannel(ctx) {
  return ctx.coreBuild() === "release";
}

const refuse = () =>
  frameworkError(
    NO_UPDATER,
    "이 프레임워크에는 앱 본체 원격 업데이트 장치가 배선되지 않았다 — 조용히 '최신'이라 답하면 오지 않을 업데이트를 기다리게 된다",
  );

module.exports = {
  update_check: {
    concept: "앱 본체 새 판 조회",
    answer: (ctx) => {
      if (!remoteChannel(ctx)) {
        return { available: false, channel: "local" };
      }
      throw refuse();
    },
  },

  update_apply: {
    concept: "앱 본체 새 판 설치",
    answer: (ctx) => {
      if (!remoteChannel(ctx)) {
        throw frameworkError(
          NO_UPDATER,
          "앱 본체 원격 업데이트는 release 채널 전용이다 — 이 홈의 본체는 로컬 빌드다",
        );
      }
      throw refuse();
    },
  },
};
