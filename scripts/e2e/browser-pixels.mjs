// 브라우저 픽셀 게이트 — 엔진 전부에 대해 "열린 브라우저 뷰는 픽셀을 그린다"를 단언한다.
//
// 왜 이게 필요한가: 지금까지 이 결함은 엔진마다 다른 얼굴로 하나씩 나타났다. windowed 는
// child 가 죽었는데 장부가 살아 있어 빈 홀이 남았고(idMap chromium-v7→2 인데 엔진 ids=[]),
// offscreen 은 표면이 살아 있고 presenter 도 제자리인데 begin-frame 박자가 끊겨 빈 채로
// 남았다(framesPresented 가 navigate 에도 227 고정). 증상은 같고 원인은 달랐다 — 그래서
// 하나를 고치면 다른 하나가 남았다. 엔진별로 쫓는 대신 한 기준으로 전부 검사한다.
//
// 판정은 픽셀이다. 쿼리 성공도, 장부의 생존도, 엔진의 프레임 카운터도 "화면에 닿았다"를
// 증명하지 못한다(사이드카 repo 가 자기 게이트에 적어 둔 문장: query success must not stand
// in for pixels). 뷰 슬롯 영역을 잘라 캡처해 실제 색 분포를 본다.
//
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/browser-pixels.mjs
// 멱등: 전용 root 의 임시 창 하나에서만 동작하고(사용자 워크스페이스 무접촉) 끝에 닫는다.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { requireSocket, resolveControlWindow } from "./lib/client.mjs";

const SOCKET = requireSocket();
const FIXTURE_ROOT = path.join(os.homedir(), ".soksak-e2e", "browser-pixels");
// 픽스처 루트는 고정 경로 재사용(멱등 — /tmp 금지 규율). 없으면 만든다: 게이트가
// 환경 준비를 사람에게 떠넘기지 않는다.
fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
// 세 엔진 전부. 하나만 돌리면 나머지는 검증되지 않은 채 남는다 — 그게 이 게이트가 생긴 이유다.
const ENGINES = (process.env.BROWSER_ENGINES ?? "browser,browser-chromium,browser-chromium-offscreen")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 정적이고 확실히 렌더되는 페이지. 정적이라는 점이 핵심이다 — 손상이 없어 박자가 끊기면
// 영영 안 그려지는, 바로 그 조건을 만든다.
const URL = process.env.BROWSER_PIXELS_URL ?? "https://example.com/";
// 항행 후 정착 대기 — 로딩 완료 신호가 없는 엔진이 있어 유한 대기로 수렴시킨다. 값을 밖에서
// 바꿀 수 있어야 "안 그린다"와 "아직 안 그렸다"를 가를 수 있다.
const SETTLE_MS = Number(process.env.BROWSER_PIXELS_SETTLE_MS ?? 5000);
// 실패 증거를 남길 자리. 고정 경로라 다음 실행이 덮어쓴다(쌓이지 않는다).
const EVIDENCE_DIR = process.env.BROWSER_PIXELS_EVIDENCE ?? path.join(os.tmpdir(), "soksak-browser-pixels");

