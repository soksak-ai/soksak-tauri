#!/usr/bin/env node
// 레일 카드 테두리 E2E — 레일(사이드바 투영) 카드의 네 변이 화면에 실제로 그려지는지 픽셀로
// 판정한다. DOM 의 computed border 는 "그렸다"를 말할 뿐 "보인다"를 말하지 못한다 —
// 부모 클립·뷰포트 경계에 잘리면 계산값은 1px 인데 화면엔 없다(실측 2026-07-27: 하단만 없음).
//
// RED 근거(사용자 실측): 특정 배치에서만 카드 하단 테두리가 사라진다("여기에서만 이렇고 다른
// 위치로 가면 잘 나온다"). 위치 의존이므로 판정도 배치별로 돌려야 한다.
//
// 판정: 각 변의 안/변/밖 세 띠를 접어 바깥 지면 대비 최대 편차(경계 신호)를 낸다. 신호는
// 테두리 선이든 채움 계단이든 무엇이든 좋다 — 사람이 "카드가 닫혔다"고 읽는 것이 기준이다.
// 색을 특정하지 않는다(테마마다 다르다). 크기를 1px 씩 옮기며 전 구간을 순회한다:
// 어떤 크기에서 보이느냐가 아니라 모든 크기에서 보이느냐가 계약이다.
//
// 멱등: 픽스처 루트 ~/.soksak-e2e/rail-border 전용 창. 끝나면 회수.
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/rail-border.mjs

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
const FIXTURE = path.join(os.homedir(), ".soksak-e2e", "rail-border");

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


/** 가로줄 밝기 프로파일 — [yFrom,yTo) CSS 구간을 물리 줄마다 x 평균으로 접는다. */
function rowProfile(png, scale, xFrom, xTo, yFrom, yTo) {
  const x0 = Math.max(0, Math.round(xFrom * scale));
  const x1 = Math.min(png.w, Math.round(xTo * scale));
  const y0 = Math.max(0, Math.round(yFrom * scale));
  const y1 = Math.min(png.h, Math.round(yTo * scale));
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let s = 0;
    let n = 0;
    for (let x = x0; x < x1; x++) {
      s += png.px[(y * png.w + x) * png.ch];
      n++;
    }
    if (n) rows.push({ y, cssY: y / scale, mean: s / n });
  }
  return rows;
}

/** 세로줄 밝기 프로파일 — 좌/우 변 판정용(rowProfile 의 축 대칭). */
function colProfile(png, scale, yFrom, yTo, xFrom, xTo) {
  const y0 = Math.max(0, Math.round(yFrom * scale));
  const y1 = Math.min(png.h, Math.round(yTo * scale));
  const x0 = Math.max(0, Math.round(xFrom * scale));
  const x1 = Math.min(png.w, Math.round(xTo * scale));
  const cols = [];
  for (let x = x0; x < x1; x++) {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      s += png.px[(y * png.w + x) * png.ch];
      n++;
    }
    if (n) cols.push({ x, mean: s / n });
  }
  return cols;
}

/** 네 변 공통 경계 신호 — 안/변/밖 세 띠를 접어 바깥 지면 대비 최대 편차를 낸다.
 *  변마다 다른 오라클을 쓰면 한 변만 관대해진다(구 edgeDrawn 은 이웃 리사이저와 색이
 *  비슷한 우변에서 3% 를 내고도 화면엔 선이 있었다) — 축만 바꾸고 판정은 하나로 둔다. */
