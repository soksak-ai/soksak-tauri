/**
 * 표면 원장 불변식 판정이 사는 자리 — 잰 위반과 잴 수 없음을 가른다.
 *
 * `sentinel-created: view→surface→engine 불일치 — ledger=[]/mapped=[4]` 는 계약 사실이다.
 * 창도 명령도 살아 있었고 앱이 stats 로 답했으며, 그 답이 자기 모순을 실어 왔다. 던지면 그
 * 이름은 보고서에서 사라지고 그 엔진의 남은 칸이 통째로 blocked 가 된다(실측 2026-08-07 ·
 * tauri/darwin: 이 불일치 하나가 browser-chromium-offscreen 11칸을 삼켰다).
 *
 * 잴 수 없음은 이 자리의 것이 아니다 — stats 를 못 읽으면 부르는 쪽의 must 가 던지고, 그때만
 * 남은 칸이 사유와 함께 blocked 로 닫힌다. 여기 오는 것은 이미 답이다.
 *
 * 이 불변식의 주인은 어떤 게이트도 아니다. B03 이 재는 것은 공개 DOM 의 slot·renderer 와 엔진
 * 표면 원장의 1:1 기하이고, 여기서 재는 것은 플러그인이 자기 stats 안에서 답한 생성 장부·뷰
 * 매핑·엔진 소유의 합치다. 다른 사실을 같은 칸에 실으면 그 칸은 두 뜻이 된다.
 *
 * 위반이 있어도 실행은 계속된다. 다만 그 엔진은 마지막에 RED 로 끝난다 — 기준을 낮추지 않고
 * 측정만 끝까지 한다.
 */

/** 한 단계의 불변식 답을 판정으로 옮긴다. */
export function surfaceInvariantVerdict({ stage, windowLabel, verdict } = {}) {
  if (
    !verdict
    || typeof verdict !== "object"
    || typeof verdict.ok !== "boolean"
    || !Array.isArray(verdict.errors)
  ) {
    throw new TypeError(
      `surface invariant 판정이 아니다: ${JSON.stringify(verdict)?.slice(0, 120)}`,
    );
  }
  const where = windowLabel ? `${stage}@${windowLabel}` : String(stage);
  return {
    stage,
    windowLabel: windowLabel ?? null,
    consistent: verdict.ok,
    errors: [...verdict.errors],
    violation: verdict.ok
      ? null
      : `${where}: view→surface→engine 불일치 — ${verdict.errors.join(", ")}`,
  };
}

function requireVerdict(verdict) {
  if (!verdict || typeof verdict !== "object" || typeof verdict.consistent !== "boolean") {
    throw new TypeError(`surface invariant 판정이 아니다: ${JSON.stringify(verdict)?.slice(0, 120)}`);
  }
  return verdict;
}

/**
 * 한 엔진 실행 동안의 불변식 측정 원장. 잰 횟수와 위반을 따로 센다 — 재지 않은 것과 재서
 * 통과한 것은 같은 값으로 표현될 수 없다.
 */
export function createSurfaceInvariantLedger() {
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
    assertConsistent(engine) {
      if (!violations.length) return;
      throw new Error(
        `${engine}: 표면 원장이 뷰·엔진과 일치하지 않는다 — `
        + violations.map((verdict) => verdict.violation).join("; "),
      );
    },
  };
}
