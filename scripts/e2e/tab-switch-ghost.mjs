#!/usr/bin/env node
// 탭 포커스 이동 잔상 E2E — 전환·왕복에서 "이동하는 탭"의 픽셀이 남지 않는지를 판정한다.
//
// 배경(사용자 지적, 2026-07-26): slot-freeze 는 native 브라우저 엔진의 특정 활강 시나리오만
// 덮는다 — 일반 탭 전환(터미널·파일 조합)의 잔상 축은 게이트가 없었다. 잔상의 픽셀 정의는
// 왕복 재현성이다: A→B→A 뒤의 A 가 처음의 A 와 같아야 한다(다르면 B 의 픽셀이 남았거나
// A 가 되살아나지 못한 것). 구조 축은 파킹 계약이다: 비활성 탭 슬롯은 화면 밖에 있어야
// 한다(남아 있으면 그 자체가 잔상의 원인).
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/tab-ghost 전용 창. 끝나면 창을 닫는다.
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/tab-switch-ghost.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { resolveControlWindow } from "./lib/client.mjs";

import { decodePng } from "./lib/png.mjs";
const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "tab-ghost");
const ROUNDS = 4;

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


function diffPixels(a, b) {
  if (!a || !b || a.px.length !== b.px.length) return -1;
  let n = 0;
  for (let i = 0; i < a.px.length; i += a.ch) {
    if (Math.abs(a.px[i] - b.px[i]) > 8) n++;
  }
  return n;
}

async function measureTab(win, tabId) {
  const m = await rpc("ui.measure", { address: `win/${win}/chrome/layout/tab/${tabId}` }, win);
  return (m.data ?? m).rect ?? null;
}

async function bodyPng(win, tabId) {
  let last = null;
  for (let i = 0; i < 5; i++) {
    const r = await measureTab(win, tabId);
    if (r && r.w > 4 && r.h > 4) {
      const shot = await rpc(
        "window.snapshot",
        { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } },
        win,
      );
      const b64 = shot.media?.base64 ?? shot.data?.media?.base64 ?? shot.base64;
      if (b64) return decodePng(Buffer.from(b64, "base64"));
      last = shot;
    } else last = r;
    await sleep(400);
  }
  throw new Error(`본문 캡처 실패: ${JSON.stringify(last).slice(0, 160)}`);
}

/** 움직이는 장식(파티클)을 소거한 안정 본문 — 같은 상태에서 3프레임을 찍어 픽셀별 중앙값.
 *  꽃잎은 프레임마다 자리가 달라 중앙값에서 배경으로 수렴하고, 내용(터미널·파일)은 남는다.
 *  (실측: 단일 프레임 비교는 내용 동일에도 33% 상이 — 궤적 오염.) */
async function stablePng(win, tabId) {
  const shots = [];
  for (let i = 0; i < 3; i++) {
    shots.push(await bodyPng(win, tabId));
    await sleep(150);
  }
  const [a, b, c] = shots;
  const out = Buffer.alloc(a.px.length);
  for (let i = 0; i < a.px.length; i++) {
    const x = a.px[i];
    const y = b.px[i];
    const z = c.px[i];
    out[i] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z)); // median3
  }
  return { w: a.w, h: a.h, ch: a.ch, px: out };
}

