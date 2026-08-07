// 합성 참가자 선언 — 한 콘텐츠 뷰를 함께 그리는 참가자들이 **자기를 밝히는 모양**.
//
// 판정은 세 원장을 따로 열거한다: 자리(slot), 그것을 채우는 carrier(renderer), 그리고 살아
// 있는 표면(surface). 따로 세지 않으면 없어진 표면이 짝지어진 결과 뒤에 숨는다 — 하나가
// 사라져도 통과하는 판정은 판정이 아니다.
//
// 셋이 같은 뷰의 것이라는 사실을 잇는 실은 위상 주소 하나뿐이다. 그래서 주소를 만드는 자리도
// 하나여야 한다: 두 자리에서 같은 규칙을 다시 쓰면 한쪽이 바뀌는 날 조용히 갈리고, 그 갈림은
// "합성이 안 맞는다"가 아니라 "참가자를 못 찾는다"로 나타난다.
//
// **모양은 코어가 정하고, 무엇이 참가자인지는 프레임워크가 정한다.** 콘텐츠가 문서 밖인
// 프레임워크는 자기가 투영한 대역을 찍고, 문서 안인 프레임워크는 자리와 그 안의 태그를
// 찍는다. 코어는 어느 쪽인지 묻지 않는다 — 찍힌 선언만 읽는다.

/** 문서에서 관측되는 참가자의 종류. 표면은 DOM 종류가 아니라 호스트가 내는 영수증이다. */
export type CompositionParticipantKind = "slot" | "renderer";

const KINDS: readonly CompositionParticipantKind[] = ["slot", "renderer"];

export interface CompositionParticipant {
  kind: CompositionParticipantKind;
  /** 이 참가자가 그리는 뷰. 공개 앵커가 답하는 값이며 label 에서 추론하지 않는다. */
  viewId: string;
  /** 같은 뷰의 참가자 전원이 공유하는 위상 주소. */
  topologyPath: string;
  /** 지금 실제로 합성에 참여하는가. 좌표나 직전 프레임 상태로 대신 답하지 않는다. */
  visible: boolean;
}

export const COMPOSITION_KIND_ATTR = "data-composition-kind";

/** 그 종류의 참가자를 찾는 셀렉터 — 이름을 문자열로 다시 짜지 않는다. */
export function compositionParticipantSelector(kind: CompositionParticipantKind): string {
  return `[${COMPOSITION_KIND_ATTR}=${kind}]`;
}

/**
 * 한 콘텐츠 표면의 위상 주소.
 *
 * 값에 구분자가 섞여도 주소가 갈라지지 않게 각 조각을 인코딩한다 — 안 하면 label 하나가
 * 주소 한 칸을 더 만들어 두 뷰의 주소가 같아진다.
 */
export function contentCompositionTopologyPath(
  windowLabel: string,
  viewId: string,
  label: string,
): string {
  return `window/${encodeURIComponent(windowLabel)}`
    + `/view/${encodeURIComponent(viewId)}`
    + `/content/${encodeURIComponent(label)}`;
}

/**
 * 콘텐츠 carrier 의 공개 노드 경로 — 주소로 발견되지 않는 참가자는 원장이 셀 수 없다.
 *
 * 주소 문법은 소문자·숫자·점·붙임표만 받는다. 그 밖의 글자는 붙임표로 접어 주소를 만들되,
 * 접힌 두 label 이 한 자리에 함께 서면 ui.tree 의 중복 보고가 그 사실을 드러낸다.
 */
export function contentViewNodePath(label: string): string {
  const folded = label.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `content-view/${folded.length > 0 ? folded : "unnamed"}`;
}

/** 이 참가자가 그리는 뷰 — 탭 인스턴스 역참조 앵커(정본)가 답한다. */
export function compositionOwnerViewId(el: HTMLElement): string | null {
  return el.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId ?? null;
}

export function declareCompositionParticipant(
  el: HTMLElement,
  participant: CompositionParticipant,
): void {
  el.setAttribute(COMPOSITION_KIND_ATTR, participant.kind);
  el.dataset.viewId = participant.viewId;
  el.dataset.topologyPath = participant.topologyPath;
  el.dataset.visible = String(participant.visible);
}

/** 가시성만 갱신한다 — 정체성 축을 다시 쓰면 참가자가 조용히 다른 뷰의 것이 된다. */
export function setCompositionParticipantVisible(el: HTMLElement, visible: boolean): void {
  if (!el.hasAttribute(COMPOSITION_KIND_ATTR)) return;
  el.dataset.visible = String(visible);
}

/** 선언을 걷는다 — 죽은 참가자가 원장에 남으면 판정은 없는 표면을 기다린다. */
export function clearCompositionParticipant(el: HTMLElement): void {
  el.removeAttribute(COMPOSITION_KIND_ATTR);
  delete el.dataset.viewId;
  delete el.dataset.topologyPath;
  delete el.dataset.visible;
}

/**
 * 찍힌 선언을 읽는다. **한 축이라도 비면 참가자가 아니다** — 반쪽 선언을 기본값으로 채우면
 * 원장은 그것을 살아 있는 참가자로 세고, 빠진 축은 오류가 아니라 정상값으로 나타난다.
 */
export function readCompositionParticipant(el: HTMLElement): CompositionParticipant | null {
  const kind = el.getAttribute(COMPOSITION_KIND_ATTR);
  const viewId = el.dataset.viewId;
  const topologyPath = el.dataset.topologyPath;
  const visible = el.dataset.visible;
  if (!KINDS.includes(kind as CompositionParticipantKind)) return null;
  if (!viewId || !topologyPath) return null;
  if (visible !== "true" && visible !== "false") return null;
  return {
    kind: kind as CompositionParticipantKind,
    viewId,
    topologyPath,
    visible: visible === "true",
  };
}
