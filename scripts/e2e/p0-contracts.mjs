#!/usr/bin/env node
// P0 socket-contract E2E — asserts the boot/version/discovery contract of a running
// app over SOKSAK_SOCKET (JSON-RPC, newline-framed). Six checks, all read-only against
// the store so the run is idempotent and opens no windows:
//   a. system.hello answers at the transport with the full negotiation payload.
//   b. a request declaring protocol 999 is refused with VERSION_SKEW — a directional
//      sentence (both version numbers + the stale side) and a data triple of numbers;
//      a skewed events.subscribe is gated before it converts the connection to a push
//      stream, so the reply is VERSION_SKEW and never a `subscribed` ack (order pin).
//   c. a legacy request (no protocol field) passes the gate and executes.
//   d. system.hello is discoverable in the state.commands catalog.
//   e. window.snapshot captures a live render (size reported for eyeball sizing).
// The corrupt-DB backup-ring recovery contract is a separate lifecycle scenario
// (db-recovery.sh) because it restarts the app.
//
// Run: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/p0-contracts.mjs
// Optional: P0_EXPECT_LANG=ko|en requires the skew sentence to render in that language;
//           unset accepts either shipped skeleton (but still fails on a raw/untranslated one).
//           P0_SNAPSHOT_PATH overrides where the render capture is written.
// Exit: 0=GREEN (every check passed), 1=RED.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { frameColors } from "./lib/png.mjs";
import { requireSocket } from "./lib/client.mjs";

const SOCKET = requireSocket();
const SNAPSHOT_PATH =
  process.env.P0_SNAPSHOT_PATH || path.join(os.tmpdir(), "soksak-p0-contracts-snapshot.png");
const EXPECT_LANG = process.env.P0_EXPECT_LANG || ""; // "", "ko", or "en"

// ── socket RPC (same framing as e2e-driver.mjs) ──────────────────────────────
let sock;
let seq = 0;
const pending = new Map();
let buf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}
// Returns the raw response envelope (no data flattening — the checks assert on the
// envelope shape itself: ok/code/message/data). `extra` merges top-level request
// fields such as `protocol`.
function rpc(method, params = {}, extra = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params, ...extra }) + "\n", (err) => {
      if (err) {
        pending.delete(id);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 15000);
  });
}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
  return cond;
}

