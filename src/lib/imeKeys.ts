// 한국어 등 IME 조합 중 Enter 처리 — 조합 확정 Enter(keydown isComposing=true,
// 또는 레거시 keyCode 229)는 "입력 확정"이지 "커밋 명령"이 아니다. 이를 무시하지
// 않으면 미확정 텍스트로 rename/검색/이동이 커밋되는 오동작이 난다(WebKit 포함
// 전 브라우저 표준 패턴).
//
// 조합 신호는 **웹뷰 엔진마다 다르다**. isComposing 을 안 싣는 엔진, 확정 Enter 에
// keyCode 229 를 안 주는 엔진, compositionend 순서가 다른 엔진이 있다 — 프레임워크를 갈아끼우면
// 여기가 먼저 깨지고, 깨져도 조용하다(미확정 텍스트가 그냥 커밋될 뿐 오류가 없다).
// 그래서 판정을 원장에 남긴다: 어느 프레임워크에서 어떤 신호로 무엇을 판정했는지가 기록으로 남아야
// "IME 가 이상하다"를 소스 추론 없이 읽을 수 있다.

import { noteImeDecision } from "./imeLedger";

export function isComposingEnter(
  e: Pick<React.KeyboardEvent, "key" | "nativeEvent" | "keyCode">,
): boolean {
  if (e.key !== "Enter") return false;
  const isComposing = e.nativeEvent.isComposing === true;
  const legacy = e.keyCode === 229;
  const composing = isComposing || legacy;
  noteImeDecision({ isComposing, legacy, composing });
  return composing;
}
