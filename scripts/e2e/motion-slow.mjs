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
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/motion-slow.mjs

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { requireSocket, resolveControlWindow } from "./lib/client.mjs";

import { decodePng } from "./lib/png.mjs";
const SOCKET = requireSocket();
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
    sock.setEncoding("utf8");
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
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("motion-slow"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  console.log("a. fixture window");
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
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
    // ── A. 감속: 같은 레이아웃 변화가 1× 대비 1/50 에서 실제로 늘어져야 한다 ─────────
    // 판정 축은 rect 시계열(ui.trace)이다 — 이벤트(transitionrun)는 엔진 구현에 따라
    // 빠질 수 있지만 rect 는 화면의 결과 그 자체다. 같은 pane 주소를 두 배속에서 관찰해
    // 도달 시간을 비교한다.
    console.log("\nb. slow (1/50) — the same change must stretch vs 1×");
    const paneAddr = async () => {
      const nodes = data(await rpc("ui.tree", {}, win)).nodes || [];
      const a = nodes.map((n) => n.address).find((x) => x.includes("/layout/pane/pan-"));
      if (!a) throw new Error("pane 주소 없음");
      return a;
    };
    // 첫 골의 정본 (pane, edge) — 내부 split 은 실체가 아니다(IDENTITY §4): 첫 split 의
    // 첫 child 를 잎까지 내려간 pane + 방향. 활성 pane 짐작(오른끝이면 right 골이 없다)을
    // 하지 않는다 — 실측: 그 짐작이 TARGET_NOT_FOUND 로 하니스를 죽였다.
    const projId = async () => {
      const tr = data(await rpc("state.tree", {}, win));
      const id = (tr.projects ?? [])[0]?.id;
      if (!id) throw new Error("프로젝트 없음");
      return id;
    };
    const firstGutter = async () => {
      const lay = data(await rpc("pane.list", {}, win)).layout;
      const leaf = (n) => (n.pane ? n.pane : leaf(n.children[0]));
      const find = (n) => {
        if (n?.split && Array.isArray(n.children) && n.children.length >= 2) {
          return { pane: leaf(n.children[0]), edge: n.split.dir === "row" ? "right" : "bottom" };
        }
        for (const c of n?.children ?? []) {
          const r = find(c);
          if (r) return r;
        }
        return null;
      };
      const g = find(lay);
      if (!g) throw new Error("골 없음(분할 없는 레이아웃)");
      return g;
    };
    const traceResize = async (ratio, ms) => {
      const g = await firstGutter();
      const addr = `win/${win}/proj/${await projId()}/chrome/layout/pane/${g.pane}`;
      // 트레이스가 먼저다 — resize 를 먼저 쏘면 전이(160ms)가 첫 표본 전에 끝나 "불변"으로
      // 오판된다(실측: from=to 로 두 배속 다 실패). 표본이 돌기 시작한 뒤 변화를 유발한다.
      const once = async (r) => {
        const trP = rpc("ui.trace", { address: addr, ms }, win);
        await sleep(60);
        const rz = await rpc("pane.resize", { pane: g.pane, edge: g.edge, ratio: r }, win);
        if (!rz.ok) throw new Error(`pane.resize 실패: ${rz.code}`);
        const trR = await trP;
        if (trR.ok === false || !(trR.data ?? trR).to)
          throw new Error(`ui.trace 실패: ${JSON.stringify(trR).slice(0, 140)}`);
        return data(trR);
      };
      let tr = await once(ratio);
      // no-op 방어 — 창 재사용 누적으로 현재 비율이 이미 목표와 같을 수 있다(실측: 907ms
      // 완전 불변). 변화가 없으면 반대쪽으로 한 번 더 — 오라클은 "변화가 있는 실행"을 본다.
      if (Math.abs(tr.to.w - tr.from.w) < 0.5) tr = await once(ratio > 0.5 ? 0.3 : 0.7);
      return tr;
    };
    // no-op 방지 — 현재 비율을 읽어 반대쪽으로 민다(같은 값 재적용 = 변화 0 = 오라클 무효).
    const sizesNow = async () => {
      const g = await firstGutter();
      const lay = data(await rpc("pane.list", {}, win)).layout;
      const find = (n) =>
        n?.split && n.children?.length >= 2 ? n.split.sizes[0] : (n.children ?? []).map(find).find((x) => x != null);
      return find(lay) ?? 0.5;
    };
    const flip = async () => ((await sizesNow()) > 0.5 ? 0.3 : 0.7);
    // 기준(1×): 폭 변화가 표본창 안에서 시작·완결된다.
    await rpc("ui.motion", { scale: 1 }, win);
    const base = await traceResize(await flip(), 900);
    const baseMoved = Math.abs(base.to.w - base.from.w);
    const lastTwoEqual =
      Math.abs(base.samples[base.samples.length - 1].w - base.samples[base.samples.length - 2].w) < 0.5;
    ok(base.resized && baseMoved > 5 && lastTwoEqual, "1×: resize lands within the window", `w ${base.from.w}→${base.to.w}`);
    if (!(base.resized && baseMoved > 5 && lastTwoEqual))
      console.log("    base samples:", JSON.stringify(base.samples));
    // 1/50: 같은 900ms 창에서 아직 진행 중이어야 한다(완결되면 감속이 안 걸린 것).
    await rpc("ui.motion", { scale: SCALE }, win);
    const slow = await traceResize(await flip(), 900);
    const w0 = slow.samples[0].w;
    const wEnd = slow.samples[slow.samples.length - 1].w;
    // 1/50 의 본질은 "같은 창 안에서 완결되지 않음"이다. 진행 관찰(w 변화)을 요구하면
    // ease 초반 × 0.02 배속에서 900ms 진행분이 픽셀 반올림 아래로 내려가 가짜 RED 가 된다
    // (실측: w 불변인데 8초 애니메이션은 정상 진행 중). base(1×)가 같은 창에서 완결한 것과
    // 대비해 이동해야 할 거리의 70% 미만이면 감속이 실린 것이다.
    const unfinished = Math.abs(wEnd - w0) < baseMoved * 0.7;
    ok(
      unfinished,
      "1/50: not landed within the same window (stretched)",
      `w ${w0} → ${wEnd} (base moved ${baseMoved.toFixed(1)})`,
    );
    if (!unfinished) {
      // 원인 원장 — 감속이 안 걸린 이유(스킵/미채택)를 사실로 남긴다(#15).
      const led = data(await rpc("ui.motion", {}, win));
      console.log(
        "    recentBirths:",
        JSON.stringify((led.recentBirths ?? []).slice(-8)),
      );
    }
    // 원복 — 감속 해제 후 활강 완주 대기.
    await rpc("ui.motion", { scale: 1 }, win);
    await sleep(600);
    await rpc("tab.restore", {}, win).catch(() => {});
    await sleep(400);

    // ── A2. 보간 품질(1×): 단조 진행 + 착지 후 정지(사용자 실측 결함의 오라클) ─────
    // ① 방향 반전 없음(겹침·이중 애니메이션이면 w 가 갔다가 되돌아온다)
    // ② 종료 후 정지(끝 keyframe px 오차의 "1회 더 움직임"이면 착지 뒤 값이 또 변한다)
    console.log("\nb2. glide quality — monotonic, and still after landing");
    const q = await traceResize(await flip(), 1200);
    const ws = q.samples.map((s) => s.w);
    const dir = Math.sign(ws[ws.length - 1] - ws[0]);
    let reversals = 0;
    for (let i = 1; i < ws.length; i++) {
      const d = ws[i] - ws[i - 1];
      if (d !== 0 && Math.sign(d) !== dir && Math.abs(d) > 0.5) reversals++;
    }
    ok(reversals === 0, "monotonic glide (no overlap/second animation)", `reversals=${reversals} ws=${JSON.stringify(ws.slice(0, 12))}`);
    const tail = q.samples.filter((s) => s.t > 400).map((s) => s.w);
    const tailStill = tail.length >= 3 && Math.abs(tail[tail.length - 1] - tail[0]) < 0.5;
    ok(tailStill, "still after landing (no post-finish jump)", `tail=${JSON.stringify(tail.slice(-5))}`);

    // 여정 원장 생존 — 위 활강은 FLIP 이므로 여정(from→to)이 원장(ui.motion.journeys)에
    // 기록돼야 한다. 이 양성 단언이 있어야 tab-switch-ghost 의 "crossing 여정 0" 오라클이
    // 원장 사망과 구분된다(0 은 "깨끗함"과 "관측 죽음"의 두 얼굴을 가진다). 파킹 지문
    // (좌측 화면 밖 x+w≤0 — layerPark 는 -200vw) 여정은 여기서도 금지다.
    {
      const mo = data(await rpc("ui.motion", {}, win));
      const js = mo.journeys ?? [];
      ok(js.length >= 1, `motion journeys recorded (${js.length})`);
      const offLeft = (r) => r && r.x + r.w <= 0;
      const crossing = js.filter((j) => offLeft(j.from) || offLeft(j.to));
      ok(crossing.length === 0, "no park-crossing journeys", JSON.stringify(crossing.slice(0, 3)));
    }

    // ── B. 정지: hold 는 화면을 실제로 얼려야 한다 ────────────────────────────────
    // 유발은 resize(요소 지속 — FLIP 보간이 성립)로 한다. maximize 는 셀 재마운트 축이라
    // 보간 대상이 아니다(후속 과제로 기록 — 재마운트 모션).
    console.log("\nc. hold — the frozen frame must not advance");
    await rpc("ui.motion", { hold: true }, win);
    // 오라클은 레이아웃 rect 동결이다 — 전체 픽셀 diff 는 hold 계약 밖 픽셀(플러그인 자체
    // rAF 캔버스 — 실측: 벚꽃 파티클이 diff 40만을 만들었다, 증거 PNG)에 오염된다.
    const gh = await firstGutter();
    const holdAddr = `win/${win}/proj/t1/chrome/layout/pane/${gh.pane}`;
    const trHold = rpc("ui.trace", { address: holdAddr, ms: 700 }, win);
    await sleep(60);
    const rzHold = await rpc("pane.resize", { pane: gh.pane, edge: gh.edge, ratio: await flip() }, win);
    if (!rzHold.ok) throw new Error(`hold resize 실패: ${rzHold.code}`);
    const heldTr = data(await trHold);
    ok(
      heldTr.moved === false,
      "held layout rect does not advance",
      `from=${JSON.stringify(heldTr.from)} to=${JSON.stringify(heldTr.to)}`,
    );
    if (heldTr.moved !== false) {
      // 실패 진단 — 정지를 뚫은 진행의 시계열과, 그 순간의 애니메이션 원장(배속·pause 흔적).
      console.log(`    samples: ${JSON.stringify((heldTr.samples ?? []).map((x) => [Math.round(x.t), Math.round(x.w * 10) / 10]))}`);
      const mo = data(await rpc("ui.motion", {}, win));
      console.log(`    births(전체): ${JSON.stringify((mo.recentBirths ?? []).map((b) => `${b.at}|${b.what}|t=${Math.round(b.t ?? -1)}|held=${b.held}`))}`);
      console.log(`    running: ${mo.running} rates: ${JSON.stringify(mo.rates ?? [])} hold: ${mo.hold}`);
    }
    await rpc("ui.motion", { hold: false, scale: 1 }, win);
    await sleep(800);
    const done = data(await rpc("ui.motion", {}, win));
    ok((done.running ?? 0) === 0 || (done.rates || []).every((r) => r === 1), "release lands");
  } finally {
    // 원복 — 설정과 창 둘 다(멱등). 실패해도 다음 실행의 회수 단계가 걷는다.
    await rpc("ui.motion", { scale: 1, hold: false }, win).catch(() => {});
    await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
