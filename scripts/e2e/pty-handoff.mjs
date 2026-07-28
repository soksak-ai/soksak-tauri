#!/usr/bin/env node
// PTY 데몬 무중단 판올림(pty.daemon.upgrade) E2E — 셸이 살아남고 출력이 계속 흐르는가.
//
// 계약 두 줄:
//  ① 셸은 판올림을 넘어 그대로 산다 — 같은 pid 가 판올림 뒤에도 대답해야 한다.
//  ② 출력은 재부착 없이 계속 흐른다 — 판올림 직후 보낸 명령의 결과가 화면 버퍼에 온다.
//
// RED 근거(실측 2026-07-27, 살아있는 앱):
//  · 판올림 뒤 term.exec 는 ok 를 돌려주고 리다이렉션 파일도 실제로 생겼는데(입력 도달)
//    화면에는 아무것도 오지 않았다 — adopt 가 링을 0 부터 다시 세어 재부착 클라이언트의
//    좌표가 seq 를 앞질렀다(since() 가 "이미 최신"으로 판정). 침묵 실패.
//  · 같은 경로를 세 번 밟자 세 번째에 셸 하나가 사라졌다 — pre_exec 의 dup2 대상이 4..N 으로
//    못박혀 있어 아직 복사되지 않은 master 원본을 덮어썼다. 세션 순회가 HashMap 이라
//    순서가 비결정적이라 간헐로만 드러난다. 그래서 한 번이 아니라 여러 번 돌린다.
//
// 주의: pty.daemon.upgrade 는 데몬 전역 조작이다 — 이 하니스는 자기 픽스처 창의 셸만
// 단언하지만, 판올림 자체는 그 순간 살아있는 모든 세션을 함께 넘긴다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/pty-handoff 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/pty-handoff.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { requireSocket, resolveControlWindow } from "./lib/client.mjs";

const SOCKET = requireSocket();
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "pty-handoff");
const ROUNDS = Number(process.env.HANDOFF_ROUNDS || 5);

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

/** 탭에 표식을 실행시키고 화면 버퍼에서 되읽는다 — "출력이 흐르는가"의 유일한 증거. */
async function probe(win, tab, marker) {
  await rpc("term.exec", { tab, cmd: `echo ${marker}-$$` }, win);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const text = data(await rpc("term.read", { tab, lines: 12 }, win)).text ?? "";
    // 셸이 되돌린 줄만 인정한다(에코된 명령줄이 아니라 결과).
    const m = text.match(new RegExp(`^${marker}-(\\d+)$`, "m"));
    if (m) return Number(m[1]);
  }
  return null;
}

