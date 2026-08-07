// 재려던 것과 답한 것이 같아야 그 판이 그 프레임워크의 판이다.
//
// 두 프레임워크가 한 홈을 쓰고 같은 cored 소켓을 나눈다. 그래서 한쪽을 띄우고 판정을 돌려도
// 소켓을 다른 쪽이 쥐고 있으면 하니스가 그쪽에 묻는다 — 실측 2026-08-08: Electron 인수를
// 돌렸는데 `pane-presentation-host=available`(Tauri 의 답)이 나왔고 보고서 신원도
// `framework: tauri` 였다. 열 칸이 green 으로 찍혔지만 그 판은 Electron 것이 아니었다.
//
// 판정이 무엇을 재는지 모른 채 답을 내면 그 답은 거짓이다.

/**
 * 이 실행이 재려던 프레임워크와 창이 답한 프레임워크를 만나게 한다.
 *
 * @param {string|undefined} target 부르는 쪽이 지목한 이름(없으면 지목 없는 실행)
 * @param {string|null|undefined} answered 창이 답한 이름
 * @returns {string} 그 판의 프레임워크
 */
export function requireTargetFramework(target, answered) {
  const said = typeof answered === "string" ? answered.trim() : "";
  if (said === "") {
    throw new Error(`창이 framework 를 답하지 않았다: ${JSON.stringify(answered)}`);
  }
  const want = typeof target === "string" ? target.trim() : "";
  if (want !== "" && want !== said) {
    throw new Error(
      `이 실행은 ${want} 를 재려 했는데 창이 ${said} 라고 답했다`
      + " — 두 프레임워크가 한 홈의 소켓을 나누므로, 지목한 앱이 그 소켓을 쥐었는지 먼저 확인하라.",
    );
  }
  return said;
}
