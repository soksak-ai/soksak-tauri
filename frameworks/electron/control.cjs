// 제어면 중계 — 밖에서 온 명령이 창에 닿는 길.
//
// **여기에 규칙은 없다.** 타겟 창을 고르는 규칙은 코어가 소유하고(soksak-core control),
// 소켓 뒤에 세우는 것은 cored 다(soksak-cored control). 이 파일이 하는 일은 셋뿐이다:
// ① cored 에 "창은 내가 갖고 있다"고 등록하고, ② 밀려오는 배달을 그 창에 넘기고,
// ③ 창 사실이 바뀌면 알린다. 판정을 여기서 한 줄이라도 하면 그 판정이 두 벌이 된다.
//
// 회신 경로는 **이미 있다**. 창의 실행기가 `invoke("cmd_result", {id, result})` 를 부르고,
// 그 호출은 여느 명령과 같은 다리로 cored 에 닿는다(electron/backend.cjs). 그래서 이 파일에는
// 돌아오는 길이 없다 — 만들면 명령 하나가 두 길로 답하게 된다.
//
// electron 을 require 하지 않는다. 프레임워크를 띄워야만 검증되는 코드는 사실상 검증되지
// 않으므로, 이 파일은 목 서버와 스텁 창으로 그대로 몰 수 있어야 한다.

const net = require("node:net");

/** 창 실행기가 듣는 사건 이름 — 앱과 **같은 이름**이다(src/commands/executor.ts). */
const CMD_REQUEST = "cmd-request";

/** 프리로드가 여는 전역 사건 통로(electron/preload.cjs). */
const EVENT_CHANNEL = "framework:event";

const ATTACH = "control_host_attach";
const WINDOWS = "control_windows";

/** 등록 요청에 다는 상관 id — cored 가 되울려 주므로 그 응답만 골라낼 수 있다. */
const ATTACH_ID = "attach";

/**
 * 호스트 연결 한 벌.
 *
 * 명령 다리(backend.cjs)와 **다른 연결**을 쓴다. 그 다리 위에서는 응답이 요청의 짝으로만
 * 오는데, 배달은 짝 없이 밀려오는 줄이라 같은 연결에 섞으면 다리의 줄 짝짓기가 어긋난다.
 *
 * facts() = 지금의 창 사실{live, focused, lastWorkspace}. 값이 아니라 **함수**로 받는다:
 * 창은 계속 바뀌고, 등록 시점의 사본을 쥐면 다시 붙을 때 낡은 목록으로 등록한다.
 * deliver(label, payload) = 그 창에 사건 하나. 닿았는지 돌려준다.
 * broadcast(event, payload) = 살아 있는 창 **전부**에 같은 사건. 전부에 닿았는지 돌려준다.
 */
