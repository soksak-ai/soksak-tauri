// 이 자리 아래의 칸을 짚어 활성화한다 — **어느 길로 들어오든 같은 함수.**
//
// 들어오는 길은 둘이다: 콘텐츠 뷰가 포커스를 받았다는 사실(계약 사건)과, 표면 위의 좌표
// (문서 밖 콘텐츠를 가진 프레임워크의 네이티브 마우스 모니터). 두 길이 각자 자기 판정을
// 가지면 한쪽만 고쳐지고 그 어긋남은 오류로 안 보인다 — 브라우저를 눌렀는데 결합이 안
// 따라가는 침묵이 그 모양이다(실측 2026-08-02).
import { allGroups, useSessions } from "../state/sessions";
import { activeSessionViewId, transferViewFocus } from "../plugins/viewFocus";

export function bindPaneUnder(el: Element | null): void {
  const slot = el?.closest<HTMLElement>("[data-pane]");
  // 이름과 값이 같은 실체를 가리킨다 — 속성은 `data-pane`(칸 id)이다. `dataset.groupId` 는
  // 있지도 않은 `data-group-id` 를 찾아 언제나 undefined 이고, 그러면 이 아래가 통째로
  // 안 돈다(계측 2026-08-02: pane 은 잡히는데 결합이 안 일어났다).
  const groupId = slot?.dataset.pane;
  const projectId = slot?.dataset.projectId;
  if (!groupId || !projectId) return;
  const state = useSessions.getState();
  const project = state.projects.find((item) => item.id === projectId);
  const space = project?.spaces.find((item) => item.id === project.activeSpaceId);
  const group = space ? allGroups(space.layout).find((item) => item.id === groupId) : null;
  const targetViewId = group?.activeTabId;
  if (targetViewId) {
    transferViewFocus(activeSessionViewId(), targetViewId, () =>
      state.setActiveGroup(projectId, groupId),
    );
  } else {
    state.setActiveGroup(projectId, groupId);
  }
}
