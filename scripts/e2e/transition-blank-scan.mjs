// 전이 중 **빈 판** 게이트 — 판이 옮겨가는 동안 어느 판도 비지 않는다.
//
// 왜 필요한가: 이 결함은 한 프레임짜리다. 정지 캡처는 못 잡고, 눈으로는 "깜빡였다"까지만
// 말할 수 있다. 그래서 지금까지 판정이 인상에 매여 있었다.
//
// 고정 사각형으로 재면 안 된다 — 전이 중에는 판이 **움직인다**. 옛 자리를 재면 판 사이의
// 빈 공간을 재고, 그것을 "판이 비었다"로 읽는다(실측 2026-08-03: 그 착시로 결함이 남아
// 있다고 잘못 읽었다). 그러므로 매 걸음마다 판의 **자기 rect** 를 다시 물어 그 자리를 잰다.
//
// 방법: 모션을 느리게(scale) 건 뒤 전이를 시작하고, 걸음마다 **정지**(hold)시켜
//   ① webview.surfaces 로 각 판의 지금 rect 와 표면 정합(detached)을 읽고
//   ② 그 rect 를 잘라 캡처해 색 분포(표준편차)를 본다.
// 정지 상태라 캡처와 화면이 어긋날 수 없다 — 시간 추측이 없다.
//
// 판정:
//   - detached > 0 이면 실패(표면이 자기 자리 밖에 있다 = 좌표가 두 기준).
//   - 어느 걸음에서든 판의 자기 rect 가 평평하면 실패(빈 판).
//
// 실행: SOKSAK_SOCKET=<앱 소켓> node scripts/e2e/transition-blank-scan.mjs
// 멱등: 모션 설정을 원래대로 되돌리고 끝난다. 창을 만들지도 닫지도 않는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { openClient, requireSocket, workspaceWindows } from "./lib/client.mjs";

/** 전이를 몇 배로 늘려 볼 것인가 — 걸음 사이에 실제 프레임이 들어갈 만큼. */
const SCALE = 25;
/** 걸음 수 — 전이 전체를 고르게 훑는다. */
const STEPS = 8;
/** 걸음 사이 실시간 대기(ms). 느려진 전이에서 이만큼이 한 조각이다. */
const STEP_MS = 400;
/**
 * 판정은 **그 판 자신과의 비교**다.
 *
 * 절대 문턱은 못 쓴다: 내용이 적은 터미널은 가만히 있어도 평평하고(실측 2026-08-03: 7.3),
 * 진짜로 비어 버린 브라우저 판도 비슷한 값이 나온다(3.7). 두 사실이 한 숫자를 공유하면
 * 문턱은 둘 중 하나를 반드시 틀리게 읽는다. 그래서 먼저 **정지 상태의 그 판**을 재 두고,
 * 전이 중에 그 값에서 떨어졌는지를 본다 — "그려지던 판이 안 그려졌다"가 결함의 정의다.
 */
const DROP_RATIO = 0.35;
/** 정지 상태에서도 이보다 평평하면 잴 수 없는 판이다 — 오라클이 죽었다고 알린다. */
const BASELINE_FLOOR = 2;
/**
 * 기준선은 **스스로 안정을 증명해야** 한다.
 *
 * 아직 적재 중인 페이지는 한 번 재면 그려져 보이고 다음 순간 하얘진다 — 그 흔들림을 기준선으로
 * 삼으면 "전이 중에 비었다"로 읽힌다(실측 2026-08-03: 새로고침 직후 한 판이 49.9 → 3.0,
 * 곧바로 다시 돌리면 통과). 그래서 두 번 재서 붙어 있는 판만 잰다. 흔들리는 판은 **세지 않고
 * 그 사실을 적는다** — 조용히 빼면 "전부 검사했다"로 읽힌다.
 */
const BASELINE_GAP_MS = 700;
const BASELINE_DRIFT = 0.2;

const OUT = path.join(os.homedir(), ".soksak-e2e", "transition-blank");

function decodePng(buf) {
  // 최소 PNG 판독 — 8비트 RGB/RGBA, 인터레이스 없음(앱 캡처가 내는 모양).
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNG 가 아니다");
  let p = 8;
  let w = 0;
  let h = 0;
  let ch = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const color = data[9];
      if (data[8] !== 8) throw new Error("8비트만 읽는다");
      ch = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (!ch) throw new Error(`색 타입 ${color} 는 안 읽는다`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, px: out };
}

