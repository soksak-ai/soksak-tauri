// @vitest-environment jsdom
// 합성 참가자 선언 — 코어가 모양을 정하고 프레임워크가 찍는다.
//
// 세 원장(자리·carrier·표면)이 따로 열거돼야 누락된 표면이 짝지어진 결과 뒤에 숨지 않는다.
// 그 셋이 같은 뷰의 것임을 잇는 실은 위상 주소 하나뿐이라, 주소를 만드는 자리도 하나여야 한다.
import { describe, expect, it } from "vitest";
import {
  COMPOSITION_KIND_ATTR,
  clearCompositionParticipant,
  compositionOwnerViewId,
  compositionParticipantSelector,
  contentCompositionTopologyPath,
  declareCompositionParticipant,
  readCompositionParticipant,
  setCompositionParticipantVisible,
} from "./compositionParticipants";

describe("합성 참가자 선언", () => {
  it("같은 뷰의 참가자는 한 위상 주소를 든다 — 만드는 자리가 하나다", () => {
    expect(contentCompositionTopologyPath("w-1", "v-7", "b-w-1-v-7"))
      .toBe("window/w-1/view/v-7/content/b-w-1-v-7");
    // 값에 구분자가 섞여도 주소가 갈라지지 않는다.
    expect(contentCompositionTopologyPath("w/1", "v 7", "b/1"))
      .toBe("window/w%2F1/view/v%207/content/b%2F1");
  });

  it("선언을 찍고 그대로 읽는다", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    expect(el.getAttribute(COMPOSITION_KIND_ATTR)).toBe("slot");
    expect(readCompositionParticipant(el)).toEqual({
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    expect(el.matches(compositionParticipantSelector("slot"))).toBe(true);
    expect(el.matches(compositionParticipantSelector("renderer"))).toBe(false);
  });

  it("한 축이라도 비면 참가자가 아니다 — 못 읽음을 반쪽 선언으로 답하지 않는다", () => {
    const bare = document.createElement("div");
    expect(readCompositionParticipant(bare)).toBeNull();
    const half = document.createElement("div");
    half.setAttribute(COMPOSITION_KIND_ATTR, "slot");
    half.dataset.viewId = "v-7";
    expect(readCompositionParticipant(half)).toBeNull();
    const unknownKind = document.createElement("div");
    declareCompositionParticipant(unknownKind, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    unknownKind.setAttribute(COMPOSITION_KIND_ATTR, "surface");
    expect(readCompositionParticipant(unknownKind)).toBeNull();
  });

  it("가시성만 갱신한다 — 정체성 축은 그대로다", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "renderer",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    setCompositionParticipantVisible(el, false);
    expect(readCompositionParticipant(el)).toEqual({
      kind: "renderer",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: false,
    });
  });

  it("선언을 걷으면 참가자가 아니다 — 죽은 참가자가 원장에 남지 않는다", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    clearCompositionParticipant(el);
    expect(readCompositionParticipant(el)).toBeNull();
    expect(el.hasAttribute(COMPOSITION_KIND_ATTR)).toBe(false);
  });

  it("소유 뷰는 공개 앵커에서 읽는다 — label 에서 추론하지 않는다", () => {
    const host = document.createElement("div");
    host.dataset.tabId = "v-7";
    const slot = document.createElement("div");
    host.appendChild(slot);
    document.body.appendChild(host);
    expect(compositionOwnerViewId(slot)).toBe("v-7");

    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(compositionOwnerViewId(loose)).toBeNull();
  });
});
