#!/usr/bin/env node
// 골 드래그 E2E — 네이티브 표면(엔진/브라우저 child)과 겹치는 골도 끌 수 있어야 한다.
//
// RED 근거(사용자 실측, 2026-07-27): 브라우저가 있는 열의 가로 골이 드래그되지 않았다.
// 원인은 좌표로 확정됐다 — 골은 seam 중심 ±3px 밴드라 이웃 슬롯을 3px 침범하는데(설계),
// 그 자리에 네이티브 서피스(DOM 위 층)가 있으면 OS 히트테스트가 먼저 가져가 DOM 이
// 마우스를 못 본다. ui.hit(=elementFromPoint)은 DOM 만 보므로 "골이 최상위"라고 답한다 —
// 그 관측으로는 이 결함이 안 잡힌다. 판정은 네이티브 경로(webview.emitNative)로 실제 끌어
// 비율이 바뀌는가여야 한다.
//
// 계약: 코어는 DOM 오버레이 홀(webview_dom_holes)로 "이 사각형은 DOM 이 받는다"를 선언한다.
// 우측 사이드바만 등록돼 있었고 골은 빠져 있었다 — 이 하니스가 그 공백을 시행한다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/gutter-drag 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/gutter-drag.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveControlWindow } from "./lib/client.mjs";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-dev", "com.soksak.dev.sock");
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "gutter-drag");

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

/** 이 창의 골 주소·rect 목록(측정 실패는 제외). */
async function gutters(win) {
  const tree = data(await rpc("ui.tree", {}, win));
  const addrs = (tree.nodes ?? [])
    .map((n) => n.address)
    .filter((a) => typeof a === "string" && a.includes("/chrome/gutter/"));
  const out = [];
  for (const address of addrs) {
    const m = data(await rpc("ui.measure", { address }, win));
    const r = m.rect;
    if (r && r.w > 0 && r.h > 0) out.push({ address, ...r });
  }
  return out;
}

/** 가시 네이티브 서피스(엔진) rect — 이것과 겹치는 골이 이 하니스의 표적이다. */
async function liveSurfaces(win) {
  const s = data(await rpc("webview.surfaces", {}, win));
  return ((s.engine ?? {}).surfaces ?? [])
    .filter((x) => !x.effectivelyHidden)
    .map((x) => x.frame);
}

const overlaps = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) > 0 &&
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0;