/** 밝기의 표준편차 — 평평하면 아무것도 안 그려진 것이다. */
function stddev(img) {
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (let y = 0; y < img.h; y += 2) {
    for (let x = 0; x < img.w; x += 2) {
      const i = y * img.w * img.ch + x * img.ch;
      const l = (img.px[i] * 299 + img.px[i + 1] * 587 + img.px[i + 2] * 114) / 1000;
      n += 1;
      sum += l;
      sq += l * l;
    }
  }
  if (n === 0) return null;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 이 판이 지금 실제로 그려진 정도.
 *
 * 자르기는 **앱이** 한다 — 캡처와 같은 함수라 좌표계를 두 번 정의하지 않는다. 본문만 본다:
 * 툴바(위 40px)는 판이 살아 있어도 단조로울 수 있다. 그림은 **봉투의 media 채널**로 온다.
 */
async function paneStddev(cli, win, b, savePath) {
  if (b.w < 8 || b.h < 48) return null;
  const shot = await cli.rpc(
    "window.snapshot",
    { rect: { x: b.x, y: b.y + 40, w: b.w, h: b.h - 40 }, base64: true },
    win,
  );
  if (!shot?.ok) throw new Error(`window.snapshot: ${shot?.code} ${shot?.message}`);
  const b64 = shot.media?.base64;
  if (!b64) throw new Error("캡처가 base64 를 안 줬다");
  const buf = Buffer.from(b64, "base64");
  if (savePath) fs.writeFileSync(savePath, buf);
  return stddev(decodePng(buf));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cli = await openClient(requireSocket());
  const ok = (r, what) => {
    if (!r?.ok) throw new Error(`${what}: ${r?.code} ${r?.message}`);
    return r.data ?? {};
  };
  // 판이 사는 곳은 워크스페이스 창이다 — 컨트롤 플레인(main)에는 판이 없다. 창이 여럿이면
  // **판이 가장 많은 창**을 고른다: 첫 창을 집으면 판 하나짜리 창이 걸려 전이를 못 일으킨다.
  const wins = await workspaceWindows(cli);
  let win = null;
  let ids = [];
  for (const w of wins) {
    const t = ok(await cli.rpc("ui.tree", {}, w), "ui.tree");
    const found = [...new Set(JSON.stringify(t).match(/pan-[a-z0-9]+/g) ?? [])];
    if (found.length > ids.length) {
      ids = found;
      win = w;
    }
  }
  if (!win) throw new Error("워크스페이스 창이 없다 — 잴 판이 없다");
  const fail = [];
  try {
    // 판을 활성화한다 — 전이를 일으키는 가장 작은 조작.
    const surfaces0 = ok(await cli.rpc("webview.surfaces", {}, win), "webview.surfaces");
    if (ids.length < 2) throw new Error("판이 둘 미만 — 전이를 일으킬 수 없다");
    if ((surfaces0.bodies ?? []).length === 0) throw new Error("잴 판이 없다");

    // 정지 상태의 기준선 — 판마다 자기 값을 갖고, 두 번 재서 붙어 있어야 쓴다.
    const first = new Map();
    for (const b of surfaces0.bodies) {
      const sd = await paneStddev(cli, win, b);
      if (sd !== null) first.set(b.node, sd);
    }
    await sleep(BASELINE_GAP_MS);
    const base = new Map();
    const unsettled = [];
    for (const b of surfaces0.bodies) {
      const a = first.get(b.node);
      const sd = await paneStddev(cli, win, b);
      if (a === undefined || sd === null) continue;
      const hi = Math.max(a, sd);
      if (hi > 0 && Math.abs(a - sd) / hi > BASELINE_DRIFT) {
        unsettled.push(`${b.node} (${a.toFixed(1)} → ${sd.toFixed(1)})`);
        continue;
      }
      base.set(b.node, Math.min(a, sd));
    }
    if (unsettled.length)
      console.log(`transition-blank-scan: 아직 정착 안 된 판은 세지 않는다 — ${unsettled.join(", ")}`);
    const dead = [...base.entries()].filter(([, v]) => v < BASELINE_FLOOR);
    if (dead.length)
      throw new Error(`정지 상태에서 이미 평평한 판이 있다(오라클 사망): ${dead.map(([k]) => k).join(", ")}`);
    if (base.size === 0) throw new Error("기준선을 세운 판이 하나도 없다 — 잴 것이 없다");
    console.log(`transition-blank-scan: 기준선 ${base.size}판`);

    ok(await cli.rpc("ui.motion", { scale: SCALE }, win), "ui.motion scale");
    ok(await cli.rpc("pane.activate", { pane: ids[0] }, win), "pane.activate");

    for (let step = 0; step < STEPS; step++) {
      ok(await cli.rpc("ui.motion", { hold: true }, win), "ui.motion hold");
      const s = ok(await cli.rpc("webview.surfaces", {}, win), "webview.surfaces");
      const detached = s.contentViews?.detached ?? [];
      if (detached.length) fail.push(`step ${step}: 표면이 자기 자리 밖 — ${detached.join(", ")}`);
      for (const b of s.bodies ?? []) {
        const b0 = base.get(b.node);
        if (b0 === undefined) continue; // 전이 중 새로 생긴 판 — 기준선이 없다
        const sd = await paneStddev(cli, win, b, path.join(OUT, `step${step}.png`));
        if (sd !== null && sd < b0 * DROP_RATIO) {
          fail.push(
            `step ${step}: 빈 판 ${b.node} (stddev ${sd.toFixed(1)} — 정지 ${b0.toFixed(1)})`,
          );
        }
      }
      ok(await cli.rpc("ui.motion", { hold: false }, win), "ui.motion resume");
      await sleep(STEP_MS);
    }
  } finally {
    await cli.rpc("ui.motion", { hold: false, scale: 1 }, win).catch(() => {});
    cli.close();
  }
  if (fail.length) {
    console.error("transition-blank-scan: FAIL");
    for (const f of fail) console.error("  -", f);
    process.exit(1);
  }
  console.log(`transition-blank-scan: PASS (걸음 ${STEPS} — 빈 판 0, 자리 밖 표면 0)`);
}

main().catch((e) => {
  console.error("transition-blank-scan: ERROR", e.message);
  process.exit(2);
});
