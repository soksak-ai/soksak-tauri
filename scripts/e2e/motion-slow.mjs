#!/usr/bin/env node
// 모션 관측(ui.motion) E2E — 감속과 정지가 "화면의 활강 본체"에 실제로 걸리는지 픽셀로 판정한다.
//
// RED 근거(사용자 실측, 2026-07-26): DEV 배지의 슬로우 패널에서 1/50 을 눌러도 레이아웃
// 활강(tab.maximize 등)이 원속으로 끝났다. ui.motion 자체는 applied·rates=[0.02] 를
// 보고했지만 그것은 커서 블링크 같은 문서 애니메이션의 사실이었고, 활강 본체는 잡히지
// 않았다(maximize 직후 running:0, 1/50 인데 record 프레임 diff 전부 0 — 즉시 완료).
// "설정이 섰다"는 "느려졌다"를 대신하지 못한다 — 이 하니스는 결과(픽셀 진행)를 단언한다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/motion-slow 전용 창을 열고, 끝나면 모션 설정을 원복하고
// 창을 닫는다. 사용자 창은 손대지 않는다(feedback_no-touching-user-window).
//
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/motion-slow.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "motion-slow");
const SCALE = 50;

let sock;
let seq = 0;
const pending = new Map();
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET, () => resolve());
    sock.on("error", reject);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const r = pending.get(msg.id);
          if (r) {
            pending.delete(msg.id);
            r(msg);
          }
        } catch {
          /* partial */
        }
      }
    });
  });
}
function rpc(method, params = {}, window) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const req = { id, method, params };
    if (window) req.window = window;
    sock.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 30000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = (r) => r?.data ?? r ?? {};

let pass = 0;
let fail = 0;
function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// browser-pixels 와 동일한 자급 PNG 판독(공유 모듈 없음 — 하니스는 각자 완결).
function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let ch = 4;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[body[9]] ?? 4;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 0xff;
      else if (f === 2) line[x] = (line[x] + b) & 0xff;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      prev[x] = line[x];
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, ch, px: out };
}

// 두 프레임의 상이 픽셀 수(그레이 근사, 8 단계 임계 — 노이즈 무시).
function diffPixels(a, b) {
  if (!a || !b || a.px.length !== b.px.length) return -1;
  let n = 0;
  for (let i = 0; i < a.px.length; i += a.ch) {
    if (Math.abs(a.px[i] - b.px[i]) > 8) n++;
  }
  return n;
}

async function snapshotPng(win) {
  const r = await rpc("window.snapshot", { base64: true }, win);
  const b64 = r.media?.base64 ?? r.data?.media?.base64 ?? r.base64;
  if (!b64) throw new Error("스냅샷 base64 없음");
  return decodePng(Buffer.from(b64, "base64"));
}

async function main() {
  await connect();
  console.log(`motion-slow E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });

  // 잔재 창 회수(멱등) — 이 픽스처 루트를 든 창이 남아 있으면 닫는다.
  {
    const wl = data(await rpc("window.list", {}, "main")).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("motion-slow"))) {
        await rpc("window.close", { label: l }, "main").catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. fixture window");
  const opened = data(await rpc("window.open", { root: FIXTURE }));
  const win = opened.label || opened.existingWindow;
  ok(typeof win === "string" && win.startsWith("w-"), `window opened (${win})`);

  // 프로그램 적재 대기(부팅 한정 유한 재시도) 후 탭 2개 — maximize 활강의 무대.
  let term = null;
  for (let i = 0; i < 40 && !term; i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? null;
    if (!term) await sleep(500);
  }
  ok(!!term, `terminal program (${term})`);
  const t1 = data(await rpc("tab.open", { program: term }, win)).tabId;
  await rpc("pane.split", { side: "right", program: term }, win);
  ok(typeof t1 === "string", `tabs ready (${t1})`);
  await sleep(1200); // 초기 마운트 정착

  try {
    // ── A. 감속: 1/50 에서 maximize 활강이 실제로 느리게 "진행"해야 한다 ────────────
    console.log("\nb. slow (1/50) — the glide itself must stretch");
    await rpc("ui.motion", { scale: SCALE }, win);
    // record 를 먼저 걸고(비동기 수집) 활강을 유발 — 원속(수백 ms)이면 프레임 diff 가
    // 앞 1~2 프레임에만 몰리고, 1/50 이면 수 초에 걸쳐 여러 프레임에 번진다.
    const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-slow-"));
    const recP = rpc("window.record", { dir: recDir, frames: 8, intervalMs: 350 }, win);
    await sleep(120);
    await rpc("tab.maximize", { tab: t1 }, win);
    await sleep(300);
    const live = data(await rpc("ui.motion", {}, win));
    const walls = (live.animations || []).map((a) => a.wallMs ?? 0);
    ok(
      (live.running ?? 0) > 0 && walls.some((w) => w >= 3000),
      "glide animation is captured and stretched (wallMs ≥ 3s)",
      `running=${live.running} walls=${JSON.stringify(walls)}`,
    );
    await recP;
    const frames = fs
      .readdirSync(recDir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => decodePng(fs.readFileSync(path.join(recDir, f))));
    const diffs = [];
    for (let i = 1; i < frames.length; i++) diffs.push(diffPixels(frames[i - 1], frames[i]));
    const moving = diffs.filter((d) => d > 50).length;
    ok(
      moving >= 3,
      "pixels keep progressing across frames (slowed, not instant)",
      `diffs=${JSON.stringify(diffs)}`,
    );
    fs.rmSync(recDir, { recursive: true, force: true });

    // 활강 완주 대기(감속이 걸려 있으면 길다) 후 원복.
    await rpc("ui.motion", { scale: 1 }, win);
    await rpc("tab.restore", {}, win);
    await sleep(800);

    // ── B. 정지: hold 는 화면을 실제로 얼려야 한다 ────────────────────────────────
    console.log("\nc. hold — the frozen frame must not advance");
    await rpc("ui.motion", { hold: true }, win);
    await rpc("tab.maximize", { tab: t1 }, win);
    await sleep(250);
    const f1 = await snapshotPng(win);
    await sleep(500);
    const f2 = await snapshotPng(win);
    const held = diffPixels(f1, f2);
    ok(held >= 0 && held < 50, "held frames are identical", `diff=${held}`);
    await rpc("ui.motion", { hold: false, scale: 1 }, win);
    await sleep(800);
    const done = data(await rpc("ui.motion", {}, win));
    ok((done.running ?? 0) === 0 || (done.rates || []).every((r) => r === 1), "release lands");
  } finally {
    // 원복 — 설정과 창 둘 다(멱등). 실패해도 다음 실행의 회수 단계가 걷는다.
    await rpc("ui.motion", { scale: 1, hold: false }, win).catch(() => {});
    await rpc("window.close", { label: win }, "main").catch(() => {});
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
