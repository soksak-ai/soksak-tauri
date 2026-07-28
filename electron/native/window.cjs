// window_* — 창 자체를 다루는 것들. 이 갈래는 cored 로 갈 수 없다: 그 프로세스엔 창이 없다.

const { shellError } = require("./error.cjs");

module.exports = {
  // 창 배경 — Tauri window.set_background_color 의 대응. 루트 DOM 이 투명이라 미도장 영역의
  // 색을 창이 책임진다. 기준(#rrggbb 6자리)은 코어와 같게 둔다: 같은 색 문자열에 두 셸이
  // 다르게 답하면 테마가 셸마다 달라진다.
  window_set_background: {
    concept: "창 배경색",
    source: "BrowserWindow.setBackgroundColor",
    answer: (ctx, args) => {
      const raw = String(args.color ?? "").trim();
      const hex = raw.replace(/^#/, "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        throw shellError("INVALID_COLOR", `hex 색상(#rrggbb)이 아님: ${raw}`);
      }
      // 부른 창을 못 짚으면 아무 창도 칠하지 않는다 — 아무 창이나 칠하면 남의 창을 바꿔 놓고
      // 성공을 돌려주게 된다(코어는 호출 창을 자동 주입한다).
      if (!ctx.window) throw shellError("NO_WINDOW", "부른 창을 짚지 못했다");
      ctx.window.setBackgroundColor(`#${hex.toLowerCase()}`);
      return null;
    },
  },
};
