// @vitest-environment node
// Electron 셸의 백엔드 다리 — 소켓 왕복을 목 서버(node net)에 대고 검증한다.
//
// 셸은 띄우지 않는다. 다리(electron/backend.cjs)는 electron 을 require 하지 않으므로 여기서
// 그대로 몰 수 있고, Electron 을 띄워야만 검증되는 코드는 사실상 검증되지 않는다.
//
// 세 축을 고정한다: ① 백엔드가 없거나 모르면 **이름을 달고** 실패한다(조용한 no-op·가짜 성공
// 금지), ② 있으면 답이 온다, ③ 요구 원장이 서빙된 것과 못 한 것을 가른다 — 원장은 "헬퍼가
// 무엇을 더 져야 하는가"의 실측 근거이므로 실패 사유까지 남아야 쓸모가 있다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "../../electron/backend.cjs");
const { createBackendClient, resolveSocketPath, SOCKET_ENV, SOCKET_ARG } = requireCjs(BACKEND);

let root;
let servers;
let clients;
let demands;

/** 원장 싱크 — 셸에서는 jsonl 로 떨어지는 자리. 테스트는 그 자리에 배열을 꽂는다. */
const onDemand = (cmd, served, code) => demands.push({ cmd, served, code });

/** 목 백엔드: 한 줄 JSON 요청을 받아 handler 가 답한다. 연결 수를 센다(수명 검증용). */
function startMock(name, handler) {
  const socketPath = join(root, name);
  const conns = [];
  const seen = [];
  const server = net.createServer((sock) => {
    conns.push(sock);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        seen.push(req);
        handler(req, sock);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(socketPath, () => resolve({ socketPath, conns, seen })),
  );
}

const reply = (sock, obj) => sock.write(`${JSON.stringify(obj)}\n`);

function client(options) {
  const c = createBackendClient({ onDemand, ...options });
  clients.push(c);
  return c;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "soksak-electron-"));
  servers = [];
  clients = [];
  demands = [];
});

