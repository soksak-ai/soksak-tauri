// IME 판정 원장 — 조합 확정 Enter 를 무엇으로 판정했는지 남긴다.
//
// 왜 필요한가: IME 조합 신호는 웹뷰 엔진마다 다르다. `isComposing` 을 안 싣는 엔진,
// 확정 Enter 에 레거시 `keyCode 229` 를 안 주는 엔진이 있다. 셸을 갈아끼우면 여기가 먼저
// 깨지는데 **깨져도 조용하다** — 미확정 텍스트가 그냥 커밋될 뿐 오류가 나지 않는다.
// 사용자는 "이름이 이상하게 저장된다"로 겪고, 우리는 원인을 소스 추론으로 좁혀야 한다.
//
// 그래서 판정을 사건으로 남긴다. 관측은 기계적이어야 하고, 사람이 명령을 치는 순간에만
// 존재하는 판정은 관측이 아니다.
//
// 도배 방지: 같은 판정 조합이 이어지면 세기만 하고, 조합이 **바뀔 때**만 발행한다.
// IME 결함은 "어느 신호가 갑자기 사라졌는가"로 드러나므로 전이가 곧 신호다.

import { shell } from "../platform";

export interface ImeDecision {
  /** 이벤트가 실은 조합 상태(엔진이 안 실으면 false). */
  isComposing: boolean;
  /** 레거시 keyCode 229 폴백이 걸렸는가. */
  legacy: boolean;
  /** 최종 판정 — 조합 확정 Enter 인가. */
  composing: boolean;
}

let lastKey = "";
let repeats = 0;

function publish(kind: string, payload: Record<string, unknown>): void {
  // 원장 발행은 진단이다 — 실패해도 입력 처리를 막지 않는다.
  void shell
    .invoke("activity_publish", { kind, source: "core", payload })
    .catch(() => {});
}

export function noteImeDecision(d: ImeDecision): void {
  const key = `${d.isComposing}|${d.legacy}|${d.composing}`;
  if (key === lastKey) {
    repeats += 1;
    return;
  }
  const previous = lastKey;
  const previousRepeats = repeats;
  lastKey = key;
  repeats = 1;
  publish("ime.decision", {
    ...d,
    shell: shell.name,
    // 엔진이 조합 신호를 안 싣고 레거시로만 잡히면 그 자체가 진단이다.
    signal: d.isComposing ? "isComposing" : d.legacy ? "legacy-229" : "none",
    previous: previous || null,
    previousRepeats: previous ? previousRepeats : 0,
  });
}

/** 테스트용 — 전이 상태를 비운다. */
export function __resetImeLedgerForTest(): void {
  lastKey = "";
  repeats = 0;
}
