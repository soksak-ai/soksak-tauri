// divider 강조 대칭 E2E — 켜졌으면 꺼질 수 있어야 한다.
//
// RED 근거(실측 2026-07-26): accent 세로선이 창 본문 전체 높이로 브라우저 표면들을 가로지른 채
// 굳어 있었다. ui.hit 이 그 자리에서 `egroup-divider s1:0` 을 반환했고, 그 rect(985.4, 82, 6, 997)
// 는 네이티브 강조바 프레임과 정확히 같았다 — DOM 강조와 네이티브 바가 같은 굳은 상태의 두 얼굴.
//
// 원인은 소유권이었다. 강조를 CSS :hover 가 소유했는데, 포인터가 네이티브 자식(브라우저 표면)
// 으로 빠져나가면 webview 는 leave 를 못 받아 그대로 붙든다. 게다가 :hover 는 스크립트로 켜지도
// 끄지도 못해 구동도 검증도 불가능했다 — 그래서 이 테스트 자체가 존재할 수 없었다.
//
// 소유권을 앱 상태로 옮기고 ui.input.pointer 로 그 상태를 OS 와 같은 경로로 구동한다. 여기서
// 고정하는 것은 대칭이다: 무장되면 강조가 서고, 이탈이 오면 반드시 풀린다.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");

function openClient() {
  const st = { sock: null, seq: 0, pending: new Map(), buf: "" };
  return new Promise((resolve, reject) => {
    st.sock = net.createConnection(SOCKET);
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
const must = (r, w) => {
  if (!r || r.ok !== true) throw new Error(`${w} 실패: ${JSON.stringify(r)?.slice(0, 220)}`);
  return r.data ?? r;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = await openClient();
  try {
    const wins = must(await c.rpc("window.list"), "window.list").labels ?? [];
    const window = wins.find((l) => l !== "main");
    if (!window) throw new Error("워크스페이스 창 없음");
    const tree = must(await c.rpc("ui.tree", {}, window), "ui.tree");
    const addr = JSON.stringify(tree).match(
      new RegExp(`"win/${window}/chrome/divider/[^"]+"`),
    )?.[0];
    if (!addr) {
      console.log("✓ divider-hover 건너뜀 — 이 창에 분할 divider 가 없다");
      return;
    }
    const address = JSON.parse(addr);

    const hoverOf = async () => {
      const m = must(await c.rpc("ui.measure", { address }, window), "ui.measure");
      return (m.dataset ?? {}).hover ?? null;
    };

    await c.rpc("ui.input.pointer", {}, window); // 시작 상태 정규화
    await sleep(200);
    if ((await hoverOf()) != null) throw new Error("시작 상태가 이미 강조됨");

    const on = must(await c.rpc("ui.input.pointer", { address }, window), "pointer enter");
    await sleep(200);
    if (on.dividerHover == null) throw new Error("무장 실패 — dividerHover 가 비었다");
    if ((await hoverOf()) !== "1") throw new Error("무장했는데 data-hover 가 서지 않았다");

    const off = must(await c.rpc("ui.input.pointer", {}, window), "pointer leave");
    await sleep(200);
    if (off.dividerHover != null) throw new Error("이탈했는데 상태가 남았다");
    if ((await hoverOf()) != null) {
      throw new Error("이탈했는데 강조가 남았다 — 굳은 세로선의 재발");
    }
    console.log(`✓ divider-hover GREEN — ${address} 무장→이탈 대칭 확인`);
  } finally {
    c.close();
  }
}
main().catch((e) => {
  console.error(`✗ divider-hover 실패: ${e?.message ?? e}`);
  process.exit(1);
});
