// @vitest-environment node
// 제어면 왕복 — 밖에서 부른 명령이 창에 닿고, 창의 답이 부른 쪽으로 돌아온다.
//
// **목 서버를 쓰지 않는다.** 여기서 증명할 것은 "중계가 자기 목과 잘 논다"가 아니라 러스트
// cored 와 Node 중계가 **같은 계약을 본다**는 것이다. 목을 세우면 계약을 내가 두 번 쓰게 되고,
// 두 벌은 갈리는 순간까지 조용하다. 그래서 실제 바이너리를 띄운다.
//
// Electron 은 띄우지 않는다. 중계(electron/control.cjs)는 electron 을 require 하지 않으므로
// 창 자리에 스텁을 꽂으면 그대로 몰 수 있고, 프레임워크를 띄워야만 검증되는 코드는 사실상
// 검증되지 않는다.
//
// 회신 경로는 중계가 아니라 **명령 다리**다(창의 실행기가 invoke("cmd_result")를 부른다).
// 그래서 이 검사도 그 다리로 답한다 — 중계에 돌아오는 길을 만들면 명령 하나가 두 길로 답한다.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const { createControlHost, CMD_REQUEST } = requireCjs(join(ROOT, "electron/control.cjs"));
const { createBackendClient } = requireCjs(join(ROOT, "electron/backend.cjs"));
const { coredBinary, ensureCored } = requireCjs(join(ROOT, "electron/cored.cjs"));

/** 답이 안 오면 무한정 기다리지 않는다 — 붙지 않은 검사는 실패로 드러나야 한다. */
const PATIENCE_MS = 10_000;

let root;
let cored;
let hosts;
let clients;

/** 한 줄을 보내고 한 줄을 받는다 — 밖에서 부르는 쪽(하니스·sok)의 최소형. */
function askRaw(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`응답 없음(${PATIENCE_MS}ms): ${req.method}`));
    }, PATIENCE_MS);
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const at = buf.indexOf("\n");
      if (at < 0) return;
      clearTimeout(timer);
      sock.destroy();
      resolve(JSON.parse(buf.slice(0, at)));
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 창 스텁 — 배달을 받아 쌓고, 다음 배달을 기다릴 수 있다. */
function windowStub() {
  const got = [];
  const waiters = [];
  return {
    got,
    take(payload) {
      got.push(payload);
      waiters.shift()?.(payload);
      return true;
    },
    next() {
      const hit = got[got.length - 1];
      if (hit && !hit.__taken) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("배달이 창에 오지 않았다")), PATIENCE_MS);
        waiters.push((p) => {
          clearTimeout(timer);
          resolve(p);
        });
      });
    },
  };
}

/** 등록이 설 때까지 기다린다 — cored 의 등록 응답이 신호다(되물어 보지 않는다). */
async function whenAttached(host) {
  expect(await host.ready).toBe(true);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "soksak-control-"));
  hosts = [];
  clients = [];
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  cored = await ensureCored({
    identity: {
      identifier: "com.soksak.control-test",
      home,
      socketPath: join(root, "c.sock"),
    },
    binary: coredBinary({ root: ROOT }),
  });
});

