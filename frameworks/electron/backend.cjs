// Electron 프레임워크의 백엔드 다리 — 소켓 NDJSON 클라이언트.
//
// 프레임워크는 명령을 실행하지 않는다. 요청을 소켓 너머로 넘기고 답을 그대로 돌려준다. 전선은 앱
// 소켓(src-tauri/src/ipc.rs)과 같은 모양이다 — 한 줄 JSON 요청 → 한 줄 JSON 응답, `id` 로 상관:
//   요청 {"id":1,"method":"data_kv_get","params":{...}}
//   응답 {"id":1,"ok":true,"data":{...}} | {"id":1,"ok":false,"code":"...","message":"..."}
//
// electron 을 require 하지 않는다. 프레임워크를 띄워야만 검증되는 코드는 사실상 검증되지 않으므로,
// 이 파일은 목 서버에 대고 그대로 몰 수 있어야 한다(scripts/electron/backend-socket.test.mjs).
//
// 못 하는 것은 이름을 달고 실패한다. 조용한 no-op 이나 가짜 성공은 "돌아간다"는 착시를 만들고,
// 그 착시가 이식 판단을 망친다.

const net = require("node:net");

/** 소켓 경로가 오는 두 통로. 기본 경로를 짓지 않는다 — 없으면 없다고 답한다. */
const SOCKET_ENV = "SOKSAK_SOCKET";
const SOCKET_ARG = "--soksak-socket=";

/** 응답을 못 받았을 때의 대기 상한. e2e 클라이언트(scripts/e2e/lib/client.mjs)와 같은 값. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 프레임워크가 다는 이름들 — 백엔드가 준 코드는 그대로 통과시키고, 여기 코드는 다리의 사실이다. */
const NOT_CONNECTED = "BACKEND_NOT_CONNECTED"; // 소켓 경로 자체가 없다(오늘의 기본 상태)
const UNREACHABLE = "BACKEND_UNREACHABLE"; // 경로는 있는데 붙지 못했다
const DISCONNECTED = "BACKEND_DISCONNECTED"; // 답을 기다리는 중 연결이 끊겼다
const TIMEOUT = "BACKEND_TIMEOUT"; // 상한까지 답이 없었다
const MALFORMED = "BACKEND_MALFORMED_REPLY"; // 봉투가 아닌 답이 왔다

class BackendError extends Error {
  constructor(code, message, command) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.command = command;
  }
}

/**
 * 소켓 경로 해소 — 인자가 환경변수를 이긴다(더 구체적인 지목이 이긴다). 둘 다 없으면 null:
 * 기본 경로를 하드코딩하면 남의 앱 소켓에 붙어 놓고 "붙었다"고 답할 수 있다.
 */
function resolveSocketPath({ env = process.env, argv = process.argv } = {}) {
  const arg = argv.find((a) => typeof a === "string" && a.startsWith(SOCKET_ARG));
  const fromArg = arg ? arg.slice(SOCKET_ARG.length) : "";
  if (fromArg) return fromArg;
  const fromEnv = env[SOCKET_ENV];
  return fromEnv ? fromEnv : null;
}

/**
 * 백엔드 다리 한 벌.
 *
 * 연결 수명 = **유지 연결 하나 + id 다중화**, 끊기면 다음 호출에서 다시 붙는다. 근거 둘:
 * ① 프로토콜이 그렇게 생겼다 — 응답이 `id` 를 되울리므로 한 연결 위에 여러 요청이 겹쳐도
 *    짝이 정해진다. 기존 소켓 클라이언트(scripts/e2e/lib/client.mjs)가 같은 모양이다
 *    (한 연결, ++seq, pending 맵, 줄 단위 버퍼링).
 * ② 호출마다 새 연결은 비싸다 — 서버는 연결마다 스레드를 하나 띄우고(ipc.rs handle_conn),
 *    스파이크 실측 부팅 1회가 50건이 넘는다(activity_publish 28 · data_kv_get 10 · 그 외).
 * 첫 호출까지 붙지 않는다(게으른 연결) — 프레임워크 기동이 백엔드 기동을 기다리지 않는다.
 *
 * onDemand(cmd, served, code) = 요구 원장 싱크. 프레임워크는 jsonl 을 꽂고 테스트는 배열을 꽂는다.
 */
