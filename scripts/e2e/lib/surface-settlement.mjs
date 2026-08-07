/**
 * offscreen 표면의 표시 정착 판정이 사는 자리 — 답한 실패와 답 없음을 가른다.
 *
 * 앱이 답하면 그것은 측정이다. `{"ok":false,"code":"TIMEOUT","message":"surface 12 actual
 * presentation timeout"}` 은 "표면이 선언한 슬롯에 정착하지 않았다"는 계약 사실을 이름과 함께
 * 실어 온 답이고, 부재가 아니다. 그 답을 던지면 사실은 보고서에서 사라지고 그 엔진의 남은 칸이
 * 통째로 blocked 가 된다(실측 2026-08-07 · buildId=2ebb2eb4 · tauri/darwin: 정착 실패 하나가
 * browser-chromium-offscreen 11칸을 삼켰다).
 *
 * 던지는 것은 측정 불가뿐이다 — 명령이 아무것도 돌려주지 않았을 때. 그때만 남은 칸을 사유와
 * 함께 blocked 로 닫는다.
 *
 * 위반이 있어도 실행은 계속된다. 다만 그 엔진은 마지막에 RED 로 끝난다 — 기준을 낮추지 않고
 * 측정만 끝까지 한다.
 */

const text = (value) => (typeof value === "string" ? value : "");

/** 답이 실어 온 엔진 사실. 없으면 없는 대로 둔다 — 빈 객체로 채우면 "안 물어봤다"와 "물어봤는데
 * 없다"가 같은 값이 된다. */
function answeredFacts(reply) {
  const facts = reply.surface;
  if (facts === null || facts === undefined) return null;
  if (typeof facts !== "object" || Array.isArray(facts)) return null;
  return facts;
}

/**
 * 한 뷰의 표시 정착 답을 판정으로 옮긴다. 판정은 여기서 끝나지 않는다 — 위반은 원장에 실려
 * 보고서로 가고, 부재는 부르는 쪽이 사유와 함께 던진다.
 */
export function surfaceSettlementVerdict({ stage, viewId, reply } = {}) {
  const where = `${stage} settle ${viewId}`;
  const answered = reply !== null
    && reply !== undefined
    && typeof reply === "object"
    && !Array.isArray(reply);
  if (!answered) {
    return {
      stage,
      viewId,
      answered: false,
      settled: false,
      reason: `${where}: 응답 없음 — 표시 정착을 잴 자리가 없다`,
      violation: null,
      facts: null,
    };
  }
  if (reply.ok === true) {
    return { stage, viewId, answered: true, settled: true, reason: null, violation: null, facts: null };
  }
  const code = text(reply.code) || "UNKNOWN";
  const message = text(reply.message);
  const facts = answeredFacts(reply);
  const named = facts === null ? "" : ` surface=${JSON.stringify(facts).slice(0, 400)}`;
  return {
    stage,
    viewId,
    answered: true,
    settled: false,
    reason: null,
    violation: `${where}: 표면이 선언한 슬롯에 정착하지 않았다 code=${code} message=${message}${named}`,
    facts,
  };
}

function requireVerdict(verdict) {
  if (!verdict || typeof verdict !== "object" || typeof verdict.answered !== "boolean") {
    throw new TypeError(`surface settlement 판정이 아니다: ${JSON.stringify(verdict)?.slice(0, 120)}`);
  }
  return verdict;
}

/** 한 엔진 실행 동안의 정착 측정 원장. 잰 횟수와 위반을 따로 센다 — 재지 않은 것과 재서
 * 통과한 것은 같은 값으로 표현될 수 없다. */
export function createSurfaceSettlementLedger() {
  let measured = 0;
  let violations = [];
  return {
    reset() {
      measured = 0;
      violations = [];
    },
    record(verdict) {
      requireVerdict(verdict);
      measured += 1;
      if (verdict.violation) violations.push(verdict);
      return verdict;
    },
    measured: () => measured,
    violations: () => [...violations],
    /** 잰 위반이 있으면 그 엔진은 RED 로 끝난다. 모든 칸을 잰 뒤에 부른다. */
    assertSettled(engine) {
      if (!violations.length) return;
      throw new Error(
        `${engine}: offscreen 표면이 선언한 슬롯에 정착하지 않았다 — `
        + violations.map((verdict) => verdict.violation).join("; "),
      );
    },
  };
}