async function main() {
  await connect();
  console.log(`P0 socket-contract E2E\nsocket: ${SOCKET}\n`);

  // ── a. system.hello negotiation payload ────────────────────────────────────
  console.log("a. system.hello negotiation payload");
  const hello = await rpc("system.hello");
  ok(hello.ok === true, "hello ok:true");
  ok(Number.isInteger(hello.protocol), `protocol present (${hello.protocol})`);
  ok(Number.isInteger(hello.minClientProtocol), `minClientProtocol present (${hello.minClientProtocol})`);
  ok(typeof hello.appVersion === "string" && hello.appVersion.length > 0, `appVersion present (${hello.appVersion})`);
  ok(typeof hello.identity === "string" && hello.identity.length > 0, `identity present (${hello.identity})`);
  ok(Number.isInteger(hello.pid) && hello.pid > 0, `pid present (${hello.pid})`);
  ok(Number.isInteger(hello.startedAt) && hello.startedAt > 0, `startedAt present (${hello.startedAt})`);
  ok(
    Array.isArray(hello.capabilities) && hello.capabilities.includes("hello.v1"),
    `capabilities carries hello.v1 (${JSON.stringify(hello.capabilities)})`,
  );

  // ── b. VERSION_SKEW gate: protocol 999 ─────────────────────────────────────
  console.log("\nb. VERSION_SKEW gate (protocol 999)");
  const skew = await rpc("state.commands", {}, { protocol: 999 });
  ok(skew.ok === false, "skewed request refused (ok:false)");
  ok(skew.code === "VERSION_SKEW", `code VERSION_SKEW (${skew.code})`);
  const s = String(skew.message ?? "");
  ok(s.includes("999") && s.includes("1"), `sentence names both version numbers (${JSON.stringify(s)})`);
  const looksKo = s.includes("소켓 프로토콜") && s.includes("업데이트");
  const looksEn = s.includes("socket protocol") && s.includes("update");
  ok(looksKo || looksEn, "sentence is i18n-rendered, not raw");
  const lang = looksKo ? "ko" : looksEn ? "en" : "?";
  console.log(`    detected language: ${lang}`);
  if (EXPECT_LANG) ok(lang === EXPECT_LANG, `sentence renders in expected language ${EXPECT_LANG}`);
  const d = skew.data ?? {};
  ok(d.appProtocol === hello.protocol, `data.appProtocol == app protocol (${d.appProtocol})`);
  ok(Number.isInteger(d.minClientProtocol), `data.minClientProtocol present (${d.minClientProtocol})`);
  ok(d.clientProtocol === 999, `data.clientProtocol == 999 (${d.clientProtocol})`);

  // events.subscribe is a transport-level method: on a compatible peer it answers a
  // `subscribed` ack and turns the connection into a push stream. The version gate must
  // intercept it before that conversion, so a skewed subscribe comes back as a plain
  // VERSION_SKEW envelope and never opens a stream. This pins the gate-before-subscribe
  // order — a refactor that moves the subscribe branch ahead of the gate fails here.
  // The skewed request stays a normal request/response (no stream), so the shared
  // connection is undisturbed for the checks that follow.
  const subSkew = await rpc("events.subscribe", {}, { protocol: 999 });
  ok(subSkew.ok === false, "skewed events.subscribe refused (ok:false)");
  ok(subSkew.code === "VERSION_SKEW", `events.subscribe skew code VERSION_SKEW (${subSkew.code})`);
  ok(subSkew.subscribed !== true, "skewed events.subscribe opened no stream (no subscribed ack)");

  // ── c. legacy quadrant: no protocol field passes ───────────────────────────
  console.log("\nc. legacy passthrough (no protocol field)");
  const legacy = await rpc("activity.recent", { limit: 1 });
  ok(legacy.ok === true, `legacy request executes (ok:true, code ${legacy.code})`);
  ok(legacy.code !== "VERSION_SKEW", "legacy request not skew-gated");

  // ── d. hello discoverability in the command catalog ────────────────────────
  console.log("\nd. system.hello discoverable in state.commands");
  const cmds = await rpc("state.commands");
  const list = (cmds.data && cmds.data.commands) || cmds.commands || [];
  const names = new Set(list.map((c) => c && c.name));
  ok(names.has("system.hello"), `catalog carries system.hello (of ${names.size} commands)`);

  // ── e. live render snapshot ────────────────────────────────────────────────
  console.log("\ne. window.snapshot live render");
  try {
    fs.rmSync(SNAPSHOT_PATH, { force: true });
  } catch {}
  const snap = await rpc("window.snapshot", { path: SNAPSHOT_PATH });
  ok(snap.ok === true, `snapshot ok:true (code ${snap.code})`);
  const exists = fs.existsSync(SNAPSHOT_PATH);
  ok(exists, `snapshot file written: ${SNAPSHOT_PATH}`);
  if (exists) {
    // 백지 판정은 **픽셀로** 한다. 파일 크기는 프록시일 뿐이라, 실제로 그려졌지만 성긴 화면
    // (프롬프트만 있는 터미널)을 백지로 오판한다 — 실측(2026-07-29): 전 화면이 그려진 프레임이
    // 57KB 였다. 그 오판은 "렌더가 안 됐다"로 읽혀 원인을 엉뚱한 데서 찾게 만든다.
    const bytes = fs.statSync(SNAPSHOT_PATH).size;
    const { colors, w, h } = frameColors(fs.readFileSync(SNAPSHOT_PATH));
    console.log(`    snapshot ${w}x${h}, ${bytes} bytes — 표본 색 ${colors}가지 (1가지=백지)`);
    ok(colors > 8, `snapshot is not a blank frame (표본 색 ${colors}가지)`);
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(1);
});
