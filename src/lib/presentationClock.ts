/**
 * 표시 원장이 쓰는 시계의 이름 — 이 이름이 뜻하는 것은 "unix 로 한 번 고정하고, 그 뒤로는
 * monotonic 표시 시계로만 나아간다"이다. OS 시각 보정으로 점프하지 않고, system sleep 동안
 * 나아가지 않는다.
 *
 * 이름은 관측을 내는 쪽이 선언하고 판정하는 쪽이 읽는다. `...UnixMs`라는 이름은 같은 시계를
 * 뜻하지 않으므로, 두 producer의 시각을 한 축에서 비교하려면 둘 다 이 이름을 답해야 한다.
 */
export const PRESENTATION_CLOCK = "unix-anchored-monotonic";

let unixOriginMs: number | null = null;

/**
 * 표시 epoch의 원점 — 프로세스에서 한 번만 고정한다.
 *
 * `performance.timeOrigin`은 상수가 아니다. WebKit은 읽을 때마다 지금 wall clock에서 되계산하고
 * (MonotonicTime::approximateWallTime), 그래서 실행 중 OS 시각 보정이 그대로 이 값에 실린다.
 * 매번 다시 읽으면 이 시계는 monotonic이 아니라 wall clock을 따라가고, uptime에 고정된 native
 * 표시 시계와 갈라진다 — 그 차이는 결함이 아니라 시계 차이를 재게 된다.
 *
 * 그래서 원점은 첫 호출에서 한 번 고정하고, 그 뒤로는 document monotonic clock만 더한다.
 */
function anchoredOriginMs(documentTimeMs: () => number): number {
  if (unixOriginMs === null) {
    const declaredOrigin = performance.timeOrigin;
    unixOriginMs = Number.isFinite(declaredOrigin)
      ? declaredOrigin
      : Date.now() - documentTimeMs();
  }
  return unixOriginMs;
}

/**
 * DOM layout와 native presentation이 공유하는 monotonic Unix epoch.
 */
export function presentationNowUnixMs(): number {
  const now = performance.now();
  return anchoredOriginMs(() => now) + now;
}

/**
 * document monotonic clock의 한 시각을 같은 Unix epoch 표기로 옮긴다.
 *
 * 프레임 콜백은 `performance.now()` 축의 시각을 인자로 준다. 그것을 원장에 실으려면 지금
 * 시각과 **같은 축**이어야 한다 — 여기서 옮기지 않고 Date.now()를 섞으면 표시 epoch와 관측
 * epoch가 서로 다른 시계의 값이 되고, 그 차이는 결함이 아니라 시계 차이를 재게 된다.
 */
export function presentationUnixMsFromDocumentTime(documentTimeMs: number): number {
  return anchoredOriginMs(() => performance.now()) + documentTimeMs;
}

export function __resetPresentationClockForTest(): void {
  unixOriginMs = null;
}
