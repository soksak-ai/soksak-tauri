// @vitest-environment jsdom
// **안 보이는 표면에는 묻지 않는다.**
//
// 표시 확인은 표면마다 화면 도달을 묻고 그 한 번이 100ms 다(실측 2026-08-09). 그런데 활성 탭이
// 하나인데 네 표면에 물었다 — 그중 하나(`chromium-tab-qfs4mc`)는 **탭 목록에 아예 없는** 표면이고
// 다른 하나는 지금 안 보이는 탭의 것이었다.
//
// 안 보이는 표면은 화면에 올라올 일이 없으므로 그 물음은 답을 기다리는 시간이 곧 낭비다. 더 나쁜
// 것은 어느 탭에도 속하지 않은 표면이다 — 그 표면은 사라졌는데 배리어는 계속 그것을 기다린다.
//
// 무엇이 지금 화면에 있는가는 **문서의 선언**이 안다. 뷰가 자기 기억으로 답하면 그 기억이 낡은
// 날 배리어가 유령을 기다린다.
import { describe, expect, it } from "vitest";
import { presentationBarrierLabels } from "./presentationBarrierScope";

const view = (renderer: string, members: string[], visible: boolean) => ({ renderer, members, visible });

describe("표시 확인의 범위", () => {
  it("보이는 뷰의 표면만 묻는다", () => {
    expect(
      presentationBarrierLabels(
        [view("pv-1", ["b-1"], true), view("pv-2", ["b-2"], false)],
        new Set(["pv-1", "b-1", "pv-2", "b-2"]),
      ),
    ).toEqual(["pv-1", "b-1"]);
  });

  // 문서가 모르는 표면은 사라진 것이다 — 기다리면 그 시간이 전부 낭비다.
  it("문서가 선언하지 않은 표면은 묻지 않는다", () => {
    expect(
      presentationBarrierLabels([view("pv-1", ["b-1", "chromium-tab-gone"], true)], new Set(["pv-1", "b-1"])),
    ).toEqual(["pv-1", "b-1"]);
  });

  // 아무것도 안 보이면 물을 것이 없다 — 빈 목록은 "모른다" 가 아니라 "없다" 이다.
  it("보이는 것이 없으면 빈 목록이다", () => {
    expect(presentationBarrierLabels([view("pv-1", ["b-1"], false)], new Set(["pv-1", "b-1"]))).toEqual([]);
  });

  // 같은 표면을 두 번 물으면 그 시간을 두 번 낸다.
  it("같은 표면을 두 번 묻지 않는다", () => {
    expect(
      presentationBarrierLabels(
        [view("pv-1", ["b-1"], true), view("pv-1", ["b-1"], true)],
        new Set(["pv-1", "b-1"]),
      ),
    ).toEqual(["pv-1", "b-1"]);
  });
});
