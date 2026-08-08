// 소켓 자리가 생기기를 기다린다 — 되묻지 않고 파일시스템 사건으로.
//
// 앱을 띄운 직후에는 그 자리가 없다. 없을 때 연결하면 ENOENT 이고, 그것은 앱의 결함이 아니라
// 아직 안 만들어졌다는 사실이다. 되묻기(폴링)는 만들어진 뒤에도 다음 물음까지 기다리므로 잰
// 시간에 자기 주기를 섞는다 — 부팅을 재는 자리에서 그 오차는 재는 대상만큼 크다.
//
// `fs.watch` 는 감시를 시작한 뒤의 변화만 준다. 그래서 감시를 먼저 걸고 그 다음에 한 번
// 확인한다 — 순서를 뒤집으면 그 사이에 생긴 자리를 영원히 못 본다.
import { existsSync, watch } from "node:fs";
import path from "node:path";

/**
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<void>} 자리가 생기면 즉시. 상한을 넘기면 거절한다.
 */
export function awaitSocket(socketPath, timeoutMs) {
  if (existsSync(socketPath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const dir = path.dirname(socketPath);
    const name = path.basename(socketPath);
    let watcher = null;
    let timer = null;
    const done = (err) => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    try {
      watcher = watch(dir, (_event, file) => {
        if (file === name || existsSync(socketPath)) done(null);
      });
    } catch (err) {
      done(new Error(`소켓 자리를 감시할 수 없다(${dir}): ${err}`));
      return;
    }
    timer = setTimeout(
      () => done(new Error(`소켓 자리가 ${timeoutMs}ms 안에 생기지 않았다: ${socketPath}`)),
      Math.max(0, timeoutMs),
    );
    // 감시를 건 뒤 한 번 더 본다 — 감시 설치와 이 확인 사이는 사건으로 덮인다.
    if (existsSync(socketPath)) done(null);
  });
}
