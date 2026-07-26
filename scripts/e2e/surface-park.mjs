#!/usr/bin/env node
// 파킹 표면 E2E — 파킹된 브라우저가 있는 창의 reload 후, 엔진 서피스가 홀 위에 겹치지
// 않아야 한다. 판정은 상시 감사(surface.misplaced — 앱이 스스로 발행)의 원장이다.
//
// RED 근거(감사 자동 발행, 2026-07-27): 복원 마운트에서 open 완료의 "생성 경쟁 보정"이
// 무조건 visible=true 를 재적용해 코어의 파킹 숨김을 되돌렸다(장부는 false, 실제는 보임 —
// 이후 view.parked 는 변화 없음으로 조기 반환해 영영 안 숨겨짐). 부트 직후 stacked ×1
// (surfaces 3/holes 2)이 그 실체다. 규칙: 표면 제공자는 가시성을 추측하지 않는다 —
// 재적용은 코어가 알린 마지막 사실(장부)만.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/surface-park 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/surface-park.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveControlWindow } from "./lib/client.mjs";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "surface-park");

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

async function main() {
  await connect();
  console.log(`surface-park E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });

  // 잔재 회수(멱등)
  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("surface-park"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. window with engine browsers parked behind a terminal");
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  ok(typeof win === "string" && win.startsWith("w-"), `window opened (${win})`);
  let term = null;
  let browsers = [];
  for (let i = 0; i < 40 && (!term || browsers.length === 0); i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? term;
    // 전 엔진 순회 — 한 엔진만 보고 통과 판정하지 않는다(사용자 규칙: 전 축 GREEN 이어야
    // OK). native(WKWebView)·chromium(CEF)·offscreen 각각이 자기 실패 모드를 가진다.
    browsers = ids.filter((id) => id.startsWith("browser-"));
    if (!term || browsers.length === 0) await sleep(500);
  }
  ok(!!term && browsers.length > 0, `programs (${term}; ${browsers.join(", ")})`);
  const tabsByEngine = [];
  for (const b of browsers) {
    const r = await rpc("tab.open", { program: b }, win);
    const id = (r.data ?? r).tabId;
    ok(typeof id === "string", `tab opened for ${b} (${id})`, JSON.stringify(r).slice(0, 120));
    if (typeof id === "string") tabsByEngine.push([b, id]);
  }
  const tBrowser = tabsByEngine[0]?.[1];
  const tTerm = data(await rpc("tab.open", { program: term }, win)).tabId;
  ok(typeof tTerm === "string", `terminal tab (${tTerm})`);
  // 브라우저에 실 페이지 — 서피스가 실제로 생성되게.
  await sleep(2500);
  // 터미널을 활성으로 → 브라우저 파킹(서피스는 숨겨져야 한다).
  await rpc("tab.activate", { tab: tTerm }, win);
  await sleep(1500);

  console.log("\nb. reload — parked engine surface must never resurface over the hole");
  const ctrl = await resolveControlWindow(rpc, win);
  const since = (data(await rpc("activity.recent", { limit: 1 }, ctrl)).entries ?? []).at(-1)?.seq ?? 0;
  await rpc("window.reload", {}, win).catch(() => {});
  // 부트 완주 대기 — boot:done 사건이 원장에 서는 것으로 판정(유한 재시도).
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    await sleep(500);
    const es = data(await rpc("activity.recent", { since, limit: 500 }, ctrl)).entries ?? [];
    done = es.some((e) => e.kind === "boot.step" && (e.payload?.step ?? "") === "boot:done");
  }
  ok(done, "boot completed after reload");
  // 감사 정착 여유(디바운스 400ms + 발행) 뒤 원장 판독 — 위반이 있으면 앱이 스스로 발행했다.
  await sleep(2000);
  {
    const es = data(await rpc("activity.recent", { since, limit: 500 }, ctrl)).entries ?? [];
    const bad = es.filter((e) => e.kind === "surface.misplaced");
    ok(
      bad.length === 0,
      "no surface.misplaced after reload (parked surface stayed hidden)",
      JSON.stringify(bad.map((e) => e.payload?.message)).slice(0, 220),
    );
  }

  console.log("\nc. the dual: the ACTIVE browser must actually show (no dark pane)");
  // 쌍대 오라클 — "보이면 안 되는 게 안 보임"만 보는 게이트는 반쪽이다(실사고: 파킹 수리가
  // 활성 표면의 기상을 우회해 검은 페인을 만들었는데 게이트는 GREEN 이었다). 브라우저를
  // 활성으로 되돌리고, 감사 missing 무발행 + 표면 정합(webview.surfaces)이 가시 서피스를
  // 실제로 세는지 둘 다 단언한다.
  for (const [engine, tab] of tabsByEngine) {
    const since2 = (data(await rpc("activity.recent", { limit: 1 }, ctrl)).entries ?? []).at(-1)?.seq ?? 0;
    await rpc("tab.activate", { tab }, win);
    await sleep(3000); // 표면 복귀·재페인트·감사 2회(지속 판정) 여유
    const sf = data(await rpc("webview.surfaces", {}, win));
    const engineVisible = ((sf.engine ?? {}).surfaces ?? []).filter((x) => !x.effectivelyHidden).length;
    const nativeAlive = (sf.actual ?? []).length;
    ok(
      engineVisible + nativeAlive >= 1,
      `${engine}: active browser has a live surface (engine ${engineVisible}, native ${nativeAlive})`,
      JSON.stringify(sf.engine).slice(0, 160),
    );
    const es2 = data(await rpc("activity.recent", { since: since2, limit: 500 }, ctrl)).entries ?? [];
    const badVis = es2.filter(
      (e) =>
        e.kind === "surface.misplaced" &&
        (((e.payload?.missing ?? []).length > 0) || ((e.payload?.dark ?? []).length > 0)),
    );
    ok(
      badVis.length === 0,
      `${engine}: no persistent missing/dark while active`,
      JSON.stringify(badVis.map((e) => e.payload?.message)).slice(0, 220),
    );
  }

  await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