async function main() {
  await connect();
  console.log(`tab-switch-ghost E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });
  const filePath = path.join(FIXTURE, "ghost.md");
  fs.writeFileSync(
    filePath,
    "# ghost fixture\n\n" +
      Array.from({ length: 40 }, (_, i) => `row ${i}: pack my box with five dozen liquor jugs`).join("\n") +
      "\n",
  );

  // 잔재 창 회수(멱등).
  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("tab-ghost"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. one pane, two very different tabs (terminal + file)");
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  ok(typeof win === "string" && win.startsWith("w-"), `window opened (${win})`);
  let term = null;
  for (let i = 0; i < 40 && !term; i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? null;
    if (!term) await sleep(500);
  }
  // 열기는 응답을 확인하고 유한 재시도한다 — 부팅 직후 첫 요청이 간헐 실패하면(실측:
  // tabs (undefined, undefined) 1/4 런) 이후 모든 단언이 무의미한 연쇄 실패가 된다.
  const openTab = async (fn) => {
    for (let i = 0; i < 5; i++) {
      const r = await fn();
      const id = (r.data ?? r).tabId;
      if (r.ok !== false && typeof id === "string") return id;
      await sleep(700);
    }
    throw new Error("tab open 실패(5회)");
  };
  const tA = await openTab(() => rpc("tab.open", { program: term }, win));
  const tB = await openTab(() => rpc("ui.intent.open", { path: filePath }, win));
  ok(typeof tA === "string" && typeof tB === "string", `tabs (${tA}, ${tB})`);
  await sleep(1500);

  try {
    // 기준 픽셀.
    await rpc("tab.activate", { tab: tA }, win);
    await sleep(700);
    const baseA = await stablePng(win, tA);
    await rpc("tab.activate", { tab: tB }, win);
    await sleep(700);
    const baseB = await stablePng(win, tB);
    const apart = diffPixels(baseA, baseB);
    ok(apart > 2000, `the two tabs render differently (diff=${apart})`);

    console.log(`\nb. round-trips ×${ROUNDS} — return must reproduce, parking must hold`);
    let worstBack = 0;
    let worstPng = null;
    for (let i = 0; i < ROUNDS; i++) {
      await rpc("tab.activate", { tab: tA }, win);
      await sleep(600);
      const backA = await stablePng(win, tA);
      const dd = diffPixels(baseA, backA);
      if (dd > worstBack) {
        worstBack = dd;
        worstPng = backA;
      }
      // 파킹 계약 — 판정 축은 계약 그 자체(computed)다: visibility:hidden + transform
      // 오프스크린(layerPark 단일 진실). rect 는 판정 축이 아니다 — WebKit 은
      // content-visibility:hidden 서브트리의 gBCR 에 transform 을 반영하지 않는다(실측:
      // matrix(-1600) 이 서 있는데 rect.x=340 — rect 오라클이 가짜 RED 를 냈다).
      const parkedOf = async (tabId) => {
        const snap = data(
          await rpc(
            "ui.snapshot.dom",
            { filter: `layout/tab/${tabId}`, props: ["visibility", "transform", "display"] },
            win,
          ),
        );
        const st = (snap.nodes ?? [])[0]?.style ?? {};
        return (
          st.display === "none" ||
          (st.visibility === "hidden" && st.transform && st.transform !== "none")
        );
      };
      ok(await parkedOf(tB), `round ${i + 1}: inactive tab is parked (computed contract)`);
      await rpc("tab.activate", { tab: tB }, win);
      await sleep(600);
      ok(await parkedOf(tA), `round ${i + 1}: previous tab is parked (computed contract)`);
    }
    // 파킹-크로싱 부재 — 탭 교체의 파킹 이동(layerPark = 화면 좌측 밖 -200vw)은 레이아웃
    // 모션이 아니다: FLIP 이 이걸 보간하면 슬롯이 화면을 가로질러 날며 "a↔b 가 두 번
    // 교체되는" 이중 모션·겹침이 된다(사용자 실측 2026-07-27, 여정 원장으로 실증). 판정은
    // 모션 여정 원장(ui.motion.journeys — 렌더러가 스스로 기록한 from→to)이다: 출발이든
    // 도착이든 좌측 화면 밖 rect(x+w≤0)가 실린 여정 = 파킹이 보간된 회귀.
    {
      const mo = data(await rpc("ui.motion", {}, win));
      const offLeft = (r) => r && r.x + r.w <= 0;
      const crossing = (mo.journeys ?? []).filter((j) => offLeft(j.from) || offLeft(j.to));
      ok(
        crossing.length === 0,
        `no park-crossing journeys (journeys=${(mo.journeys ?? []).length})`,
        JSON.stringify(crossing.slice(0, 3)),
      );
    }
    // 왕복 재현성(상대 판정) — 절대 diff 는 파티클(벚꽃 등 장식 오버레이)이 오염시킨다
    // (실측: 내용 동일한데 33% 상이 — 증거 PGM 판독으로 꽃잎 궤적 확인). 잔상의 정의는
    // "B 의 픽셀이 남았다"이므로, 복귀한 A 가 기준 A 보다 B 에 가까워졌는지를 본다:
    // 파티클은 양쪽 비교에 공평하게 실리고, 잔상만 B 쪽 거리를 줄인다.
    const toBase = worstBack;
    const toB = worstPng ? diffPixels(worstPng, baseB) : Infinity;
    ok(
      toB > toBase * 1.5,
      `returning tab is still itself, not the other tab (dA=${toBase}, dB=${toB})`,
    );
    if (toB <= toBase * 1.5 && worstPng) {
      const dir = path.join(os.tmpdir(), "tab-ghost-evidence");
      fs.mkdirSync(dir, { recursive: true });
      const dump = (name, png) => {
        // 원시 그레이 PGM — PNG 인코더 없이 눈으로 볼 수 있는 최소 형식.
        const hdr = Buffer.from(`P5\n${png.w} ${png.h}\n255\n`);
        const g = Buffer.alloc(png.w * png.h);
        for (let i = 0, j = 0; i < png.px.length; i += png.ch, j++) g[j] = png.px[i];
        fs.writeFileSync(path.join(dir, name), Buffer.concat([hdr, g]));
      };
      dump("baseA.pgm", baseA);
      dump("backA.pgm", worstPng);
      console.log(`    evidence: ${dir}/baseA.pgm vs backA.pgm`);
    }
  } finally {
    await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