afterEach(() => {
  for (const c of clients) c.close();
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("소켓 경로 해소", () => {
  it("인자가 환경변수를 이긴다 — 더 구체적인 지목이 이긴다", () => {
    const path = resolveSocketPath({
      env: { [SOCKET_ENV]: "/env/one.sock" },
      argv: ["electron", "main.cjs", `${SOCKET_ARG}/arg/two.sock`],
    });
    expect(path).toBe("/arg/two.sock");
  });

  it("인자가 없으면 환경변수를 쓴다", () => {
    expect(resolveSocketPath({ env: { [SOCKET_ENV]: "/env/one.sock" }, argv: [] })).toBe(
      "/env/one.sock",
    );
  });

  it("둘 다 없으면 경로를 지어내지 않는다", () => {
    // 하드코딩된 기본 경로는 "붙은 척"을 만든다 — 없으면 없다고 답해야 한다.
    expect(resolveSocketPath({ env: {}, argv: [] })).toBe(null);
  });
});

describe("백엔드가 없을 때 — 이름을 달고 실패한다", () => {
  it("소켓 경로가 없으면 BACKEND_NOT_CONNECTED 와 경로를 주는 방법을 말한다", async () => {
    const c = client({ socketPath: null });
    const err = await c.call("data_kv_get", { key: "x" }).catch((e) => e);
    expect(err.code).toBe("BACKEND_NOT_CONNECTED");
    expect(err.command).toBe("data_kv_get");
    expect(err.message).toContain(SOCKET_ENV);
    expect(demands).toEqual([
      { cmd: "data_kv_get", served: false, code: "BACKEND_NOT_CONNECTED" },
    ]);
  });

  it("경로는 있는데 아무도 안 듣고 있으면 그 경로를 달고 실패한다", async () => {
    const dead = join(root, "nobody.sock");
    const c = client({ socketPath: dead });
    const err = await c.call("activity_publish", {}).catch((e) => e);
    expect(err.code).toBe("BACKEND_UNREACHABLE");
    expect(err.message).toContain(dead);
    expect(demands).toEqual([
      { cmd: "activity_publish", served: false, code: "BACKEND_UNREACHABLE" },
    ]);
  });
});

describe("백엔드가 있을 때 — 답이 온다", () => {
  it("명령과 인자가 한 줄 JSON 으로 가고 data 가 값으로 돌아온다", async () => {
    const mock = await startMock("ok.sock", (req, sock) =>
      reply(sock, { id: req.id, ok: true, data: { value: "42" } }),
    );
    const c = client({ socketPath: mock.socketPath });
    await expect(c.call("data_kv_get", { key: "x" })).resolves.toEqual({ value: "42" });
    expect(mock.seen).toHaveLength(1);
    expect(mock.seen[0].method).toBe("data_kv_get");
    expect(mock.seen[0].params).toEqual({ key: "x" });
    expect(typeof mock.seen[0].id).toBe("number");
    expect(demands).toEqual([{ cmd: "data_kv_get", served: true, code: undefined }]);
  });

  it("data 가 없는 봉투는 상관 id 를 벗겨서 준다 — 셸의 번호는 앱 값이 아니다", async () => {
    const mock = await startMock("bare.sock", (req, sock) =>
      reply(sock, { id: req.id, ok: true, reloaded: true }),
    );
    const c = client({ socketPath: mock.socketPath });
    await expect(c.call("window_reload", {})).resolves.toEqual({ ok: true, reloaded: true });
  });

  it("한 연결로 여러 호출을 다중화한다 — 답이 뒤바뀌어 와도 제 짝을 찾는다", async () => {
    const held = [];
    const mock = await startMock("mux.sock", (req, sock) => {
      held.push({ req, sock });
      // 두 요청이 다 도착하면 역순으로 답한다 — 순서가 아니라 id 가 짝을 정한다.
      if (held.length === 2) {
        for (const h of held.reverse()) {
          reply(h.sock, { id: h.req.id, ok: true, data: h.req.method });
        }
      }
    });
    const c = client({ socketPath: mock.socketPath });
    const [a, b] = await Promise.all([c.call("app_environment"), c.call("themes_scan")]);
    expect(a).toBe("app_environment");
    expect(b).toBe("themes_scan");
    expect(mock.conns).toHaveLength(1);
  });
});

describe("백엔드가 거절하거나 사라질 때 — 조용히 넘어가지 않는다", () => {
  it("모르는 명령은 백엔드가 준 코드 그대로 실패한다", async () => {
    const mock = await startMock("unknown.sock", (req, sock) =>
      reply(sock, {
        id: req.id,
        ok: false,
        code: "UNKNOWN_COMMAND",
        message: `모르는 명령: ${req.method}`,
      }),
    );
    const c = client({ socketPath: mock.socketPath });
    const err = await c.call("plugin_scan", {}).catch((e) => e);
    expect(err.code).toBe("UNKNOWN_COMMAND");
    expect(err.message).toContain("plugin_scan");
    expect(demands).toEqual([{ cmd: "plugin_scan", served: false, code: "UNKNOWN_COMMAND" }]);
  });

  it("봉투가 아닌 답은 성공으로 치지 않는다", async () => {
    const mock = await startMock("malformed.sock", (req, sock) =>
      reply(sock, { id: req.id, whatever: 1 }),
    );
    const c = client({ socketPath: mock.socketPath });
    const err = await c.call("app_is_release", {}).catch((e) => e);
    expect(err.code).toBe("BACKEND_MALFORMED_REPLY");
    expect(demands).toEqual([
      { cmd: "app_is_release", served: false, code: "BACKEND_MALFORMED_REPLY" },
    ]);
  });

  it("연결이 끊기면 대기 중 호출이 즉시 이름을 달고 깨어난다", async () => {
    const mock = await startMock("drop.sock", (_req, sock) => sock.destroy());
    const c = client({ socketPath: mock.socketPath, timeoutMs: 5000 });
    const err = await c.call("project_owners", {}).catch((e) => e);
    expect(err.code).toBe("BACKEND_DISCONNECTED");
    expect(demands).toEqual([
      { cmd: "project_owners", served: false, code: "BACKEND_DISCONNECTED" },
    ]);
  });

  it("끊긴 뒤 다음 호출은 다시 붙는다", async () => {
    let drop = true;
    const mock = await startMock("reconnect.sock", (req, sock) => {
      if (drop) {
        drop = false;
        sock.destroy();
        return;
      }
      reply(sock, { id: req.id, ok: true, data: "다시 붙었다" });
    });
    const c = client({ socketPath: mock.socketPath });
    await expect(c.call("net_http_request", {})).rejects.toMatchObject({
      code: "BACKEND_DISCONNECTED",
    });
    await expect(c.call("net_http_request", {})).resolves.toBe("다시 붙었다");
    expect(mock.conns).toHaveLength(2);
  });

  it("답이 없으면 영원히 기다리지 않고 타임아웃 이름을 단다", async () => {
    const mock = await startMock("silent.sock", () => {});
    const c = client({ socketPath: mock.socketPath, timeoutMs: 60 });
    const err = await c.call("process_reclaim_window", {}).catch((e) => e);
    expect(err.code).toBe("BACKEND_TIMEOUT");
    expect(err.message).toContain("process_reclaim_window");
    expect(demands).toEqual([
      { cmd: "process_reclaim_window", served: false, code: "BACKEND_TIMEOUT" },
    ]);
  });
});
