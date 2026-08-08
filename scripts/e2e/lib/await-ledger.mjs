// 원장에 어떤 사실이 **적히기를** 기다린다 — 되묻지 않고, 흘러온 것을 받는다.
//
// 부팅 뒤에 찍히는 도장을 읽으려면 그때까지 기다려야 하는데, 무엇을 기다릴지가 늘 명령 하나로
// 떨어지지는 않는다. 냉시동에서 워크스페이스 창은 컨트롤 플레인의 준비보다 **늦게** 선다
// (실측 2026-08-08: 첫 응답 시점 목록에 main 하나뿐이었다). 창이 서기를 되물어 확인하면 그
// 주기가 곧 오차이고, 이 하니스가 재는 대상이 바로 그 크기의 시간이다.
//
// 원장은 이미 push 통로를 가지고 있다(`events.subscribe`). 그 연결로 흘러오는 줄을 읽다가
// 찾는 사실이 나오면 끝낸다. 상한을 넘기면 못 봤다고 답한다 — 못 봄을 봄으로 표현하지 않는다.
import net from "node:net";

/**
 * @param socket 소켓 경로
 * @param match  줄 하나(파싱된 객체)를 받아 찾는 사실이면 true
 * @param timeoutMs 상한
 * @returns 찾은 줄, 또는 못 봤으면 null
 */
export function awaitLedger(socket, match, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(socket);
    let buf = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.once("connect", () => {
      sock.write(`${JSON.stringify({ id: 1, method: "events.subscribe", params: {} })}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let index = buf.indexOf("\n");
      while (index !== -1) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        if (line.trim() !== "") {
          try {
            const row = JSON.parse(line);
            if (match(row)) return finish(row);
          } catch {
            // 이 통로에는 구독 응답 같은 다른 줄도 흐른다 — 못 읽은 줄은 찾는 사실이 아니다.
          }
        }
        index = buf.indexOf("\n");
      }
    });
  });
}

/** 부팅 도장 하나를 기다린다 — `boot.step` 의 step 이 이 접두로 시작하는 줄. */
export function awaitBootStep(socket, prefix, timeoutMs) {
  return awaitLedger(
    socket,
    (row) => {
      const entry = row?.params ?? row?.entry ?? row;
      return entry?.kind === "boot.step" && String(entry?.payload?.step ?? "").startsWith(prefix);
    },
    timeoutMs,
  );
}
