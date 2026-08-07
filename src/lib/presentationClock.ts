let fallbackUnixFromPerformance: number | null = null;

/**
 * DOM layout와 native presentation이 공유하는 monotonic Unix epoch.
 *
 * Date.now()는 실행 중 OS 시각 보정으로 점프할 수 있다. presentation 거래의 순서와 간격은
 * document monotonic clock에 고정하고, Unix epoch 표기는 그 clock의 고정 timeOrigin만 더한다.
 */
export function presentationNowUnixMs(): number {
  const now = performance.now();
  const declaredOrigin = performance.timeOrigin;
  if (Number.isFinite(declaredOrigin)) return declaredOrigin + now;
  fallbackUnixFromPerformance ??= Date.now() - now;
  return fallbackUnixFromPerformance + now;
}

/**
 * document monotonic clock의 한 시각을 같은 Unix epoch 표기로 옮긴다.
 *
 * 프레임 콜백은 `performance.now()` 축의 시각을 인자로 준다. 그것을 원장에 실으려면 지금
 * 시각과 **같은 축**이어야 한다 — 여기서 옮기지 않고 Date.now()를 섞으면 표시 epoch와 관측
 * epoch가 서로 다른 시계의 값이 되고, 그 차이는 결함이 아니라 시계 차이를 재게 된다.
 */
export function presentationUnixMsFromDocumentTime(documentTimeMs: number): number {
  const declaredOrigin = performance.timeOrigin;
  if (Number.isFinite(declaredOrigin)) return declaredOrigin + documentTimeMs;
  fallbackUnixFromPerformance ??= Date.now() - performance.now();
  return fallbackUnixFromPerformance + documentTimeMs;
}

export function __resetPresentationClockForTest(): void {
  fallbackUnixFromPerformance = null;
}
