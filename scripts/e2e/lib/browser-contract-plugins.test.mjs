// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BROWSER_PLUGIN_CONTRACT, resolveContractPlugins } from "./browser-contract-plugins.mjs";

const listing = (plugins) => async () => ({ ok: true, data: { plugins } });

// 규칙 — 누가 이 계약을 구현하는지는 앱에게 묻는다.
//
// 하니스가 플러그인 id 를 손으로 적은 표를 들면, 플러그인이 늘 때마다 그 표를 고쳐야 하고
// 플러그인이 자기 계약을 바꾸면 표가 조용히 갈린다. 실측 2026-08-07: 그 조용한 갈림이
// `traceId: number 여야 함` 거절로 엔진 실행을 첫 게이트에서 죽였다.
describe("resolveContractPlugins", () => {
  it("계약을 구현한다고 선언한 플러그인만 낸다", async () => {
    const answer = await resolveContractPlugins(listing([
      { id: "a", status: "enabled", implements: [{ id: BROWSER_PLUGIN_CONTRACT, version: "0.0.1" }] },
      { id: "b", status: "enabled", implements: [{ id: "soksak-spec-plugin-git", version: "0.0.1" }] },
      { id: "c", status: "enabled", implements: [] },
    ]), BROWSER_PLUGIN_CONTRACT);
    expect(answer).toEqual(["a"]);
  });

  it("활성이 아닌 플러그인은 구현자가 아니다 — 못 부르는 것은 있는 것이 아니다", async () => {
    const answer = await resolveContractPlugins(listing([
      { id: "a", status: "enabled", implements: [{ id: BROWSER_PLUGIN_CONTRACT }] },
      { id: "b", status: "error", implements: [{ id: BROWSER_PLUGIN_CONTRACT }] },
      { id: "c", status: "disabled", implements: [{ id: BROWSER_PLUGIN_CONTRACT }] },
    ]), BROWSER_PLUGIN_CONTRACT);
    expect(answer).toEqual(["a"]);
  });

  // 못 물어본 것과 아무도 구현하지 않는 것은 다른 답이다.
  it("목록을 못 읽으면 빈 목록으로 답하지 않는다", async () => {
    await expect(resolveContractPlugins(
      async () => ({ ok: false, code: "UNKNOWN_COMMAND" }),
      BROWSER_PLUGIN_CONTRACT,
    )).rejects.toThrow(/plugin\.list/);
  });

  it("선언을 답하지 않는 앱을 아무도 구현하지 않는 것으로 읽지 않는다", async () => {
    await expect(resolveContractPlugins(
      listing([{ id: "a", status: "enabled" }]),
      BROWSER_PLUGIN_CONTRACT,
    )).rejects.toThrow(/implements/);
  });

  it("아무도 구현하지 않으면 빈 목록이다 — 선언은 읽었고 답이 없다", async () => {
    const answer = await resolveContractPlugins(listing([
      { id: "a", status: "enabled", implements: [{ id: "soksak-spec-plugin-git" }] },
    ]), BROWSER_PLUGIN_CONTRACT);
    expect(answer).toEqual([]);
  });
});

// 실측 2026-08-07: 앱이 계약 선언 축을 아직 안 내는 실행물이었는데, 판정이 그 침묵을 "구현자
// 없음" 으로 읽어 엔진 실행을 첫 게이트에서 죽였다. 비활성 플러그인을 먼저 거르지 않아 남의
// 상태 때문에 판정이 죽기도 했다.
describe("침묵과 미선언은 다른 답이다", () => {
  it("활성 플러그인이 선언을 안 답하면 아무도 구현하지 않는 것으로 읽지 않는다", async () => {
    await expect(resolveContractPlugins(listing([
      { id: "a", status: "enabled" },
    ]), BROWSER_PLUGIN_CONTRACT)).rejects.toThrow(/implements 를 답하지 않았다/);
  });

  it("비활성 플러그인의 침묵은 이 판정을 죽이지 않는다", async () => {
    const answer = await resolveContractPlugins(listing([
      { id: "a", status: "enabled", implements: [{ id: BROWSER_PLUGIN_CONTRACT }] },
      { id: "b", status: "disabled" },
    ]), BROWSER_PLUGIN_CONTRACT);
    expect(answer).toEqual(["a"]);
  });

  it("한 구현자라도 답했으면 다른 플러그인의 침묵은 이 판정의 축이 아니다", async () => {
    const answer = await resolveContractPlugins(listing([
      { id: "a", status: "enabled", implements: [{ id: BROWSER_PLUGIN_CONTRACT }] },
      { id: "b", status: "enabled" },
    ]), BROWSER_PLUGIN_CONTRACT);
    expect(answer).toEqual(["a"]);
  });
});