function createControlHost({ socketPath, facts, deliver, broadcast = () => true, onLog = () => {} }) {
  let sock = null;
  let buf = "";
  let closed = false;
  // 등록 완료 신호. **폴링하지 않는다** — cored 가 등록 요청에 답하는 그 줄이 신호다.
  // 붙었는지 반복해 물으면 그 질문 자체가 배달로 나가 창이 유령 명령을 받는다(실측).
  let announceReady;
  const ready = new Promise((resolve) => {
    announceReady = resolve;
  });

  const send = (line) => {
    if (!sock || sock.destroyed) return false;
    sock.write(`${JSON.stringify(line)}\n`);
    return true;
  };

  /** 답을 기다리는 갱신들 — id → resolve. 상관 id 가 없으면 답이 짝 없는 줄로 버려진다. */
  const awaiting = new Map();
  let updateSeq = 0;

  /** 보내고 **cored 가 답할 때** 끝나는 요청. 답의 ok 가 그대로 결과다.
   *
   *  쓴 것은 받아들여진 것이 아니다. 소켓 쓰기만 보고 끝내면 거절당한 갱신과 반영된 갱신이
   *  같은 값으로 나오고, 부르는 쪽은 자기 장부와 cored 의 장부가 갈린 것을 모른다. */
  function ask(method, params) {
    const id = `${method}:${++updateSeq}`;
    if (!send({ id, method, params })) return Promise.resolve(false);
    return new Promise((resolve) => {
      awaiting.set(id, resolve);
    });
  }

  /** 연결이 끊기면 기다리던 갱신은 닿지 않은 것이다 — 매달아 두지 않는다. */
  function dropAwaiting() {
    for (const resolve of awaiting.values()) resolve(false);
    awaiting.clear();
  }

  function handle(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // cored 가 보낸 줄은 전부 JSON 이다. 아니면 우리가 붙은 곳이 cored 가 아니다 —
      // 조용히 넘기면 "명령이 사라진다"로만 나타난다.
      onLog(`제어면: JSON 이 아닌 줄을 받았다 — ${line.slice(0, 200)}`);
      return;
    }
    // 방송 — 짝 없는 사건이다(파일 변경 등). 창을 가리지 않고 전부에 같은 것을 준다.
    const b = msg && msg.broadcast;
    if (b && typeof b.event === "string") {
      if (!broadcast(b.event, b.payload)) {
        onLog(`제어면: 방송이 일부 창에 닿지 못했다 — ${b.event}`);
      }
      return;
    }
    const d = msg && msg.deliver;
    if (!d) {
      // 등록·갱신의 응답 봉투 — 배달이 아니다. 등록의 답이면 그것이 "이제 밖에서 온 명령이
      // 이 창들로 온다"는 신호다.
      if (msg && msg.id === ATTACH_ID) {
        if (msg.ok !== true) onLog(`제어면: 등록이 서지 않았다 — ${msg.code}: ${msg.message}`);
        announceReady(msg.ok === true);
        return;
      }
      const waiting = msg && awaiting.get(msg.id);
      if (waiting) {
        awaiting.delete(msg.id);
        if (msg.ok !== true) onLog(`제어면: 창 사실 갱신이 서지 않았다 — ${msg.code}: ${msg.message}`);
        waiting(msg.ok === true);
      }
      return;
    }
    // 페이로드는 **그대로** 간다 — 키를 골라 다시 적으면 그것이 두 번째 계약이다. 고르는
    // 자리는 새 필드를 모르고, 모르는 필드는 실패가 아니라 소멸한다(실측 2026-08-01:
    // 여기서 5키만 옮겨 `parent`·`origin` 이 창에 닿지 못했다).
    const reached = deliver(d.window, d);
    if (!reached) {
      // 못 닿은 배달은 부른 쪽에서 상한으로만 보인다(회신이 영영 안 온다). 왜 안 왔는지는
      // 이 줄이 유일한 자국이다.
      onLog(`제어면: 배달이 창에 닿지 못했다 — ${d.method} → ${d.window}`);
    }
  }

  /** 지금의 창 사실로 등록한다 — 붙을 때마다 새로 읽는다(낡은 사본으로 등록하지 않는다). */
  function attach() {
    const f = facts();
    return send({ id: ATTACH_ID, method: ATTACH, params: f });
  }

  function connect() {
    if (closed || sock) return;
    sock = net.createConnection(socketPath);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      onLog(`제어면: cored 에 붙었다 — ${socketPath}`);
      attach();
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (line) handle(line);
      }
    });
    const drop = (why) => {
      if (!sock) return;
      sock.removeAllListeners();
      sock.destroy();
      sock = null;
      buf = "";
      dropAwaiting();
      if (!closed) onLog(`제어면: 연결이 끊겼다(${why}) — 밖에서 오는 명령이 닿지 않는다`);
    };
    sock.on("error", (e) => drop(e.code || e.message));
    sock.on("close", () => drop("close"));
  }

  return {
    start() {
      connect();
      return this;
    },
    /** 등록이 선 뒤에 참으로 풀린다 — 밖에서 오는 명령이 창에 닿기 시작하는 시점. */
    get ready() {
      return ready;
    },
    /** 창 사실이 바뀌었다. 낡은 목록으로 타겟을 고르면 죽은 창에 배달된다.
     *
     *  cored 가 그 갱신에 답했을 때 끝난다 — 그 사이에 온 명령은 옛 창으로 간다. */
    windowsChanged() {
      return ask(WINDOWS, facts());
    },
    stop() {
      closed = true;
      dropAwaiting();
      if (sock) {
        sock.removeAllListeners();
        sock.destroy();
        sock = null;
      }
    },
    get connected() {
      return !!sock && !sock.destroyed;
    },
  };
}

module.exports = { createControlHost, CMD_REQUEST, EVENT_CHANNEL, ATTACH, WINDOWS };
