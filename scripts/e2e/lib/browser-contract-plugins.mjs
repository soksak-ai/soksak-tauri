// 누가 이 계약을 구현하는지는 앱에게 묻는다.
//
// 하니스가 플러그인 id 를 손으로 적은 표를 들면 두 가지가 깨진다. 플러그인이 늘 때마다 그 표를
// 고쳐야 하고(하니스가 플러그인에 결합된다), 플러그인이 자기 계약을 바꾸면 표가 조용히 갈린다.
// 실측 2026-08-07: 그 조용한 갈림이 `traceId: number 여야 함` 거절로 엔진 실행을 첫 게이트에서
// 죽여 12칸 중 9칸이 blocked 로 남았다.
//
// 선언은 플러그인 매니페스트의 `implements` 에 살고, 코어가 `plugin.list` 로 그것을 답한다.

/** 세 브라우저 구현이 함께 선언하는 계약. */
export const BROWSER_PLUGIN_CONTRACT = "soksak-spec-plugin-browser";

/**
 * 이 계약을 구현한다고 **선언하고 지금 부를 수 있는** 플러그인의 id.
 *
 * 못 물어본 것과 아무도 구현하지 않는 것은 다른 답이다 — 목록을 못 읽거나 앱이 선언 자체를
 * 답하지 않으면 빈 목록으로 접지 않고 이름을 달고 멈춘다.
 *
 * @param {(command: string, params?: object) => Promise<object>} ask `plugin.list` 를 부를 수 있는 호출자
 * @param {string} contractId
 * @returns {Promise<string[]>} 선언한 플러그인 id, 앱이 답한 순서 그대로
 */
export async function resolveContractPlugins(ask, contractId) {
  const answer = await Promise.resolve(ask("plugin.list", {}));
  if (answer?.ok !== true) {
    throw new Error(`plugin.list 를 읽지 못했다: ${JSON.stringify(answer)?.slice(0, 240)}`);
  }
  const plugins = answer.data?.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`plugin.list 가 plugins 목록을 답하지 않았다: ${JSON.stringify(answer.data)?.slice(0, 240)}`);
  }
  const implementers = [];
  for (const plugin of plugins) {
    if (!Array.isArray(plugin?.implements)) {
      throw new Error(
        `plugin.list 가 ${plugin?.id} 의 implements 를 답하지 않았다`
        + " — 선언을 못 읽은 것을 아무도 구현하지 않는 것으로 읽지 않는다.",
      );
    }
    // 못 부르는 것은 있는 것이 아니다. 비활성·오류 플러그인의 명령은 답하지 않는다.
    if (plugin.status !== "enabled") continue;
    if (plugin.implements.some((declared) => declared?.id === contractId)) implementers.push(plugin.id);
  }
  return implementers;
}
