/**
 * React 상태 명령이 공개 DOM 커밋까지 완료됐음을 사건으로 기다린다.
 * MutationObserver는 조건 충족·timeout 어느 쪽에서도 해제되며, interval/rAF 폴링은 없다.
 */
export function waitForDomCommit(
  predicate: () => boolean,
  root: Node = document.documentElement,
  timeoutMs = 2_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let closed = false;
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      observer.disconnect();
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const observer = new MutationObserver(() => {
      if (predicate()) finish();
    });
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    const timeout = setTimeout(
      () => finish(new Error(`DOM 커밋 시간 초과(${timeoutMs}ms)`)),
      timeoutMs,
    );
    // observer 설치 직전과 직후 사이 커밋을 놓치지 않는다.
    if (predicate()) finish();
  });
}
