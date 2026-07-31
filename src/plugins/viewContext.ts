// 뷰 컨텍스트의 축 — "무엇이 바뀌면 뷰가 알아야 하는가"의 단일 진실.
//
// 여태 이 판정은 PluginViewHost 안에 필드 이름 목록으로 손배선돼 있었다: root·viewId·command 는
// remount 키에, paneId 만 update+remount 둘 다, boundViewId 는 어느 쪽에도. 목록을 손으로 쓰면
// 새 필드는 조용히 빠지고, 빠진 필드는 "결부는 바뀌었는데 화면은 옛 것"으로 나타난다
// (실측 2026-07-31: shared 투영이 결부 전환 뒤에도 직전 뷰의 내용을 그렸다).
//
// 축은 둘이고, 방향이 반대다:
//   binding — 코어가 정해서 뷰에게 주는 값. 바뀌면 **뷰가 알아야 한다**.
//   seed    — 마운트 1회 씨앗. 뷰 자신이 되쓰는 값이라(setRestoreState → restore) 변경을
//             트리거로 삼으면 보고→재생성→재보고의 고리가 된다. **트리거가 아니다.**
//
// 등재 누락은 컴파일이 막는다 — 아래 satisfies 가 데이터 필드 전수를 요구하므로, 계약에 데이터
// 필드를 더하면 축을 적기 전까지 빌드가 서지 않는다. 손목록이 아니라 규칙의 시행이다.

import type { PluginViewContext } from "./viewRegistry";

/** 콜백(능력)이 아닌 값 필드 — 계약에서 파생한다. 손으로 나열하지 않는다. */
export type ViewContextDataKey = {
  [K in keyof PluginViewContext]-?: PluginViewContext[K] extends (
    ...args: never[]
  ) => unknown
    ? never
    : K;
}[keyof PluginViewContext];

export type ViewContextAxis = "binding" | "seed";

export const VIEW_CONTEXT_AXIS = {
  projectId: "binding",
  root: "binding",
  paneId: "binding",
  viewId: "binding",
  boundViewId: "binding",
  command: "binding",
  // 뷰가 setRestoreState 로 되쓰는 값 — 트리거로 삼으면 되먹임 고리다(binding 으로 옮기지 마라).
  restore: "seed",
} as const satisfies Record<ViewContextDataKey, ViewContextAxis>;

/** 결부 축 필드 — 정렬해 고정한다(선언 순서가 정체성을 흔들면 안 된다). */
export const BINDING_KEYS: readonly ViewContextDataKey[] = (
  Object.keys(VIEW_CONTEXT_AXIS) as ViewContextDataKey[]
)
  .filter((k) => VIEW_CONTEXT_AXIS[k] === "binding")
  .sort();

/**
 * 결부 정체성 — 이 값이 바뀌면 뷰가 알아야 한다.
 *
 * 참조가 아니라 **값**으로 잰다: 부모가 매 렌더 새 객체를 만들어도 내용이 같으면 같은 결부다
 * (참조 비교였다면 무해한 재렌더가 remount 폭풍이 된다).
 */
export function bindingIdentity(
  ctx: Pick<PluginViewContext, ViewContextDataKey>,
): string {
  return JSON.stringify(BINDING_KEYS.map((k) => ctx[k] ?? null));
}
