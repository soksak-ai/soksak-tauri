// gutter 강조 대칭 E2E — 켜졌으면 꺼질 수 있어야 한다.
//
// RED 근거(실측 2026-07-26): accent 세로선이 창 본문 전체 높이로 브라우저 표면들을 가로지른 채
// 굳어 있었다. ui.hit 이 그 자리에서 골 요소를 반환했고, 그 rect(985.4, 82, 6, 997)
// 는 네이티브 강조바 프레임과 정확히 같았다 — DOM 강조와 네이티브 바가 같은 굳은 상태의 두 얼굴.
//
// 원인은 소유권이었다. 강조를 CSS :hover 가 소유했는데, 포인터가 네이티브 자식(브라우저 표면)
// 으로 빠져나가면 webview 는 leave 를 못 받아 그대로 붙든다. 게다가 :hover 는 스크립트로 켜지도
// 끄지도 못해 구동도 검증도 불가능했다 — 그래서 이 테스트 자체가 존재할 수 없었다.
//
// 소유권을 앱 상태로 옮기고 ui.input.pointer 로 그 상태를 OS 와 같은 경로로 구동한다. 여기서
// 고정하는 것은 대칭이다: 무장되면 강조가 서고, 이탈이 오면 반드시 풀린다.
import net from "node:net";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { requireSocket } from "./lib/client.mjs";
import { acquireFixtureWindow, releaseFixtureWindow } from "./lib/fixtureWindow.mjs";

// 자기 창을 세우고 그 창만 만진다. 이 하니스는 포인터를 **구동**하므로, 주변에 떠 있는 첫
// 창을 잡으면 사용자가 쓰던 창에 마우스를 넣게 된다 — 읽기와 달리 되돌릴 수 없다.
// 분할도 스스로 만든다: gutter 가 없으면 조용히 건너뛰고, 그 통과는 아무것도 지키지 않는다.
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "gutter-hover");

const SOCKET = requireSocket();

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
    st.sock.setEncoding("utf8");
    st.sock.on("data", (d) => {
      st.buf += d;
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
    fs.mkdirSync(FIXTURE, { recursive: true });
    const rpc = (name, params, w) => c.rpc(name, params, w);
    const { label: window } = await acquireFixtureWindow(rpc, FIXTURE);

    // 분할을 세운다 — 터미널 하나를 열고 옆에 하나 더. 그래야 gutter 가 생긴다.
    let term = null;
    for (let i = 0; i < 40 && !term; i += 1) {
      const ids = (must(await c.rpc("program.list", {}, window), "program.list").programs ?? []).map(
        (p) => p.id,
      );
      term = ids.find((id) => id.startsWith("terminal-")) ?? null;
      if (!term) await sleep(500);
    }
    if (!term) throw new Error("터미널 프로그램이 서지 않았다 — 분할을 만들 수 없다");
    await c.rpc("tab.open", { program: term }, window);
    await sleep(1500);
    must(await c.rpc("pane.split", { side: "right", program: term }, window), "pane.split");
    await sleep(2500);

    const tree = must(await c.rpc("ui.tree", {}, window), "ui.tree");
    const addr = JSON.stringify(tree).match(
      // 정본 주소는 프로젝트 축을 싣는다(주소 공리 A1) — 생략형만 찾으면 조용히 건너뛴다.
      new RegExp(`"win/${window}/(?:proj/[^/"]+/)?chrome/gutter/[^"]+"`),
    )?.[0];
    // 건너뛰지 않는다 — 분할은 위에서 우리가 세웠다. 없으면 그것이 결함이다.
    if (!addr) throw new Error("분할을 세웠는데 gutter 주소가 없다");
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
    if (on.gutterHover == null) throw new Error("무장 실패 — gutterHover 가 비었다");
    if ((await hoverOf()) !== "1") throw new Error("무장했는데 data-hover 가 서지 않았다");

    const off = must(await c.rpc("ui.input.pointer", {}, window), "pointer leave");
    await sleep(200);
    if (off.gutterHover != null) throw new Error("이탈했는데 상태가 남았다");
    if ((await hoverOf()) != null) {
      throw new Error("이탈했는데 강조가 남았다 — 굳은 세로선의 재발");
    }
    console.log(`✓ gutter-hover GREEN — ${address} 무장→이탈 대칭 확인`);
  } finally {
    await releaseFixtureWindow((n, pa, w) => c.rpc(n, pa, w), FIXTURE).catch(() => {});
    c.close();
  }
}
main().catch((e) => {
  console.error(`✗ gutter-hover 실패: ${e?.message ?? e}`);
  process.exit(1);
});
