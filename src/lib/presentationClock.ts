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

export function __resetPresentationClockForTest(): void {
  fallbackUnixFromPerformance = null;
}