async function main() {
  await connect();
  console.log(`pty-handoff E2E (${ROUNDS} 회)\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });

  const ctrl = await resolveControlWindow(rpc);
  // 멱등 — 앞선 실행이 정리 전에 죽었으면 그 픽스처 창을 먼저 회수한다(사람 손 필요 없음).
  for (const l of data(await rpc("window.list", {}, ctrl)).labels || []) {
    if (!String(l).startsWith("w-")) continue;
    const tr = data(await rpc("state.tree", {}, l).catch(() => null));
    if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("pty-handoff"))) {
      await rpc("window.close", { label: l }, ctrl).catch(() => {});
      await sleep(800);
    }
  }
  const before = data(await rpc("window.list", {}, ctrl)).labels || [];
  const opened = data(await rpc("window.open", { root: FIXTURE }, ctrl));
  const win = opened.label || opened.existingWindow;
  if (typeof win !== "string" || !win.startsWith("w-") || before.includes(win)) {
    throw new Error(`픽스처 창 확보 실패 — 중단: ${JSON.stringify(opened).slice(0, 140)}`);
  }
  ok(true, `window opened (${win})`);

  try {
    // 터미널 엔진마다 부착 경로가 다르다 — 코어가 스트림을 잡는 엔진과 사이드카가 직접
    // ptyd 에 붙는 엔진이 있다. 한 엔진만 통과한 GREEN 은 계약을 지키지 못한다: 전 엔진을
    // 순회한다(둘 이상 열려야 인계 fd 충돌도 산다).
    let engines = [];
    for (let i = 0; i < 60 && engines.length === 0; i++) {
      const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
      engines = ids.filter((id) => id.startsWith("terminal-"));
      if (engines.length === 0) await sleep(500);
    }
    ok(engines.length > 0, `terminal engines ready (${engines.join(", ")})`);
    for (const e of engines) {
      await rpc("tab.open", { program: e }, win);
      await sleep(1500);
    }
    await sleep(4000);

    const engineOf = {};
    const collectTabs = async () => {
      const out = [];
      for (const p of data(await rpc("state.tree", {}, win)).projects ?? []) {
        for (const sp of p.spaces ?? []) {
          for (const pane of sp.panes ?? []) {
            for (const t of pane.tabs ?? []) {
              const plug = String(t.plugin ?? "");
              if (!plug.includes("terminal")) continue;
              out.push(t.id);
              engineOf[t.id] = plug.replace("soksak-plugin-", "");
            }
          }
        }
      }
      return out;
    };
    let tabs = await collectTabs();
    ok(tabs.length >= 2, `terminal tabs (${tabs.length})`, tabs.map((t) => `${t}=${engineOf[t]}`).join(" "));

    // 기준선 — 각 탭의 셸 pid. 이 값이 판올림을 넘어 유지돼야 한다.
    const basePid = {};
    for (const t of tabs) {
      basePid[t] = await probe(win, t, "BASE");
      ok(!!basePid[t], `${engineOf[t]} 기준선 셸 pid ${basePid[t]}`);
    }
    if (Object.values(basePid).some((v) => !v)) throw new Error("기준선을 못 잡았다 — 판정 불가");

    // 인계 계획은 나가는 데몬이 세운다 — 그 판이 계약을 구현하는지 밖에서 읽고, 못 하면
    // 판올림이 조치를 담아 거절해야 한다. 두 갈래를 다 시험한다(거절도 계약이다).
    let st0 = data(await rpc("pty.daemon.status", {}, win));
    if ((st0.handoffContract ?? 0) < (st0.handoffContractRequired ?? 0)) {
      const refused = await rpc("pty.daemon.upgrade", {}, win);
      // 거절 문구는 봉투 어디에 실리든 사람이 읽을 수 있어야 한다 — 전체를 본다.
      const envelope = JSON.stringify(refused);
      ok(refused.ok === false, `계약 이전 데몬의 판올림은 거절된다`, envelope.slice(0, 160));
      ok(envelope.includes("pty.daemon.restart"), `거절이 조치를 담는다`, envelope.slice(0, 200));
      await rpc("pty.daemon.restart", {}, win);
      await sleep(2000);
      // 재시작은 셸을 죽인다 — 뷰가 새 세션을 잡도록 창을 다시 적재하고 기준선을 다시 잡는다.
      await rpc("window.reload", {}, win);
      await sleep(9000);
      st0 = data(await rpc("pty.daemon.status", {}, win));
      ok(
        (st0.handoffContract ?? 0) >= (st0.handoffContractRequired ?? 0),
        `재시작한 데몬이 계약 ${st0.handoffContract} 선언`,
        JSON.stringify(st0),
      );
      tabs = await collectTabs();
      for (const t of tabs) {
        basePid[t] = await probe(win, t, "BASE2");
        ok(!!basePid[t], `${engineOf[t]} 기준선 재설정 ${basePid[t]}`);
      }
      if (Object.values(basePid).some((v) => !v)) throw new Error("재시작 후 기준선 실패 — 판정 불가");
    }
    let daemonPid = st0.pid;
    ok(!!daemonPid, `daemon pid ${daemonPid}`);

    for (let round = 1; round <= ROUNDS; round++) {
      const up = data(await rpc("pty.daemon.upgrade", {}, win));
      ok(up.upgraded === true, `round ${round}: 판올림`, JSON.stringify(up));
      ok(up.pid !== daemonPid, `round ${round}: 새 데몬 pid ${up.pid}`, `이전 ${daemonPid}`);
      daemonPid = up.pid;
      await sleep(800);
      for (const t of tabs) {
        const pid = await probe(win, t, `R${round}`);
        // ① 셸 생존 + ② 출력 흐름 — 한 번의 프로브가 둘 다 판정한다.
        ok(pid === basePid[t], `round ${round}: ${engineOf[t]} 같은 셸(${basePid[t]})이 대답`, `실측 ${pid}`);
      }
      const st = data(await rpc("pty.daemon.status", {}, win));
      ok(st.sessions >= tabs.length, `round ${round}: 세션 ${st.sessions}개 유지`);
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
