// 한 홈에 한 인스턴스.
//
// `restart-dev` 는 소켓을 쥔 프로세스를 죽인다. 소켓을 놓친 인스턴스는 그 판정을 빠져나가 계속
// 산다 — 실측 2026-08-08: 이틀째 떠 있던 인스턴스가 남아 있었고, 하니스가 한 인스턴스의 창을
// 잡고 다른 인스턴스에 물어 `WINDOW_NOT_FOUND` 로 실행이 죽었다. 그 뒤 판정은 전부 후폭풍이었다.
//
// 소켓 소유는 살아 있음의 증거이지 유일함의 증거가 아니다.

/**
 * 같은 앱 실행물의 프로세스 중 소켓을 쥐지 않은 것들의 pid.
 *
 * 소켓 주인을 못 읽었으면 아무도 지목하지 않는다 — 못 읽음을 "주인이 없다" 로 읽으면 살아 있는
 * 주인을 유령으로 죽인다.
 *
 * @param {{processes: readonly {pid: number}[], socketOwnerPid: number|null}} input
 * @returns {number[]}
 */
export function strayInstances({ processes, socketOwnerPid }) {
  // Number(null) 은 0 이다 — 못 읽음이 유효한 pid 로 둔갑하지 않게 타입부터 본다.
  if (typeof socketOwnerPid !== "number" || !Number.isFinite(socketOwnerPid)) return [];
  const owner = socketOwnerPid;
  return (processes ?? [])
    .map((row) => Number(row?.pid))
    .filter((pid) => Number.isFinite(pid) && pid !== owner);
}
