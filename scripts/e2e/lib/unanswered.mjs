// 안 답한 자리는 한 자리가 판별한다.
//
// 자기 궤적을 가진 구현은 코어 원장이 답하는 값을 다 답하지 못한다(offscreen 사이드카). 계약이
// 그 자리를 null 로 두는 것은 지어내지 않기 위해서이고, 판정은 그 null 을 "틀린 값" 으로 읽으면
// 없는 사실을 red 로 세게 된다.
//
// 이 판별을 자리마다 손으로 쓰면 반드시 하나가 빠진다 — 실측 2026-08-08: B05 한 게이트에서만
// 여섯 겹이 차례로 드러났다(궤적 필드 → 시계 → 사건 필드 → 표면 정체 → 사각형 → 프레임 순번).
// 매번 실행을 돌려야 다음 겹이 보였다.

/**
 * 이 자리를 원장이 답하지 않았는가.
 *
 * 값이 있으면 답한 것이다 — 틀린 값(0, "", NaN)도 답한 것이므로 판정이 red 로 센다.
 * 안 답함으로 도피하지 않는다.
 *
 * @param {unknown} value
 * @param {readonly string[]} [axes] 사각형처럼 안쪽을 봐야 하는 자리의 축 이름
 * @returns {boolean}
 */
export function isUnanswered(value, axes = null) {
  if (value === null || value === undefined) return true;
  // 껍데기만 보면 안쪽의 null 이 그대로 샌다. 전부 비면 안 답한 것이고, 일부만 비면 잘못 답한
  // 것이다 — 그 둘은 고칠 자리가 다르다.
  if (axes && typeof value === "object") {
    return axes.every((axis) => value[axis] === null || value[axis] === undefined);
  }
  return false;
}