function createBackendClient(options = {}) {
  const socketPath = options.socketPath ?? null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onDemand = options.onDemand ?? (() => {});
  // 붙자마자 보내는 선언들 — "이 연결이 무엇인가"를 백엔드가 알아야 하는 경우가 있다.
  // 프레임워크는 여기에 control_bridge_attach 를 꽂는다: 창의 다리로 온 요청을 서빙하지 않는다고
  // 창으로 되돌리면 물어본 그 창에 배달되고, 회신할 자리가 없어 상한까지 침묵한다(실측 10초).
  // 응답은 기다리지 않는다 — 선언은 이 연결의 사실이고, 첫 명령보다 먼저 줄에 오른다.
  const announce = options.announce ?? [];

  let sock = null;
  let connecting = null;
  let seq = 0;
  let buf = "";
  const pending = new Map();
  // 토큰 → 프레임을 받을 자리. 토큰은 렌더러가 만들고(preload createStream) 인자에 실려
  // 백엔드로 건너간다 — 함수는 프로세스 경계를 못 넘으므로 소켓 위에서는 토큰이 전부다.
  const streams = new Map();

  /** 대기 중인 자리를 전부 깨운다 — 남겨 두면 그 호출은 오지 않을 답을 영원히 기다린다. */
  function rejectAll(code, message) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BackendError(code, message, entry.command));
    }
  }

  function onData(chunk) {
    // 청크는 이미 문자열이다 — 소켓에 `setEncoding("utf8")` 를 걸어 두었기 때문이다.
    // 여기서 Buffer 를 직접 디코드하면 안 된다: 소켓 청크는 임의 지점에서 나뉘므로 멀티바이트
    // 한 글자가 경계에 걸리면 앞뒤가 각각 U+FFFD 로 대체된다. 그렇게 깨진 값이 상태에 들어가
    // 다시 저장되면 그 손상은 영구히 남는다(실측 2026-08-01: 스냅샷에 `터미널(����티)`).
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 한 줄이 깨졌다고 연결을 버리지 않는다. 다만 삼키지도 않는다 — 짝을 못 찾은
        // 요청은 자기 상한에서 이름을 달고 끝난다.
        console.error(`[electron-framework] 파싱 못 한 응답 줄: ${line.slice(0, 200)}`);
        continue;
      }
      // 스트림 프레임 — 답이 아니라 **밀려온 것**이다. 짝을 찾지 않는다(짝이 없다).
      // 답 봉투와 겹치지 않는 키라 여기서 갈린다(soksak-core stream::FRAME_KEY).
      const f = msg && msg.stream;
      if (f && typeof f.token === "string") {
        const sink = streams.get(f.token);
        // 모르는 토큰은 이미 끝난 스트림이다 — 오류가 아니지만 삼키지도 않는다.
        if (sink) sink(f.msg);
        else console.error(`[electron-framework] 짝 없는 스트림 프레임(token=${f.token})`);
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        console.error(`[electron-framework] 짝 없는 응답 무시(id=${JSON.stringify(msg.id)})`);
        continue;
      }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  function connect() {
    if (sock) return Promise.resolve(sock);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.setNoDelay(true);
      const onConnectError = (e) => {
        connecting = null;
        reject(
          new BackendError(
            UNREACHABLE,
            `백엔드 소켓에 붙지 못했다: ${socketPath} (${e.code || e.message})`,
          ),
        );
      };
      s.once("error", onConnectError);
      s.once("connect", () => {
        s.off("error", onConnectError);
        sock = s;
        connecting = null;
        buf = "";
        // 경계 조립은 Node 에게 맡긴다 — 형제 파일(control.cjs)이 쓰는 것과 같은 규칙이다.
        s.setEncoding("utf8");
        s.on("data", onData);
        // 선언이 먼저다. 같은 연결·같은 순서라 첫 명령이 이 줄보다 앞설 수 없다.
        // 선언에도 상관 id 를 단다 — 짝이 없으면 답이 "짝 없는 응답"으로 버려지고, 선언이
        // **거절당한 것**과 그냥 조용한 것이 구분되지 않는다.
        for (const method of announce) {
          const id = ++seq;
          pending.set(id, {
            command: method,
            timer: setTimeout(() => pending.delete(id), timeoutMs),
            resolve: (v) => {
              if (v && v.ok === false) {
                console.error(
                  `[electron-framework] 연결 선언이 거절됐다: ${method} — ${v.code}: ${v.message}`,
                );
              }
            },
            reject: () => {},
          });
          s.write(`${JSON.stringify({ id, method })}\n`);
        }
        // 붙은 뒤의 오류·종료는 같은 사실이다: 이 연결로는 더 못 간다. 다음 호출이 다시 붙는다.
        s.on("error", () => s.destroy());
        s.on("close", () => {
          if (sock === s) sock = null;
          buf = "";
          rejectAll(DISCONNECTED, `백엔드 연결이 끊겼다: ${socketPath}`);
        });
        resolve(s);
      });
    });
    return connecting;
  }

  /**
   * 성공 봉투의 값 — `data` 가 있으면 그것(MESSAGE-PROTOCOL v1 의 페이로드 자리), 없으면 봉투
   * 자체. e2e 클라이언트의 unwrap(`r.data ?? r`)과 같은 규칙이다. `id` 만 벗긴다 — 그 번호는
   * 이 다리가 발급한 상관 번호이지 앱이 볼 값이 아니다.
   */
  function payloadOf(replyValue) {
    if (replyValue.data !== undefined) return replyValue.data;
    const rest = { ...replyValue };
    delete rest.id;
    return rest;
  }

  /** 이 토큰으로 오는 프레임을 여기로 흘린다. 반환 = 그만 받기. */
  function onStream(token, sink) {
    streams.set(token, sink);
    return () => streams.delete(token);
  }

  /** 실패는 원장에 사유까지 남기고 던진다 — 원장이 "무엇을 못 했는가"의 근거다. */
  function fail(code, message, cmd) {
    onDemand(cmd, false, code);
    throw new BackendError(code, message, cmd);
  }

  async function call(cmd, args) {
    if (!socketPath) {
      fail(
        NOT_CONNECTED,
        `백엔드 소켓 경로가 없다: "${cmd}" — ${SOCKET_ENV} 환경변수나 ${SOCKET_ARG}<경로> 인자로 준다`,
        cmd,
      );
    }
    let live;
    try {
      live = await connect();
    } catch (e) {
      fail(e.code || UNREACHABLE, e.message, cmd);
    }

    const id = ++seq;
    // 창 봉투(window)를 싣지 않는다: 프레임워크의 창 라벨은 프레임워크의 것이고 백엔드의 창 축이 아니다.
    // 판(protocol)도 선언하지 않는다: 판 상수의 단일진실은 계약 크레이트(soksak-spec-socket)이고
    // JS 로 베끼면 두 번째 진실이 된다. 부재=0(레거시) 규칙이 호환창 안이다.
    const request = { id, method: cmd, params: args ?? {} };

    let replyValue;
    try {
      replyValue = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new BackendError(
              TIMEOUT,
              `백엔드가 ${timeoutMs}ms 안에 답하지 않았다: "${cmd}"`,
              cmd,
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, command: cmd });
        try {
          live.write(`${JSON.stringify(request)}\n`);
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new BackendError(DISCONNECTED, `백엔드로 못 보냈다: ${e.message}`, cmd));
        }
      });
    } catch (e) {
      fail(e.code || DISCONNECTED, e.message, cmd);
    }

    if (replyValue.ok === true) {
      onDemand(cmd, true);
      return payloadOf(replyValue);
    }
    if (replyValue.ok !== false) {
      // ok 없는 답을 성공으로 치면 그것이 곧 가짜 성공이다.
      fail(MALFORMED, `봉투가 아닌 답: "${cmd}" — ${JSON.stringify(replyValue).slice(0, 200)}`, cmd);
    }
    // 백엔드가 준 코드를 그대로 올린다(UNKNOWN_COMMAND 등) — 프레임워크가 덧칠하면 원인이 흐려진다.
    fail(
      typeof replyValue.code === "string" ? replyValue.code : "BACKEND_ERROR",
      typeof replyValue.message === "string" ? replyValue.message : `백엔드가 거절했다: "${cmd}"`,
      cmd,
    );
  }

  /** 프레임워크 종료 시 연결을 놓는다. 대기 중이던 호출은 이름을 달고 깨어난다. */
  function close() {
    const s = sock;
    sock = null;
    if (s) s.destroy();
    rejectAll(DISCONNECTED, "프레임워크가 백엔드 연결을 닫았다");
  }

  return { call, close, onStream, socketPath };
}

module.exports = {
  createBackendClient,
  resolveSocketPath,
  SOCKET_ENV,
  SOCKET_ARG,
  DEFAULT_TIMEOUT_MS,
  BackendError,
};
