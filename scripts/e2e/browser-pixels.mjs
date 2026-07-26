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
// 실행: SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/browser-pixels.mjs
// 멱등: 전용 root 의 임시 창 하나에서만 동작하고(사용자 워크스페이스 무접촉) 끝에 닫는다.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const SOCKET =
  process.env.SOKSAK_SOCKET ||
  path.join(os.homedir(), ".soksak-debug", "com.soksak.debug.sock");
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

async function main() {
  const c = await openClient();
  let window = null;
  const results = [];
  try {
    const opened = must(
      await c.rpc("project.open", { root: FIXTURE_ROOT, alias: "browser-pixels" }, "main"),
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
          for (const pan of sp.panels ?? []) panel ??= pan.id;
        }
      }
      if (!panel) await sleep(500);
    }
    if (!panel) throw new Error("패널 준비 타임아웃");

    for (const engine of ENGINES) {
      const out = { engine, viewId: null, rect: null, unique: 0, rendered: false, note: "" };
      try {
        const o = must(await c.rpc("view.open", { panel, program: engine }, window), `view.open ${engine}`);
        out.viewId = o.viewId;
        await c.rpc("view.activate", { view: o.viewId }, window);
        // 항행 후 정착 — 로딩 완료 신호가 없는 엔진이 있어 유한 대기로 수렴시킨다.
        for (const plug of [
          "soksak-plugin-browser-native",
          "soksak-plugin-browser-chromium",
          "soksak-plugin-browser-chromium-offscreen",
        ]) {
          await c.rpc(`plugin.${plug}.navigate`, { url: URL }, window).catch(() => {});
        }
        await sleep(5000);
        const m = must(
          await c.rpc("ui.measure", { address: `win/${window}/chrome/layout/slot/${o.viewId}` }, window),
          "ui.measure",
        );
        const r = m.rect;
        out.rect = r;
        // 본문만 — 크롬(URL 바)은 DOM 이라 항상 그려진다. 위 40px 을 떼고 본문을 본다.
        const shot = must(
          await c.rpc(
            "window.snapshot",
            { rect: { x: Math.round(r.x), y: Math.round(r.y) + 40, w: Math.round(r.w), h: Math.round(r.h) - 48 } },
            window,
          ),
          "window.snapshot",
        );
        const b64 = shot.media?.base64 ?? shot?.base64;
        if (!b64) throw new Error("스냅샷에 base64 없음");
        const png = decodePng(Buffer.from(b64, "base64"));
        const v = looksRendered(png);
        out.unique = v.unique;
        out.rendered = v.rendered;
      } catch (e) {
        out.note = String(e?.message ?? e).slice(0, 160);
      }
      results.push(out);
      console.log(
        `  ${out.engine.padEnd(34)} view=${String(out.viewId).padEnd(5)} 고유색=${String(out.unique).padStart(4)} ${out.rendered ? "GREEN" : "RED"}${out.note ? ` (${out.note})` : ""}`,
      );
    }
  } finally {
    if (window) await c.rpc("window.close", {}, window).catch(() => {});
  }

  // 새로 연 뷰만 보는 것은 절반이다 — 새 뷰는 방금 bounds 를 받았으니 언제나 맞다. 이미 떠
  // 있던 뷰가 어긋나는 것이 실제 증상이었다(실측: 슬롯 x=756.5 인데 표면 x=556 → 그 패널은
  // 백지, 옆 자리에 낡은 사이드바 한 벌). 그래서 살아 있는 창의 모든 브라우저 뷰를 검사한다:
  // 표면이 자기 슬롯에 있는가.
  const drift = [];
  try {
    const wins = (await c.rpc("window.list")).data?.labels ?? [];
    for (const win of wins.filter((l) => l !== "main")) {
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
        const m = (await c.rpc("ui.measure", { address: `win/${win}/chrome/layout/slot/${v.id}` }, win)).data;
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
  console.log(`✓ browser-pixels GREEN — 엔진 ${results.length}개 전부 픽셀 확인`);
}

main().catch((e) => {
  console.error(`✗ browser-pixels 오류: ${e?.message ?? e}`);
  process.exit(1);
});
