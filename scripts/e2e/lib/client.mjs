// soksak 소켓(JSON-RPC) 클라이언트 — e2e 게이트가 공유한다.
//
// 게이트마다 같은 클라이언트를 다시 쓰면 고칠 곳이 게이트 수만큼 늘어난다. 한 벌만 둔다.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");

export function openClient(socket = SOCKET) {
  const st = { sock: null, seq: 0, pending: new Map(), buf: "" };
  return new Promise((resolve, reject) => {
    st.sock = net.createConnection(socket);
    st.sock.setNoDelay(true);
    st.sock.once("error", reject);
    st.sock.once("connect", () =>
      resolve({
        rpc(method, params = {}, window) {
          return new Promise((res, rej) => {
            const id = ++st.seq;
            st.pending.set(id, res);
            const req = { id, method, params };
            if (window) req.window = window;
            st.sock.write(`${JSON.stringify(req)}\n`);
            setTimeout(() => {
              if (st.pending.has(id)) {
                st.pending.delete(id);
                rej(new Error(`TIMEOUT ${method}`));
              }
            }, 30000);
          });
        },
        close: () => st.sock.destroy(),
      }),
    );
    st.sock.on("data", (d) => {
      st.buf += d.toString("utf8");
      let i;
      while ((i = st.buf.indexOf("\n")) >= 0) {
        const line = st.buf.slice(0, i);
        st.buf = st.buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const p = st.pending.get(m.id);
        if (p) {
          st.pending.delete(m.id);
          p(m);
        }
      }
    });
  });
}

/** 봉투를 벗기고 실패는 즉시 던진다 — 조용히 넘어가면 게이트가 아니다. */
export const must = (r, what) => {
  if (!r || r.ok !== true) throw new Error(`${what} 실패: ${JSON.stringify(r)?.slice(0, 240)}`);
  return r.data ?? r;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 워크스페이스 창 라벨들(main = 컨트롤 플레인이라 제외). */
export async function workspaceWindows(c) {
  const labels = must(await c.rpc("window.list"), "window.list").labels ?? [];
  return labels.filter((l) => l !== "main");
}