afterEach(async () => {
  for (const h of hosts) h.stop();
  for (const c of clients) c.close?.();
  await cored?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("제어면 중계", () => {
  it("붙기 전에는 앱 명령이 이름을 달고 거절된다", async () => {
    const r = await askRaw(cored.socketPath, { id: 1, method: "project.open" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_COMMAND");
  });

  it("밖에서 부른 명령이 창에 닿고 창의 답이 부른 쪽으로 돌아온다", async () => {
    const win = windowStub();
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live: ["main"], focused: "main" }),
      deliver: (label, payload) => (label === "main" ? win.take(payload) : false),
    }).start();
    hosts.push(host);
    await whenAttached(host);

    // 밖에서 부른다 — 답은 창이 회신할 때까지 오지 않는다.
    const caller = askRaw(cored.socketPath, {
      id: 7,
      method: "project.open",
      params: { root: "/p" },
      timeoutMs: 8000,
    });

    const got = await win.next();
    // 인자가 **그대로** 온다. 이름을 바꾸거나 값을 채우면 앱의 실행기가 다른 것을 받는다.
    expect(got.method).toBe("project.open");
    expect(got.params).toEqual({ root: "/p" });
    expect(got.window).toBe("main");
    expect(typeof got.id).toBe("number");

    // 회신은 **명령 다리**로 간다 — 창의 실행기가 invoke("cmd_result") 를 부르는 그 길.
    const bridge = createBackendClient({ socketPath: cored.socketPath });
    clients.push(bridge);
    const matched = await bridge.call("cmd_result", {
      id: got.id,
      result: { ok: true, data: { opened: "/p" } },
    });
    expect(matched).toBe(true);

    const reply = await caller;
    expect(reply.ok).toBe(true);
    expect(reply.data.opened).toBe("/p");
    expect(reply.id).toBe(7);
  });

  it("cored 가 서빙하는 이름은 붙어 있어도 cored 가 답한다", async () => {
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live: ["main"], focused: "main" }),
      deliver: () => true,
    }).start();
    hosts.push(host);
    await whenAttached(host);

    const r = await askRaw(cored.socketPath, { method: "cored.commands" });
    expect(r.ok).toBe(true);
    const names = r.data.commands.map((c) => c.name);
    expect(names).toContain("cmd_result");
  });

  it("지목한 창이 없으면 거절한다 — 아무 창에나 보내지 않는다", async () => {
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live: ["main"], focused: "main" }),
      deliver: () => true,
    }).start();
    hosts.push(host);
    await whenAttached(host);

    const r = await askRaw(cored.socketPath, {
      method: "project.open",
      window: "w-nope",
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WINDOW_NOT_FOUND");
  });

  // 실측 회귀(2026-07-29): 렌더러가 다리로 물은 pty_pane_alive 를 cored 가 창으로 되돌렸고,
  // (그 이름은 이제 서빙된다 — 여기서는 아직 서빙하지 않는 이름으로 같은 갈래를 잰다.)
  // 그 창이 바로 물어본 쪽이라 회신이 오지 않아 10초를 기다렸다. 이름 대신 상한이 나오면
  // 부른 쪽은 "느리다"로 읽고, 진짜 사실("이 프로세스가 안 서빙한다")은 사라진다.
  it("창의 다리로 물은 것은 창으로 되돌리지 않는다 — 상한이 아니라 이름으로 답한다", async () => {
    const win = windowStub();
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live: ["main"], focused: "main" }),
      deliver: (label, payload) => win.take(payload),
    }).start();
    hosts.push(host);
    await whenAttached(host);

    const bridge = createBackendClient({
      socketPath: cored.socketPath,
      announce: ["control_bridge_attach"],
      timeoutMs: 4000,
    });
    clients.push(bridge);
    await expect(bridge.call("process_reclaim_window", { window: "w-1" })).rejects.toMatchObject({
      code: "NOT_SERVED_HERE",
    });
    // 되돌리지 않았다는 것을 창이 증언한다 — 배달이 하나도 없어야 한다.
    expect(win.got).toEqual([]);
  });

  it("밝히지 않은 다리는 밖이다 — 그쪽 요청은 그대로 창으로 간다", async () => {
    const win = windowStub();
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live: ["main"], focused: "main" }),
      deliver: (label, payload) => win.take(payload),
    }).start();
    hosts.push(host);
    await whenAttached(host);

    const outside = createBackendClient({ socketPath: cored.socketPath, timeoutMs: 4000 });
    clients.push(outside);
    void outside.call("project.open", { root: "/p" }).catch(() => {});
    const got = await win.next();
    expect(got.method).toBe("project.open");
  });

  it("창 사실이 바뀌면 새 창이 타겟이 된다", async () => {
    let live = ["main"];
    let focused = "main";
    const win = windowStub();
    const host = createControlHost({
      socketPath: cored.socketPath,
      facts: () => ({ live, focused, lastWorkspace: null }),
      deliver: (label, payload) => win.take({ ...payload, at: label }),
    }).start();
    hosts.push(host);
    await whenAttached(host);

    live = ["main", "w-1"];
    focused = "w-1";
    host.windowsChanged();

    const caller = askRaw(cored.socketPath, { method: "x.y", timeoutMs: 3000 });
    const got = await win.next();
    // 갱신을 안 알리면 여전히 main 이 답한다 — 그 오답은 오류로 보이지 않는다.
    expect(got.at).toBe("w-1");

    const bridge = createBackendClient({ socketPath: cored.socketPath });
    clients.push(bridge);
    await bridge.call("cmd_result", { id: got.id, result: { ok: true, data: null } });
    expect((await caller).ok).toBe(true);
  });
});
