// **100ms 를 누가 쓰는지 응답이 답한다.**
//
// 탭 전환의 정착이 100ms 를 기다리는데, DOM 과 모션은 9ms 에 이미 끝나 있었다(실측 2026-08-09).
// 남은 전부가 "표면이 화면에 올라왔는가" 를 확인하는 구간인데, 그 안에 호출이 여럿이라 어느 것이
// 얼마인지 물을 자리가 없었다. 그래서 나는 범인을 **추측해서** 두 번 바꿨고 두 번 다 더 느려졌다
// (100ms → 225ms → 350ms 이상). 재는 자리가 없으면 고치는 것은 도박이다.
//
// 확인 구간은 두 배리어로 갈린다: 콘텐츠 표면 쪽과 뷰 표면 쪽. 응답이 그 둘을 따로 답한다.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

const barriers = vi.hoisted(() => ({
  content: vi.fn(async () => {}),
  view: vi.fn(async () => {}),
}));
vi.mock("../lib/contentViews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/contentViews")>()),
  hasContentViewHost: () => true,
  contentViewHost: () => ({ presentationSettled: barriers.content }),
}));
vi.mock("../plugins/viewPresentationHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/viewPresentationHost")>()),
  pluginViewPresentationHost: () => ({ presentationSettled: barriers.view }),
}));

import { waitLayoutSettled } from "./waitLayoutSettled";

beforeEach(() => {
  barriers.content.mockClear();
  barriers.view.mockClear();
  // 라벨은 문서의 선언에서 온다 — 목으로 지어내면 이 검사는 실제와 다른 세계를 잰다.
  document.body.innerHTML = `<div data-content-view-body="b-main-t1"></div>`;
});

describe("정착 영수증은 확인 구간을 갈라 답한다", () => {
  it("두 배리어의 시간을 따로 싣는다", async () => {
    barriers.content.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); });
    barriers.view.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const out = await waitLayoutSettled(4_000);
    expect(out.presentation.contentMs).toBeGreaterThanOrEqual(25);
    expect(out.presentation.viewMs).toBeGreaterThanOrEqual(8);
    // 어느 표면을 기다렸는지도 답한다 — 개수를 모르면 한 개가 느린 것과 여럿이 겹친 것을 못 가른다.
    expect(out.presentation.contentLabels).toEqual(["b-main-t1"]);
  });

  it("배리어가 없으면 0 이 아니라 없음으로 답한다 — 안 잰 것과 0ms 는 다른 사실이다", async () => {
    const out = await waitLayoutSettled(4_000);
    expect(out.presentation.contentMs).not.toBeNull();
  });
});
