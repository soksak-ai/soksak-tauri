// Electron 창을 화면에 내놓는 한 자리.
// 백그라운드 시각 검증은 실물 창을 합성하되 사용자의 활성 앱을 바꾸지 않는다.
function revealWindow(win, env = process.env) {
  if (env.SOKSAK_START_INACTIVE === "1") win.showInactive();
  else win.show();
}

module.exports = { revealWindow };