function openClient() {
  const state = { sock: null, seq: 0, pending: new Map(), buf: "" };
  return new Promise((resolve, reject) => {
    state.sock = net.createConnection(SOCKET);
    state.sock.setNoDelay(true);
    state.sock.once("error", reject);
    state.sock.once("connect", () =>
      resolve({
        rpc(method, params = {}, window) {
          return new Promise((res, rej) => {
            const id = ++state.seq;
            state.pending.set(id, res);
            const req = { id, method, params };
            if (window) req.window = window;
            state.sock.write(`${JSON.stringify(req)}\n`);
            setTimeout(() => {
              if (state.pending.has(id)) {
                state.pending.delete(id);
                rej(new Error(`TIMEOUT ${method}`));
              }
            }, 30000);
          });
        },
        close: () => state.sock.destroy(),
      }),
    );
    state.sock.on("data", (d) => {
      state.buf += d.toString("utf8");
      let i;
      while ((i = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, i);
        state.buf = state.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = state.pending.get(msg.id);
        if (p) {
          state.pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function must(reply, what) {
  if (!reply || reply.ok !== true) {
    throw new Error(`${what} 실패: ${JSON.stringify(reply)?.slice(0, 300)}`);
  }
  return reply.data ?? reply;
}

/** PNG(8bit RGBA/RGB, non-interlaced) → 픽셀 접근자. 외부 의존 없이 판정에 필요한 만큼만. */
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
  const bpp = ch;
  const stride = w * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev = line;
    rows.push(line);
  }
  return { w, h, bpp, at: (x, y) => rows[y].subarray(x * bpp, x * bpp + 3) };
}

/**
 * 이 영역이 페이지를 그리고 있는가 — 서로 다른 색이 충분히 많은가로 본다.
 * 빈 홀은 단색(앱 배경)이라 고유색이 한 줌이고, 렌더된 페이지는 배경·글자·링크로 갈린다.
 * 임계는 넉넉히 잡는다: 이 게이트가 잡아야 하는 것은 "완전히 비어 있음"이지 미세한 차이가 아니다.
 */
function looksRendered(png) {
  const seen = new Set();
  const step = Math.max(1, Math.floor(Math.min(png.w, png.h) / 60));
  let sampled = 0;
  for (let y = 0; y < png.h; y += step) {
    for (let x = 0; x < png.w; x += step) {
      const c = png.at(x, y);
      seen.add((c[0] << 16) | (c[1] << 8) | c[2]);
      sampled++;
    }
  }
  return { unique: seen.size, sampled, rendered: seen.size >= 8 };
}

/** 이 뷰의 표면에 엔진이 실제로 적용한 기하. 보고하지 않는 엔진(native)이면 null. */
async function surfaceBoundsOf(c, window, plugin, viewId) {
  const d = (await c.rpc(`plugin.${plugin}.stats`, {}, window)).data ?? {};
  const surfaces = (d.engine ?? d).surfaces ?? [];
  const byId = Object.fromEntries(surfaces.map((x) => [x.id, x.bounds ?? null]));
  const pairs = plugin.endsWith("offscreen")
    ? (d.ids ?? []).map((x) => [x.viewId, x.surfaceId])
    : Object.entries(d.idMap ?? {}).map(([k, v]) => [k.replace("chromium-", ""), v]);
  for (const [vid, sid] of pairs) if (vid === viewId) return byId[sid] ?? null;
  return null;
}

/** 이 탭을 소유한 플러그인 — 상태에 적혀 있는 사실이다. 짐작하지 않는다. */
async function ownerPluginOf(c, window, tabId) {
  const tree = (await c.rpc("state.tree", {}, window)).data;
  for (const p of tree?.projects ?? []) {
    for (const sp of p.spaces ?? []) {
      for (const pan of sp.panes ?? []) {
        for (const v of pan.tabs ?? []) if (v.id === tabId) return v.plugin ?? null;
      }
    }
  }
  return null;
}

async function main() {
  const c = await openClient();
  let window = null;
  const openedViews = [];
  const results = [];
  const reclaimErrors = [];
  try {
    const opened = must(
      await c.rpc(
        "project.open",
        { root: FIXTURE_ROOT, alias: "browser-pixels" },
        await resolveControlWindow(c.rpc),
      ),
      "project.open",
    );
    window = opened.routedWindow ?? opened.existingWindow ?? null;
    if (!window) throw new Error(`창 라우팅 실패: ${JSON.stringify(opened)}`);
    // 창 부팅(웹뷰 로드+플러그인 활성화) 대기 — 준비 확인 한정 유한 재시도.
    let panel = null;
    for (let i = 0; i < 120 && !panel; i++) {
      const tree = (await c.rpc("state.tree", {}, window)).data;
      for (const p of tree?.projects ?? []) {
        for (const sp of p.spaces ?? []) {
          for (const pan of sp.panes ?? []) panel ??= pan.id;
        }
      }
      if (!panel) await sleep(500);
    }
    if (!panel) throw new Error("칸 준비 타임아웃");

    for (const engine of ENGINES) {
      const out = { engine, viewId: null, rect: null, unique: 0, rendered: false, note: "" };
      try {
        const o = must(await c.rpc("tab.open", { pane: panel, program: engine }, window), `tab.open ${engine}`);
        out.viewId = o.tabId;
        out.mounted = o.mounted === true;
        openedViews.push(o.tabId);
        // tab.open 은 쓸 수 있는 탭을 답한다 — 아니라고 답했으면 그 사실을 그대로 들고 간다.
        if (!out.mounted) throw new Error("tab.open 이 mounted:false 로 답함(탭이 제때 안 떴다)");
        await c.rpc("tab.activate", { tab: o.tabId }, window);
        // 이 탭을 누가 소유하는지는 물어보면 답이 있다 — 엔진 셋에 다 쏘고 실패를 버리면
        // 안 된다(실측: 활동 로그에 NO_VIEW 가 남았다. 뷰가 없는 플러그인에 지시가 간 것이다).
        // navigate 는 viewId 를 받으므로 "활성 탭이 맞겠지"라는 짐작도 필요 없다.
        const owner = await ownerPluginOf(c, window, o.tabId);
        if (!owner) throw new Error(`탭 ${o.tabId} 의 소유 플러그인을 못 찾음`);
        must(
          await c.rpc(`plugin.${owner}.navigate`, { url: URL, viewId: o.tabId }, window),
          `navigate ${owner}`,
        );
        const m = must(
          await c.rpc("ui.measure", { address: `win/${window}/chrome/layout/tab/${o.tabId}` }, window),
          "ui.measure",
        );
        const r = m.rect;
        out.rect = r;
        // 빈 화면의 이유를 이 자리에서 말할 수 있어야 한다 — 표면이 슬롯 밖이면 픽셀은
        // 당연히 비어 있다. 창을 닫은 뒤에 재면 그 뷰는 이미 없다.
        out.surface = await surfaceBoundsOf(c, window, owner, o.tabId);
        // 본문만 — 크롬(URL 바)은 DOM 이라 항상 그려진다. 위 40px 을 떼고 본문을 본다.
        // 정착 판정은 사건이 아니라 실측 반복이다: 첫 페인트는 엔진 첫 기동(CEF dlopen+헬퍼
        // 스폰)에서 고정 sleep 보다 늦을 수 있다(실측: 부팅 직후 첫 라운드만 검정 — 플래키).
        // SETTLE_MS 는 폴링 상한으로 재해석한다(하한 5s 보장, 1s 간격 완만).
        const snapRect = { x: Math.round(r.x), y: Math.round(r.y) + 40, w: Math.round(r.w), h: Math.round(r.h) - 48 };
        const deadline = Date.now() + Math.max(SETTLE_MS, 5000) + 10_000;
        let v = { unique: 0, rendered: false };
        while (Date.now() < deadline) {
          const shot = must(
            await c.rpc("window.snapshot", { rect: snapRect }, window),
            "window.snapshot",
          );
          const b64 = shot.media?.base64 ?? shot?.base64;
          if (!b64) throw new Error("스냅샷에 base64 없음");
          const png = decodePng(Buffer.from(b64, "base64"));
          v = looksRendered(png);
          if (v.rendered) break;
          await sleep(1000);
        }
        out.unique = v.unique;
        out.rendered = v.rendered;
        // 안 그렸으면 증거를 남긴다 — 판정만 남기고 화면을 버리면 다음 사람이 처음부터 다시
        // 재현해야 한다. 창 전체를 찍어 "이 엔진만 빈 것인지 창이 통째로 빈 것인지"를 남긴다.
        if (!v.rendered) {
          const full = must(
            await c.rpc("window.snapshot", { path: `${EVIDENCE_DIR}/${engine}.png` }, window),
            "window.snapshot(evidence)",
          );
          out.evidence = full.saved ?? null;
        }
      } catch (e) {
        out.note = String(e?.message ?? e).slice(0, 160);
      }
      results.push(out);
      console.log(
        `  ${out.engine.padEnd(34)} view=${String(out.viewId).padEnd(5)} mounted=${out.mounted ? "y" : "n"} 슬롯${out.rect ? `(${Math.round(out.rect.x)},${Math.round(out.rect.y)} ${Math.round(out.rect.w)}x${Math.round(out.rect.h)})` : "(-)"} 표면${out.surface ? `(${out.surface.x},${out.surface.y} ${out.surface.w}x${out.surface.h})` : "(보고없음)"} 고유색=${String(out.unique).padStart(4)} ${out.rendered ? "GREEN" : "RED"}${out.evidence ? ` 증거=${out.evidence}` : ""}${out.note ? ` (${out.note})` : ""}`,
      );
    }
  } finally {
    // 회수는 멱등의 값이다 — 다음 실행이 앞 실행의 잔재 위에서 시작하면 그건 게이트가 아니다.
    // 실패를 삼키지 않는다(실측: window.close 가 인자 누락으로 죽는데 catch 가 먹어, 실행할
    // 때마다 같은 창에 브라우저 뷰가 3개씩 쌓여 18개가 됐다).
    if (window) {
      for (const v of openedViews) {
        const r = await c.rpc("tab.close", { tab: v }, window).catch((e) => ({ ok: false, message: String(e) }));
        if (r?.ok !== true) reclaimErrors.push(`tab.close ${v}: ${JSON.stringify(r)?.slice(0, 120)}`);
      }
      // 회수 경로는 둘이고, 어느 쪽인지는 그 창이 무엇을 담고 있는가로 갈린다.
      //  - 픽스처 프로젝트만 담긴 창 → 창을 닫는다. 그 창은 우리 잔재다.
      //  - 사람의 프로젝트도 함께 있는 창 → 픽스처 프로젝트만 뺀다. 그 창은 사람의 것이다.
      // 응답 필드의 뜻을 짐작하지 않는다(실측: routedWindow 를 "새 창"으로 읽어 사용자 창을
      // 닫았다). 마지막 프로젝트는 닫을 수 없으므로(LAST_ITEM) 경로를 섞으면 회수가 실패한다.
      const state = (await c.rpc("state.tree", {}, window)).data;
      const projects = state?.projects ?? [];
      const ours = projects.filter((x) => x.root === FIXTURE_ROOT);
      if (ours.length > 0 && ours.length === projects.length) {
        const r = await c.rpc("window.close", {}, window).catch((e) => ({ ok: false, message: String(e) }));
        if (r?.ok !== true) reclaimErrors.push(`window.close ${window}: ${JSON.stringify(r)?.slice(0, 120)}`);
      } else {
        for (const pr of ours) {
          const r = await c.rpc("project.close", { project: pr.id }, window).catch((e) => ({ ok: false, message: String(e) }));
          if (r?.ok !== true) reclaimErrors.push(`project.close ${pr.id}: ${JSON.stringify(r)?.slice(0, 120)}`);
        }
      }
    }
  }

  // 새로 연 뷰만 보는 것은 절반이다 — 새 뷰는 방금 bounds 를 받았으니 언제나 맞다. 이미 떠
  // 있던 뷰가 어긋나는 것이 실제 증상이었다(실측: 슬롯 x=756.5 인데 표면 x=556 → 그 패널은
  // 백지, 옆 자리에 낡은 사이드바 한 벌). 그래서 살아 있는 창의 모든 브라우저 뷰를 검사한다:
  // 표면이 자기 슬롯에 있는가.
  const drift = [];
  try {
    const ctrl = await resolveControlWindow(c.rpc);
    const wins = (await c.rpc("window.list", {}, ctrl)).data?.labels ?? [];
    for (const win of wins.filter((l) => l.startsWith("w-"))) {
      const tree = (await c.rpc("state.tree", {}, win)).data;
      const views = [];
      for (const p of tree?.projects ?? []) {
        for (const sp of p.spaces ?? []) {
          for (const pan of sp.panels ?? []) {
            for (const v of pan.views ?? []) {
              if (typeof v.plugin === "string" && v.plugin.includes("browser")) views.push(v);
            }
          }
        }
      }
      if (views.length === 0) continue;
      const maps = {};
      for (const plug of ["soksak-plugin-browser-chromium", "soksak-plugin-browser-chromium-offscreen"]) {
        const d = (await c.rpc(`plugin.${plug}.stats`, {}, win)).data ?? {};
        const surfaces = (d.engine ?? d).surfaces ?? [];
        const byId = Object.fromEntries(surfaces.map((s) => [s.id, s.bounds ?? null]));
        const pairs = plug.endsWith("offscreen")
          ? (d.ids ?? []).map((x) => [x.viewId, x.surfaceId])
          : Object.entries(d.idMap ?? {}).map(([k, v]) => [k.replace("chromium-", ""), v]);
        for (const [viewId, sid] of pairs) maps[viewId] = byId[sid] ?? null;
      }
      for (const v of views) {
        const b = maps[v.id];
        if (b == null) continue; // 표면 기하를 보고하지 않는 엔진(native) — 이 축의 대상 아님
        const m = (await c.rpc("ui.measure", { address: `win/${win}/chrome/layout/tab/${v.id}` }, win)).data;
        const r = m?.rect;
        if (!r) continue;
        // 표면은 슬롯과 같지 않다 — 브라우저 자체 툴바(URL 바) 아래에 놓이므로 위가 잘린다
        // (실측: 슬롯 h=449 vs 표면 h=421, 차이 28 = 툴바). 그래서 동일성이 아니라 포함을
        // 단언한다. 실제 결함은 언제나 "슬롯 밖"이었다(실측: x 가 200px 어긋나 패널은 백지,
        // 옛 자리에 사이드바가 한 벌 더 남음). 슬롯을 벗어나면 그건 항상 틀린 것이다.
        const tol = 2;
        const outside =
          b.x < Math.ceil(r.x) - tol ||
          b.y < Math.ceil(r.y) - tol ||
          b.x + b.w > Math.ceil(r.x) + Math.ceil(r.w) + tol ||
          b.y + b.h > Math.ceil(r.y) + Math.ceil(r.h) + tol;
        console.log(
          `  ${String(v.plugin).padEnd(42)} ${String(v.id).padEnd(5)} 슬롯(${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}) 표면(${b.x},${b.y} ${b.w}x${b.h}) ${outside ? "슬롯 밖" : "포함"}`,
        );
        if (outside) drift.push({ view: v.id, plugin: v.plugin, slot: r, surface: b });
      }
    }
  } finally {
    c.close();
  }
  if (drift.length > 0) {
    console.log(`✗ browser-pixels 실패 — 표면이 슬롯을 벗어난 뷰 ${drift.length}개`);
    process.exit(1);
  }
  const bad = results.filter((r) => !r.rendered);
  if (bad.length > 0) {
    console.log(`✗ browser-pixels 실패 — 그리지 않는 엔진 ${bad.length}개: ${bad.map((b) => b.engine).join(", ")}`);
    process.exit(1);
  }
  if (reclaimErrors.length > 0) {
    console.log(`✗ browser-pixels 실패 — 회수 실패 ${reclaimErrors.length}건(다음 실행이 잔재 위에서 시작한다)`);
    for (const e of reclaimErrors) console.log(`    ${e}`);
    process.exit(1);
  }
  console.log(`✓ browser-pixels GREEN — 엔진 ${results.length}개 전부 픽셀 확인`);
}

main().catch((e) => {
  console.error(`✗ browser-pixels 오류: ${e?.message ?? e}`);
  process.exit(1);
});
