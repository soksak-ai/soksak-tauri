#!/usr/bin/env node
// 복원-로딩 E2E — 재부팅 복원(window.reload = 같은 label 로 렌더러 재부팅 → 스냅샷 복원)
// 뒤에 모든 탭이 "실제로 로드"되는지를 픽셀로 판정한다.
//
// RED 근거(사용자 실측, 2026-07-26): 복원된 파일 탭이 "이 파일은 표시할 수 없습니다
// (No such file or directory)" 죽은 카드로 깨어났다(상대경로 영속 — 경계는 e5cd2d09 로
// 막았지만, 복원-로딩 축 전반의 게이트는 없었다). "탭 제목이 복원됐다"는 "내용이 로드됐다"
// 를 대신하지 못한다 — 각 탭을 활성화해 본문 픽셀이 실콘텐츠인지 본다(browser-restore 의
// 판정 철학, 창 재시작 없이 창 단위로).
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/restore-load 전용 창. 끝나면 창을 닫는다.
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/restore-load.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { resolveControlWindow } from "./lib/client.mjs";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "restore-load");

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
    }, 40000);
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

/** 본문 rect 의 실렌더 판정 — 유니크 그레이 수(browser-pixels 의 철학). 죽은 카드(중앙
 *  문구 한 줄)와 빈 본문은 유니크가 낮고, 실제 파일 내용·터미널 프롬프트는 높다. */
function uniqueLevels(png) {
  const set = new Set();
  for (let i = 0; i < png.px.length; i += png.ch) set.add(png.px[i] >> 2);
  return set.size;
}

async function bodyPng(win, tabId) {
  // 측정과 캡처는 간헐 실패할 수 있다(활성 전환 직후 파킹 rect·컴포지터 타이밍) — 측정까지
  // 재시도 루프 안에 둔다(무효 rect 를 들고 캡처만 재시도하면 같은 실패를 반복한다 — 실측:
  // "빈/무효 crop rect" INTERNAL). 유한 재시도, 실패 사유는 그대로 싣는다.
  let lastReply = null;
  for (let i = 0; i < 5; i++) {
    const m = await rpc("ui.measure", { address: `win/${win}/chrome/layout/tab/${tabId}` }, win);
    const r = (m.data ?? m).rect;
    if (r && r.w > 4 && r.h > 4) {
      const shot = await rpc(
        "window.snapshot",
        { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } },
        win,
      );
      const b64 = shot.media?.base64 ?? shot.data?.media?.base64 ?? shot.base64;
      if (b64) return decodePng(Buffer.from(b64, "base64"));
      lastReply = shot;
    } else lastReply = m;
    await sleep(400);
  }
  throw new Error(`본문 캡처 실패: ${JSON.stringify(lastReply).slice(0, 200)}`);
}

async function main() {
  await connect();
  console.log(`restore-load E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });
  // 파일 탭의 실콘텐츠 — 여러 줄이어야 유니크 판정이 유효하다.
  const filePath = path.join(FIXTURE, "sample.md");
  fs.writeFileSync(
    filePath,
    "# restore-load fixture\n\n" +
      Array.from({ length: 30 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n") +
      "\n",
  );

  // 잔재 창 회수(멱등).
  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("restore-load"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. build a window: terminal + file tab");
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  ok(typeof win === "string" && win.startsWith("w-"), `window opened (${win})`);
  let term = null;
  for (let i = 0; i < 40 && !term; i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? null;
    if (!term) await sleep(500);
  }
  ok(!!term, `terminal program (${term})`);
  const tTerm = data(await rpc("tab.open", { program: term }, win)).tabId;
  const fileOpen = data(await rpc("ui.intent.open", { path: filePath }, win));
  const tFile = fileOpen.tabId;
  ok(typeof tFile === "string", `file tab (${tFile})`, JSON.stringify(fileOpen));
  await sleep(1500); // 마운트·영속 정착

  try {
    // 복원 전 기준 픽셀 — 각 탭을 활성화해 본문을 굽는다.
    const before = {};
    for (const [name, tab] of [["file", tFile], ["terminal", tTerm]]) {
      await rpc("tab.activate", { tab }, win);
      await sleep(800);
      before[name] = uniqueLevels(await bodyPng(win, tab));
      ok(before[name] >= 6, `${name} renders before restore (unique=${before[name]})`);
    }

    console.log("\nb. restore (window.reload) and verify every tab loads");
    {
      // 진단 — reload 가 읽을 스냅샷이 실제로 서 있는가(없으면 실패의 원인은 저장 축이다).
      const kv = await rpc("data.kv.get", { ns: "core", key: `window/${win}` }, win).catch(() => null);
      const v = kv && (kv.data ?? kv).value;
      console.log(`   snapshot kv: ${v ? `${String(v).length}B` : "absent"} ${v ? JSON.stringify(String(v)).slice(0, 160) : ""}`);
      const pre = data(await rpc("state.tree", {}, win));
      const preTabs = (pre.projects ?? []).flatMap((p) => (p.spaces ?? []).flatMap((sp) => (sp.panes ?? []).flatMap((pa) => pa.tabs ?? [])));
      console.log(`   tabs before reload: ${preTabs.length}`);
    }
    await rpc("window.reload", {}, win).catch(() => {
      /* 렌더러 재부팅 중 회신 유실은 정상 — 소켓은 앱이 쥐고 있다 */
    });
    // 재부팅 대기 — 복원 "완료"까지다: 프로그램 등록(플러그인 호스트)은 복원보다 먼저 서는
    // 부트 순서라, programs 만 기다리면 복원 전 빈 트리를 읽는다(실측: restore:done:true 인데
    // 하니스는 탭 0 — 가짜 RED). 탭 등장이 복원 완료의 사실이다(부팅 한정 유한 재시도).
    let tabs = [];
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const tree = data(await rpc("state.tree", {}, win).catch(() => null));
      tabs = [];
      for (const p of tree.projects ?? [])
        for (const sp of p.spaces ?? [])
          for (const pa of sp.panes ?? []) for (const t of pa.tabs ?? []) tabs.push(t);
      if (tabs.length >= 2) break;
    }
    ok(tabs.length >= 2, `tabs survived restore (${tabs.length})`);

    for (const t of tabs) {
      await rpc("tab.activate", { tab: t.id }, win);
      // 로드는 사건이 아니라 결과로 본다 — 픽셀이 설 때까지 완만 재시도(상한 8s).
      let u = 0;
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        u = uniqueLevels(await bodyPng(win, t.id));
        if (u >= 6) break;
      }
      ok(
        u >= 6,
        `restored tab loads: ${t.kind}${t.path ? ` ${path.basename(String(t.path))}` : ""} (unique=${u})`,
      );
    }
  } finally {
    if (process.env.RESTORE_LOAD_KEEP) console.log(`   kept window for autopsy: ${win}`);
    else await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
