#!/usr/bin/env node
// 복원 시간 계측 E2E — reload(렌더러 재부팅=복원 경로)를 N회 반복해 boot.step 타임라인을
// 표로 낸다. 기준(사용자 확정 2026-07-27): 복원이 화면의 사실이 되는 지점(painted)이 300ms 안.
//
// 측정축 두 벌:
//  · boot.step ts(activity 허브, epoch-ms) — 렌더러가 스스로 찍는 정밀축. 기점은 reload 발신
//    시각(같은 머신 = 같은 시계)이라 렌더러 재부팅 오버헤드까지 실린다(사람 체감과 같은 축).
//  · state.tree 탭 등장(소켓 폴링 100ms) — 상태·명령 표면의 확인축(게이트 회귀 검출).
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/restore-timing 전용 창, 끝나면 회수.
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/restore-timing.mjs [N]

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { requireSocket, resolveControlWindow } from "./lib/client.mjs";

const SOCKET = requireSocket();
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "restore-timing");
const RUNS = Math.max(1, Number(process.argv[2] ?? 10));
const BAR_MS = 300;

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

async function lastSeq(ctrl) {
  const es = data(await rpc("activity.recent", { limit: 1 }, ctrl)).entries ?? [];
  return es.length ? es[es.length - 1].seq : 0;
}
async function bootSteps(ctrl, sinceSeq) {
  const es = data(await rpc("activity.recent", { since: sinceSeq, limit: 500 }, ctrl)).entries ?? [];
  return es.filter((e) => e.kind === "boot.step");
}
async function tabCount(win) {
  const tree = data(await rpc("state.tree", {}, win).catch(() => null));
  let n = 0;
  for (const p of tree.projects ?? [])
    for (const sp of p.spaces ?? []) for (const pa of sp.panes ?? []) n += (pa.tabs ?? []).length;
  return n;
}

async function main() {
  await connect();
  console.log(`restore-timing E2E — ${RUNS}회\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURE, "sample.md"),
    "# restore-timing fixture\n\n" + "line\n".repeat(30),
  );

  // 잔재 회수(멱등)
  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("restore-timing"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  if (typeof win !== "string") throw new Error(`창 열기 실패: ${JSON.stringify(opened)}`);
  let term = null;
  for (let i = 0; i < 40 && !term; i++) {
    const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
    term = ids.find((id) => id.startsWith("terminal-")) ?? null;
    if (!term) await sleep(500);
  }
  await rpc("tab.open", { program: term }, win);
  await rpc("ui.intent.open", { path: path.join(FIXTURE, "sample.md") }, win);
  await sleep(2000); // 영속 정착

  const rows = [];
  try {
    for (let run = 1; run <= RUNS; run++) {
      const ctrl = await resolveControlWindow(rpc, win);
      const s0 = await lastSeq(ctrl);
      const t0 = Date.now();
      await rpc("window.reload", {}, win).catch(() => {});
      // 상태 탭 등장(확인축, 100ms 폴링)
      let tabsMs = null;
      for (let i = 0; i < 300; i++) {
        await sleep(100);
        if ((await tabCount(win)) >= 2) {
          tabsMs = Date.now() - t0;
          break;
        }
      }
      // boot:done 까지 대기(부트 완주 — 다음 run 의 기점 오염 방지)
      let steps = [];
      for (let i = 0; i < 200; i++) {
        steps = await bootSteps(ctrl, s0);
        if (steps.some((e) => (e.payload?.step ?? "") === "boot:done")) break;
        await sleep(200);
      }
      const at = (name) => {
        const e = steps.find((x) => (x.payload?.step ?? "") === name);
        return e ? e.ts - t0 : null;
      };
      const act = steps.find((x) => (x.payload?.step ?? "") === "plugin-activate");
      rows.push({
        run,
        restore: at("restore:done:true") ?? at("restore-visible"),
        visible: at("restore-visible"),
        painted: at("painted"),
        tabs: tabsMs,
        activate: act?.payload?.ms ?? null,
        done: at("boot:done"),
      });
      const r = rows[rows.length - 1];
      console.log(
        `run ${String(run).padStart(2)}: restore ${r.restore}ms · visible ${r.visible}ms · painted ${r.painted}ms · tabs(state) ${r.tabs}ms · plugin ${r.activate}ms · done ${r.done}ms`,
      );
      await sleep(500);
    }
  } finally {
    await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  }

  const med = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const worst = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null);
    return v.length ? Math.max(...v) : null;
  };
  console.log(`\n| 축 | 중앙값 | 최악 |\n|---|---|---|`);
  for (const [k, label] of [
    ["restore", "복원 완료(restore:done)"],
    ["visible", "restore-visible"],
    ["painted", "painted(화면 사실)"],
    ["tabs", "탭 등장(state.tree 소켓)"],
    ["activate", "plugin-activate(후행)"],
    ["done", "boot:done(전체 완주)"],
  ])
    console.log(`| ${label} | ${med(k)}ms | ${worst(k)}ms |`);

  const ok = med("painted") != null && med("painted") <= BAR_MS;
  console.log(`\n판정: painted 중앙값 ${med("painted")}ms ${ok ? "≤" : ">"} ${BAR_MS}ms — ${ok ? "GREEN" : "RED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