function edgeSignal(png, scale, rect, side) {
  const vertical = side === "left" || side === "right";
  const alongFrom = vertical ? rect.y + rect.h * 0.25 : rect.x + rect.w * 0.25;
  const alongTo = vertical ? rect.y + rect.h * 0.75 : rect.x + rect.w * 0.75;
  const at = { top: rect.y, bottom: rect.y + rect.h, left: rect.x, right: rect.x + rect.w }[side];
  const dir = side === "top" || side === "left" ? -1 : 1; // 바깥 방향
  const band = (from, to) =>
    vertical
      ? colProfile(png, scale, alongFrom, alongTo, at + Math.min(from, to), at + Math.max(from, to))
      : rowProfile(png, scale, alongFrom, alongTo, at + Math.min(from, to), at + Math.max(from, to));
  const inside = band(dir * -10, dir * -4);
  const edge = band(dir * -3, dir * 2);
  // 바깥은 "카드 밖 지면"이지 창 밖 데스크톱이 아니다. 창 가장자리(둥근 모서리·그림자)는
  // 지면보다 200 가까이 밝아, 넓게 뜨면 테두리가 없어도 신호가 크게 나온다 — 통과의 이유가
  // 바뀌면 그 GREEN 은 거짓이다. 좁게 뜨고 중앙값으로 이상치를 눌러 지면만 남긴다.
  const outside = band(dir * 2, dir * 5);
  if (inside.length < 2 || edge.length < 2 || outside.length < 2) {
    return { signal: 0, reason: "표본 없음(화면 밖)" };
  }
  const median = (a) => {
    const v = a.map((r) => r.mean).sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  const out = median(outside);
  const ins = median(inside);
  const line = Math.max(...edge.map((r) => Math.abs(r.mean - out)));
  const step = Math.abs(ins - out);
  return {
    signal: Math.max(line, step),
    reason: `안 ${ins.toFixed(0)} 밖 ${out.toFixed(0)} 선편차 ${line.toFixed(0)} 계단 ${step.toFixed(0)}`,
  };
}

async function main() {
  await connect();
  console.log(`rail-border E2E\nsocket: ${SOCKET}\n`);
  fs.mkdirSync(FIXTURE, { recursive: true });

  {
    const ctrl = await resolveControlWindow(rpc);
    const wl = data(await rpc("window.list", {}, ctrl)).labels || [];
    for (const l of wl) {
      if (!String(l).startsWith("w-")) continue;
      const tr = data(await rpc("state.tree", {}, l).catch(() => null));
      if ((tr.projects ?? []).some((p) => String(p.root ?? "").includes("rail-border"))) {
        await rpc("window.close", { label: l }, await resolveControlWindow(rpc, l).catch(() => l)).catch(() => {});
        await sleep(500);
      }
    }
  }

  const beforeList = data(await rpc("window.list", {}, await resolveControlWindow(rpc))).labels || [];
  const opened = data(await rpc("window.open", { root: FIXTURE }, await resolveControlWindow(rpc)));
  const win = opened.label || opened.existingWindow;
  if (typeof win !== "string" || !win.startsWith("w-") || beforeList.includes(win)) {
    throw new Error(`픽스처 창 확보 실패 — 중단(사용자 창 오염 방지): ${JSON.stringify(opened).slice(0, 140)}`);
  }
  ok(true, `window opened (${win})`);
  // 레일은 결부(활성 탭이 투영을 선언하는 종류)가 있어야 선다 — 브라우저 탭을 열어 즐겨찾기
  // 레일을, 없으면 터미널로 파일트리 레일을 세운다. 빈 창엔 투영이 없다(설계).
  {
    let browser = null;
    let term = null;
    for (let i = 0; i < 40 && !(browser || term); i++) {
      const ids = (data(await rpc("program.list", {}, win)).programs || []).map((p) => p.id);
      browser = ids.find((id) => id === "browser" || id.startsWith("browser-")) ?? browser;
      term = ids.find((id) => id.startsWith("terminal-")) ?? term;
      if (!(browser || term)) await sleep(500);
    }
    ok(!!(browser || term), `programs ready (${browser ?? term})`);
    if (browser) await rpc("tab.open", { program: browser }, win);
    else if (term) await rpc("tab.open", { program: term }, win);
  }
  await sleep(4000); // 레일·플러그인 정착

  try {
    const cardOnce = () =>
      // 카드 자신의 주소만 잰다 — 컨테이너(projection/left)는 카드가 아니다.
      rpc("ui.snapshot.dom", { filter: "projection/left/card/", props: ["visibility"] }, win).then((r) => {
        const nodes = (data(r).nodes ?? []).filter((n) => (n.rect?.h ?? 0) > 40);
        return nodes[0]?.rect ?? null;
      });
    // 레일은 스테이션 사이를 주행한다(§12-④) — 주행 중 좌표로 판정하면 카드가 없는 자리를
    // 재고 "경계 없음"이라 우긴다(실측: 정착 x=110 인데 주행 중 x=359.5 표본). 두 번 연속
    // 같은 rect 가 나올 때까지 기다린다 — 시간이 아니라 정착이 기준이다.
    const card = async () => {
      let prev = null;
      for (let i = 0; i < 40; i++) {
        const r = await cardOnce();
        if (r && prev && r.x === prev.x && r.y === prev.y && r.w === prev.w && r.h === prev.h) return r;
        prev = r;
        await sleep(120);
      }
      return prev;
    };
    let rect = await card();
    ok(!!rect, `rail card measured`, JSON.stringify(rect));
    if (!rect) throw new Error("레일 카드 없음 — 이 창에 투영이 서지 않았다");

    const shotOnce = async () => {
      const r = await rpc("window.snapshot", { base64: true }, win);
      const b64 = r.media?.base64 ?? r.data?.media?.base64 ?? r.base64;
      if (!b64) throw new Error("스냅샷 base64 없음");
      return { png: decodePng(Buffer.from(b64, "base64")), sig: b64, b64 };
    };
    // 창 크기가 바뀌면 DOM rect 는 즉시 갱신되지만 창의 백킹 스토어는 뒤늦게 다시 그려진다.
    // 그 사이를 찍으면 아직 그려지지 않은 테두리를 "없다"고 판정한다(실측: 판정은 신호 0,
    // 1초 뒤 같은 자리 증거 캡처에는 선이 값 64 로 멀쩡히 있었다). 두 번 연속 같은 프레임이
    // 나올 때까지 기다린다 — rect 정착과 같은 기준을 픽셀에도 적용한다.
    // 증거는 재촬영이 아니라 "판정한 그 이미지"여야 한다 — 다시 찍으면 판정과 다른 프레임이
    // 남아 서로 다른 이야기를 한다(실측: 판정 신호 0, 재촬영 증거엔 선이 값 64 로 존재).
    const shot = async () => {
      let prev = null;
      for (let i = 0; i < 14; i++) {
        const cur = await shotOnce();
        if (prev && prev.sig === cur.sig) return cur;
        prev = cur;
        await sleep(250);
      }
      return prev;
    };
    // 이 창에서 카드가 테두리를 소유해야 하는가는 내가 정하지 않는다 — 보더 소유권 계약이
    // 정한다(borderContract.ts, 테마 paneStyle 축). 계약에 묻고 그 답을 기준으로 판정한다.
    const expect = data(await rpc("ui.expect", { selector: ".sidebar-left .projection" }, win));
    const activeRule = (expect.rules ?? []).find((x) => x.active);
    const wantsBorder = activeRule?.edges?.bottom === "bd";
    ok(!!activeRule, `보더 계약 조회(${activeRule?.id ?? "규칙 없음"})`);
    console.log(`  계약: 하단 ${activeRule?.edges?.bottom ?? "?"} — ${wantsBorder ? "선을 요구함" : "선 없음이 정상"}`);
    if (!wantsBorder) {
      console.log("  이 테마(paneStyle)에서는 카드 무선이 계약이다 — 픽셀 판정 생략(기준을 지어내지 않는다).");
      console.log(`\nresult: ${pass} pass / ${fail} fail`);
      await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
      process.exit(fail > 0 ? 1 : 0);
    }
    const { png } = await shot();
    // 배율 = 물리폭 / CSS폭. CSS 폭은 노드 트리의 최대 우변(창 내용 폭)으로 잰다 —
    // 카드 rect 로 나누면 배율이 아니라 비율이 나온다(첫 판의 오류: scale 800).
    const scale = await snapshotScale(win, png);
    console.log(`  snapshot ${png.w}×${png.h}, scale ${scale.toFixed(2)}, card ${JSON.stringify(rect)}`);
    for (const side of ["top", "left", "right", "bottom"]) {
      const v = edgeSignal(png, scale, rect, side);
      ok(v.signal >= 15, `card ${side} edge visible (신호 ${v.signal.toFixed(0)})`, v.reason);
    }

    // ── 크기 스윕: "늘 보이는" 이 기준이다 ────────────────────────────────
    // 사용자 실측: "창 크기를 조금씩 수정하다 보면 보일 때가 있다(완전히 닫히는)".
    // 어떤 크기에서 보이느냐가 아니라 모든 크기에서 보이느냐가 계약이다. 1px 씩 옮기면
    // 카드 하단이 기기 픽셀 격자에 걸치는 위상이 한 바퀴 돈다 — 그 전 구간을 순회한다.
    const info = data(await rpc("window.info", {}, win));
    const baseW = Math.round(info.w ?? 0);
    const baseH = Math.round(info.h ?? 0);
    ok(baseW > 200 && baseH > 200, `window size read (${baseW}x${baseH})`);
    const MIN_SIGNAL = 15; // 어두운 테마에서 사람 눈이 경계로 읽는 하한(실측 기준)
    let worst = { signal: 999, h: 0, reason: "" };
    for (let d = 0; d < 12; d++) {
      const h = baseH + d;
      await rpc("window.resize", { w: baseW, h }, win);
      await sleep(900); // 리사이즈 종료 디바운스(400ms 정착)보다 넉넉히 — 그 뒤 프레임 정착을 본다
      const r = await card();
      if (!r) {
        ok(false, `h=${h} 카드 측정 실패`);
        continue;
      }
      const { png: p, b64: judged } = await shot();
      const s = await snapshotScale(win, p);
      const v = edgeSignal(p, s, r, "bottom");
      if (v.signal < worst.signal) worst = { signal: v.signal, h, reason: v.reason };
      const good = v.signal >= MIN_SIGNAL;
      ok(good, `h=${h} 하단 경계 보임(신호 ${v.signal.toFixed(0)})`, `${v.reason} card=${JSON.stringify(r)} png=${p.w}x${p.h} scale=${s.toFixed(2)}`);
      // 실패는 증거를 남긴다 — 숫자만 남는 실패는 다음 사람이 다시 재현해야 한다.
      if (!good) {
        // 하니스가 실제로 본 줄 값 — 증거 이미지와 판정이 다른 이야기를 하면 여기가 갈림길이다.
        const prof = rowProfile(p, s, r.x + r.w * 0.25, r.x + r.w * 0.75, r.y + r.h - 10, r.y + r.h + 6);
        console.log(`    줄 값: ${prof.map((q) => `${q.cssY.toFixed(0)}:${q.mean.toFixed(0)}`).join(" ")}`);
        const shotFile = path.join(FIXTURE, `fail-h${h}.png`);
        fs.writeFileSync(shotFile, Buffer.from(judged, "base64"));
        console.log(`    증거(판정한 그 프레임): ${shotFile}`);
      }
    }
    console.log(`  최악 크기 h=${worst.h} 신호 ${worst.signal.toFixed(0)} — ${worst.reason}`);
    await rpc("window.resize", { w: baseW, h: baseH }, win).catch(() => {});
  } finally {
    await rpc("window.close", { label: win }, await resolveControlWindow(rpc, win).catch(() => win)).catch(() => {});
  }

  console.log(`\nresult: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

/** 스냅샷 배율(물리 px / CSS px) — 창이 스스로 말하는 값만 믿는다.
 *  DOM 최대 우변으로 추정하면 배치에 따라 값이 흔들려, 같은 화면을 크기마다 다른 좌표로
 *  재고 "경계 없음"이라는 가짜 RED 를 만든다(실측: 같은 창에서 회차마다 다른 균일값). */
async function snapshotScale(win, png) {
  const info = data(await rpc("window.info", {}, win));
  const physW = Number(info.w) || 0;
  const dpr = Number(info.scale) || 1;
  if (physW > 50) return (png.w * dpr) / physW;
  return 1;
}

main().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(2);
});
