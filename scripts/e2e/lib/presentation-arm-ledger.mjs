// 표시 궤적 무장의 실패를 기록하고 실행을 잇는다.
//
// 무장은 첫 표시를 기다린다(Tauri FIRST_DISPLAY_TIMEOUT 1초). 그 안에 안 오면 그 전이는 못 잰
// 것이지 제품이 틀린 것이 아니다. 그 자리에서 던지면 엔진 실행 전체가 죽고, 같은 실행이 재던
// 다른 칸까지 함께 사라진다 — 실측 2026-08-07: browser-chromium 이 02-right 무장 실패로 12칸을
// 통째로 잃었다.
//
// 기록하고 계속 잰다. 판정은 모든 칸을 잰 뒤 마지막에 한 번 한다. 못 잼은 통과가 아니다 —
// 이름을 달고 blocked 로 답한다.

/** 실패 봉투를 이름으로 만든다. 이름 없는 실패도 사라지지 않는다. */
function nameFailure(transition, answer) {
  const code = answer?.code ?? "NO_ANSWER";
  const message = typeof answer?.message === "string" ? answer.message : "";
  return `${transition}: ${code}/${JSON.stringify(message)}`;
}

export function createPresentationArmLedger() {
  const rows = [];
  return {
    recordFailure(transition, answer) {
      rows.push(nameFailure(transition, answer));
    },
    failures() {
      return [...rows];
    },
    /** 판정에 실을 못 잼 축. 무장을 한 번이라도 놓친 실행은 이 축을 green 으로 답하지 않는다. */
    unmeasured() {
      return rows.map((row) => `presentation-arm: ${row}`);
    },
  };
}
