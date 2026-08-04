// soksak 소켓(JSON-RPC) 클라이언트 — e2e 게이트가 공유한다.
//
// 게이트마다 같은 클라이언트를 다시 쓰면 고칠 곳이 게이트 수만큼 늘어난다. 한 벌만 둔다.
import net from "node:net";
import process from "node:process";

/** 소켓 경로가 오는 통로. 하나뿐이고, 기본값은 없다. */
export const SOCKET_ENV = "SOKSAK_SOCKET";

/** 컨트롤 플레인의 예약 라벨 — 워크스페이스 라벨(w-*)이 절대 가질 수 없는 이름. */
export const CONTROL_LABEL = "main";

/** 붙을 곳을 환경에서 받는다 — 없으면 이름을 달고 실패한다.
 *
 *  기본 경로를 지어내면, 값을 안 준 실행이 실패 대신 **다른 홈의 앱**에 붙어 놓고 판정을 낸다.
 *  하니스는 자기가 어느 셸 위에서 도는지 몰라야 하고, 홈 이름은 셸과 identity 의 사실이다. */
export function requireSocket(env = process.env) {
  const v = env[SOCKET_ENV];
  if (!v) throw new Error(`${SOCKET_ENV} 이 없다 — e2e 하니스는 소켓 경로를 지어내지 않는다`);
  return v;
}

/** Build the public socket envelope. Long finite work owns its deadline at the call site. */
export function commandRequestEnvelope(id, method, params = {}, window, options = {}) {
  const req = { id, method, params };
  if (window) req.window = window;
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive finite number: ${options.timeoutMs}`);
    }
    req.timeoutMs = Math.floor(options.timeoutMs);
  }
  return req;
}

export function openClient(socket = requireSocket()) {
  const st = { sock: null, seq: 0, pending: new Map(), buf: "" };
  return new Promise((resolve, reject) => {
    st.sock = net.createConnection(socket);
    st.sock.setNoDelay(true);
    st.sock.once("error", reject);
    st.sock.once("connect", () =>
      resolve({
        rpc(method, params = {}, window, options = {}) {
          return new Promise((res, rej) => {
            const id = ++st.seq;
            // 상한 타이머는 답이 오면 **끈다**. 안 끄면 답을 받은 뒤에도 이 프로세스가 30초를
            // 더 산다 — 하니스가 끝나지 않는 것처럼 보이고, 그 지연이 앱 탓으로 읽힌다.
            const timer = setTimeout(() => {
              if (st.pending.has(id)) {
                st.pending.delete(id);
                rej(new Error(`TIMEOUT ${method}`));
              }
            }, Math.max(30_000, Number(options.timeoutMs ?? 0) + 5_000));
            st.pending.set(id, (v) => {
              clearTimeout(timer);
              res(v);
            });
            const req = commandRequestEnvelope(id, method, params, window, options);
            st.sock.write(`${JSON.stringify(req)}\n`);
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

/** 봉투를 벗기고 실패는 즉시 던진다 — 조용히 넘어가면 게이트가 아니다. */
export const must = (r, what) => {
  if (!r || r.ok !== true) throw new Error(`${what} 실패: ${JSON.stringify(r)?.slice(0, 240)}`);
  return r.data ?? r;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 컨트롤 봉투 해소 — 창-무관 명령(window.*·project.*)이 지목할 살아있는 창 하나를 정한다.
 *  특정 라벨("main")을 하드코딩하지 않는다: main 은 닫힐 수 있는 창이다(실사고 2026-07-27 —
 *  main 부재 상태에서 "main" 봉투가 전부 WINDOW_NOT_FOUND 로 죽고, teardown 실패로 남은
 *  잔재 창이 포커스 폴백을 점유해 봉투 없는 컨트롤 명령까지 통째로 TIMEOUT). 해소는 라우터
 *  계약 그대로다: 봉투 없는 window.list 는 폴백이 서면 어느 창에서든 목록을 내고, 서지
 *  않으면 AMBIGUOUS_WINDOW 가 후보를 실어 거절한다 — 정렬 첫 항목이 결정적 타겟이다
 *  (main 은 정렬상 w-* 앞이라 살아있으면 자연히 컨트롤 플레인이 뽑힌다). exclude 는
 *  "닫으려는 창 자신"을 빼는 용도(자기 경유 close 는 회신이 유실된다) — 남는 창이 없으면
 *  그 라벨을 그대로 쓴다(회신은 잃어도 닫힘은 성사된다). */
export async function resolveControlWindow(rpc, exclude) {
  // 먼저 예약 라벨에 **직접** 묻는다. 봉투 없는 질의는 포커스 폴백을 타므로, 굳은 잔재 창이
  // 그 자리를 점유하면 목록조차 못 얻는다(실측 2026-07-28: UNKNOWN_COMMAND window.list —
  // 회수 도구가 회수 대상 때문에 못 돌았다). 컨트롤 플레인은 이름이 정해져 있으니 폴백에
  // 기대지 않는다. 없는 토폴로지면 아래 폴백 경로가 그대로 선다.
  if (CONTROL_LABEL !== exclude) {
    const direct = await rpc("window.list", {}, CONTROL_LABEL).catch(() => null);
    if (direct?.ok === true && Array.isArray(direct.data?.labels)) return CONTROL_LABEL;
  }
  const r = await rpc("window.list", {});
  const pool =
    r?.ok === true ? r.data?.labels
    : r?.code === "AMBIGUOUS_WINDOW" ? r.data?.candidates
    : null;
  if (!Array.isArray(pool) || pool.length === 0)
    throw new Error(`컨트롤 창 해소 실패: ${JSON.stringify(r)?.slice(0, 240)}`);
  const alive = pool.filter((l) => l !== exclude).sort();
  return alive[0] ?? exclude;
}

/** 워크스페이스 창 라벨들 — w-* 만(NAMING §1-4b). 컨트롤 플레인 등 그 외 라벨은 제외. */
export async function workspaceWindows(c) {
  const ctrl = await resolveControlWindow(c.rpc);
  const labels = must(await c.rpc("window.list", {}, ctrl), "window.list").labels ?? [];
  return labels.filter((l) => l.startsWith("w-"));
}
