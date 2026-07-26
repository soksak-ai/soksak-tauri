// 플러그인 뷰 호스트 DOM 앵커 계약 — 코어가 발급한 식별자를 DOM 에서 역참조 가능하게 노출.
// 회귀 방지: 942ae86(내장 터미널 → 플러그인) 에서 앵커가 누락돼 그 id 로 host 를 찾는 오버레이
// 플러그인(claude-gui)이 깨졌다. 이 계약을 못박아 재발을 차단한다.
//
// 이름 두 벌: 정본은 data-tab-id(어휘 표준 — 인스턴스는 탭이다), 옛 이름 data-pane-id 는 같은 값을
// 동반한다. 앵커는 플러그인 계약면이므로 개명 릴리즈에서 한쪽만 남기면 옛 이름을 읽는 플러그인이
// host 를 못 찾는다. 제거 조건은 viewHostAnchors.ts 머리말에 있다 — 그때 이 테스트의 옛 이름 단언도
// 함께 지운다(둘은 같은 계약의 앞뒤다).
import { describe, expect, it } from "vitest";
import { viewHostAnchors } from "./viewHostAnchors";

describe("viewHostAnchors — 콘텐츠 뷰 호스트 DOM 앵커 계약", () => {
  it("data-view-addr 는 모든 배치에서 노드 스캔 baseAddress 로 노출", () => {
    expect(viewHostAnchors("content/view/soksak-plugin-x.main", "tab-aaaaaa")).toMatchObject({
      "data-view-addr": "content/view/soksak-plugin-x.main",
    });
  });

  it("콘텐츠 배치(탭 有)는 탭 역참조 앵커를 두 이름으로 노출", () => {
    // statusBarItem·command.started 가 발급한 탭 id 로 플러그인이 이 host 를
    // querySelector('[data-tab-id="tab-aaaaaa"]') 로 찾는다(대칭성).
    expect(
      viewHostAnchors("content/view/soksak-plugin-terminal-xterm.content", "tab-aaaaaa"),
    ).toEqual({
      "data-view-addr": "content/view/soksak-plugin-terminal-xterm.content",
      "data-tab-id": "tab-aaaaaa",
      "data-pane-id": "tab-aaaaaa",
    });
  });

  it("두 이름은 언제나 같은 값이다 — 갈라지면 옛 이름 소비자가 다른 host 를 찾는다", () => {
    const a = viewHostAnchors("content/view/p.v", "tab-bbbbbb");
    expect(a["data-pane-id"]).toBe(a["data-tab-id"]);
  });

  it("사이드바 배치(탭 없음)는 두 앵커 다 노출 안 함 — 추종 대상과 혼동 방지", () => {
    // 사이드바 호스트가 따라가는 것은 '추종 대상 터미널'이지 자기 인스턴스 id 가 아니다. 앵커 부재.
    expect(viewHostAnchors("left/view/soksak-plugin-file-tree.tree", null)).toEqual({
      "data-view-addr": "left/view/soksak-plugin-file-tree.tree",
    });
  });
});
