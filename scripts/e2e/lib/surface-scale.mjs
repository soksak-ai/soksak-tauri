/**
 * 배율은 **창/표시면의 사실**이다. 캡처 산출물이 아니다.
 *
 * PNG 는 그 사실을 나중에, 손실을 거쳐 다시 잰 사본이다. 사본이 정본을 정하면 판정의 허용오차가
 * 캡처 파이프라인을 따라 흔들린다 — `windowedSurfaceCompositionVerdict` 의 `physical()` 이
 * 이 값으로 반올림하므로, 사본이 1 로 내려앉는 순간 서로 다른 두 사각형이 같은 정수가 된다.
 *
 * 그래서 결정자리를 하나로 둔다. 판정에 쓰는 배율은 전부 여기를 지난다.
 */

/** 캡처에서 잰 배율이 창의 사실과 얼마나 벌어지면 사람에게 말할 것인가. */
export const CAPTURED_SCALE_TOLERANCE = 0.03;

/**
 * 창이 말한 배율. 없으면 **측정 불가**이므로 던진다.
 *
 * 1 로 대체하지 않는다. 못 읽음은 성공값으로 표현될 수 없다 — 그렇게 두면 배율 2 인 화면에서
 * 사실을 잃은 실행이 "배율 1 로 잘 쟀다"고 보고한다.
 *
 * 인자는 `window.info` 응답 그대로다. 맨 숫자를 받지 않는 것이 요점이다: 캡처에서 나온 배율은
 * 맨 숫자로 돌아다니므로, 사실을 요구하는 자리가 숫자를 거절하면 그 혼입이 표현 불가능해진다.
 */
export function displayScaleFact(windowInfo) {
  if (!windowInfo || typeof windowInfo !== "object" || Array.isArray(windowInfo)) {
    throw new TypeError(
      `display scale은 window.info 레코드의 사실이다 — 받은 것은 ${
        Array.isArray(windowInfo) ? "array" : typeof windowInfo
      }. 캡처에서 잰 맨 숫자를 사실 자리에 넣지 마라`,
    );
  }
  if (!Object.hasOwn(windowInfo, "scale")) {
    throw new TypeError("window.info에 scale이 없다 — 배율을 측정할 수 없다(1로 대체하지 않는다)");
  }
  const scale = Number(windowInfo.scale);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError(`window.info.scale이 배율이 아니다: ${JSON.stringify(windowInfo.scale)}`);
  }
  return scale;
}

/**
 * 캡처에서 잰 배율을 창의 사실과 맞대 본 결과. **사람용 진단이며 어떤 판정도 이 값으로 정해지지
 * 않는다.** 어긋나면 사실을 바꾸는 대신 어긋났다는 사실에 이름을 준다.
 */
export function capturedScaleObservation(fact, captured, {
  tolerance = CAPTURED_SCALE_TOLERANCE,
} = {}) {
  if (!Number.isFinite(captured) || captured <= 0) {
    return { fact, captured: null, delta: null, ok: false, error: null };
  }
  const delta = Math.abs(captured - fact);
  return {
    fact,
    captured,
    delta,
    ok: delta <= tolerance,
    error: delta <= tolerance
      ? null
      : `captured scale ${captured} vs window fact ${fact} (delta ${delta.toFixed(4)} > ${tolerance})`,
  };
}

/** 프레임 기하를 재기 전, 손에 든 배율이 쓸 수 있는 값인지. 0 과 null 을 조용히 곱하지 않는다. */
export function usableFrameScale(scale) {
  return Number.isFinite(scale) && scale > 0;
}