async function main() {
  await connect();
  console.log(`gutter-drag E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });

  // 잔재 회수(멱등)
  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("gutter-drag"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. window split so a gutter runs beside an engine surface");
  const before = data(await rpc("window.list", {}, await resolveControlWindow(rpc))).labels || [];
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  // 봉투가 비면 이후 모든 명령이 **활성 창**(사용자 창)으로 라우팅된다 — 하니스가 남의 창에
  // 탭을 만들고 분할하고 드래그한다(실사고 2026-07-27: 사용자 창에 about:blank 탭이 생기고
  // 복원 상태가 날아갔다). 창 확보 실패는 즉시 중단이다. 관용 금지.
  if (typeof win !== "string" || !win.startsWith("w-")) {
    throw new Error(`픽스처 창 확보 실패 — 중단(사용자 창 오염 방지): ${JSON.stringify(opened).slice(0, 160)}`);
  }
  if (before.includes(win)) {
    throw new Error(`기존 창을 재사용하려 함 — 중단(전용 픽스처 창만 쓴다): ${win}`);
  }
  ok(true, `window opened (${win})`);
  // 네이티브 경로는 전면 창에서만 반응한다(가려진 창은 rAF 정지 — emitNative 계약).
  await rpc("window.focus", { label: win }, win).catch(() => {});
  await sleep(600);
  // 네이티브 마우스 브리지는 **전면 창**이 받는다 — 포커스가 이 창이 아니면 남의 창을 끈다.
  // 확인 없이 쏘지 않는다(위 사고의 두 번째 경로).
  {
    // 창 목록의 첫 항목이 아니라, 이 창이 자기 문서에 포커스를 갖는지로 판정한다
    // (ui.focus.state 는 창-로컬 사실이라 남의 창과 혼동될 수 없다).
    let fs = data(await rpc("ui.focus.state", {}, win).catch(() => ({})));
    for (let i = 0; i < 10 && fs.windowFocused !== true; i++) {
      await sleep(300);
      fs = data(await rpc("ui.focus.state", {}, win).catch(() => ({})));
    }
    if (fs.windowFocused !== true) {
      throw new Error("픽스처 창이 전면이 아님 — 네이티브 드래그 중단(남의 창 오염 방지)");
    }
  }
  let term = null;
  let browser = null;
  for (let i = 0; i < 40 && (!term || !browser); i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? term;
    browser = ids.find((id) => id.includes("chromium") && !id.includes("offscreen")) ?? browser;
    if (!term || !browser) await sleep(500);
  }
  ok(!!term && !!browser, `programs (${term}, ${browser})`);
  await rpc("tab.open", { program: browser }, win);
  await sleep(2500); // 엔진 서피스 생성·첫 프레임
  await rpc("pane.split", { side: "bottom", program: term }, win);
  await sleep(1500);

  try {
    const surfaces = await liveSurfaces(win);
    const gs = await gutters(win);
    ok(surfaces.length > 0, `live engine surface (${surfaces.length})`);
    ok(gs.length > 0, `gutters found (${gs.length})`);
    const target = gs.find((g) => surfaces.some((s) => overlaps(g, s)));
    ok(
      !!target,
      "a gutter overlaps a native surface (the defect's stage)",
      JSON.stringify({ gutters: gs.map((g) => g.address.split("/chrome/")[1]), surfaces }).slice(0, 200),
    );
    if (!target) throw new Error("표적 골 없음 — 분할 배치를 확인하라");

    console.log("\nb. native-path drag must move the seam");
    const horizontal = target.h <= target.w; // 가로 골 = 위아래 분할
    const cx = Math.round(target.x + target.w / 2);
    const cy = Math.round(target.y + target.h / 2);
    const before = data(await rpc("pane.list", {}, win));
    const sig = (l) => JSON.stringify(l).replace(/"id":"[^"]+"/g, "");
    await rpc("webview.emitNative", { kind: "native-mousedown", x: cx, y: cy }, win);
    for (let i = 1; i <= 6; i++) {
      await rpc(
        "webview.emitNative",
        {
          kind: "native-mousemove",
          x: horizontal ? cx : cx + i * 8,
          y: horizontal ? cy + i * 8 : cy,
        },
        win,
      );
      await sleep(40);
    }
    await rpc(
      "webview.emitNative",
      {
        kind: "native-mouseup",
        x: horizontal ? cx : cx + 48,
        y: horizontal ? cy + 48 : cy,
      },
      win,
    );
    await sleep(800);
    const after = data(await rpc("pane.list", {}, win));
    ok(
      sig(before.layout) !== sig(after.layout),
      "drag over a native surface changed the split (DOM hole works)",
      `gutter=${target.address.split("/chrome/")[1]} at (${cx},${cy})`,
    );
    console.log("\nc. axis isolation — a width drag must not move heights");
    // RED 근거(사용자 실측 2026-07-27): 브라우저 좌측 드래그바로 폭을 조절했는데 높이까지
    // 함께 조정됐다. 골은 한 축의 seam 이다 — 세로 골(width) 드래그가 가로 seam(height)을
    // 건드리면 계약 위반이다. 판정은 드래그 전후 각 칸 rect 의 높이 집합 동일성.
    {
      await rpc("pane.split", { side: "right", program: term }, win);
      await sleep(1200);
      const gs2 = await gutters(win);
      const vertical = gs2.find((g) => g.w < g.h); // 세로 골 = 좌우 분할(폭 조절)
      ok(!!vertical, `vertical gutter found (${gs2.length} gutters)`);
      if (vertical) {
        const heights = async () => {
          const l = data(await rpc("pane.list", {}, win));
          const out = [];
          const walk = (n) => {
            if (!n) return;
            if (n.pane) out.push(Math.round(n.rect?.h ?? -1));
            for (const c of n.children ?? []) walk(c);
          };
          walk(l.layout);
          return out.sort((a, b) => a - b);
        };
        const h0 = await heights();
        const cx2 = Math.round(vertical.x + vertical.w / 2);
        const cy2 = Math.round(vertical.y + vertical.h / 2);
        await rpc("webview.emitNative", { kind: "native-mousedown", x: cx2, y: cy2 }, win);
        for (let i = 1; i <= 6; i++) {
          await rpc("webview.emitNative", { kind: "native-mousemove", x: cx2 - i * 10, y: cy2 }, win);
          await sleep(40);
        }
        await rpc("webview.emitNative", { kind: "native-mouseup", x: cx2 - 60, y: cy2 }, win);
        await sleep(900);
        const h1 = await heights();
        ok(
          JSON.stringify(h0) === JSON.stringify(h1),
          "width drag left every pane height untouched",
          `before=${JSON.stringify(h0)} after=${JSON.stringify(h1)}`,
        );
      }
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
