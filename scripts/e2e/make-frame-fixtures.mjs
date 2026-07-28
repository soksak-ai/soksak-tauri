// 픽셀 오라클의 픽스처를 만든다 — 판정기가 무엇을 백지로 보는지는 실물 바이트로만 증명된다.
//
// 멱등: 같은 소스로 다시 돌리면 같은 바이트가 나온다(난수 없음). 출처는 frames.json 에
// 값으로 남는다 — 어느 것이 실물 캡처에서 왔고 어느 것이 합성인지 픽스처를 보는 사람이
// 코드를 읽지 않고도 알아야 한다.
//
// 실행:
//   node scripts/e2e/make-frame-fixtures.mjs --source <실물캡처.png>
//   node scripts/e2e/make-frame-fixtures.mjs            # 합성분만 재생성(실물 파생분은 유지)
//
// --source 없이 실물 파생 픽스처가 아직 없으면 만들지 않고 실패한다 — 조용히 빼먹지 않는다.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./lib/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "fixtures", "frames");

/** 앱 배경색(어두운 크롬) — 실물 캡처의 빈 구멍이 보이는 바로 그 색. */
const APP_BG = [0x1c, 0x1c, 0x1c];

function rgbaFill(w, h, [r, g, b]) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return { w, h, ch: 4, px };
}

/** 세로 그라디언트 — 고유색은 많고 국소 대비는 없다(색 수 휴리스틱의 사각지대). */
function gradient(w, h) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round((y / Math.max(1, h - 1)) * 200) + 20;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = Math.min(255, v + 8);
    }
  }
  return { w, h, ch: 3, px };
}

function crop(img, x0, y0, w, h) {
  const px = Buffer.alloc(w * h * img.ch);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.w + x0) * img.ch;
    img.px.copy(px, y * w * img.ch, src, src + w * img.ch);
  }
  return { w, h, ch: img.ch, px };
}

/** 정수배 면적 평균 축소 — 실물 캡처를 픽스처 크기로 줄이되 구조(글자 대비)를 남긴다. */
function shrink(img, factor) {
  const w = Math.floor(img.w / factor);
  const h = Math.floor(img.h / factor);
  const ch = img.ch;
  const px = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            sum += img.px[((y * factor + dy) * img.w + (x * factor + dx)) * ch + c];
          }
        }
        px[(y * w + x) * ch + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return { w, h, ch, px };
}

/** 콘텐츠 영역을 단색으로 덮는다 — 네이티브 자식이 캡처에 안 찍힌 프레임의 모양. */
function stampHole(img, rect, [r, g, b]) {
  const px = Buffer.from(img.px);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.w + x) * img.ch;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      if (img.ch === 4) px[i + 3] = 255;
    }
  }
  return { ...img, px };
}

function write(name, bytes, provenance, entries) {
  fs.writeFileSync(path.join(OUT, name), bytes);
  entries[name] = {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16),
    ...provenance,
  };
  console.log(`  ${name.padEnd(22)} ${String(bytes.length).padStart(8)} B  ${provenance.origin}`);
}

function main() {
  const argv = process.argv.slice(2);
  const si = argv.indexOf("--source");
  const source = si >= 0 ? argv[si + 1] : null;
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, "frames.json");
  const entries = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).frames ?? {}
    : {};

  console.log("픽셀 오라클 픽스처");

  // 합성 — 백지의 두 얼굴. 단색(구멍이 앱 배경으로 메워진 것)과 그라디언트(색은 많은데
  // 구조가 없는 것).
  write("blank-window.png", encodePng(rgbaFill(1512, 982, APP_BG)),
    { origin: "합성", note: "창 전체가 앱 배경색 단색 — 아무것도 안 그려진 프레임" }, entries);
  write("blank-gradient.png", encodePng(gradient(640, 400)),
    { origin: "합성", note: "세로 그라디언트 — 고유색 수십, 국소 대비 0" }, entries);
  // 레티나 창 전체 백지. 파일 크기로 판정하면 이게 rendered-slot(실렌더)보다 무겁다 —
  // 크기 임계가 순서를 뒤집는 실측 반례다.
  write("blank-retina.png", encodePng(rgbaFill(3024, 1964, APP_BG)),
    { origin: "합성", note: "레티나 창 전체 단색 — 크기는 실렌더 슬롯보다 크다" }, entries);

  const derived = ["rendered-window.png", "rendered-slot.png", "hole-window.png"];
  if (!source) {
    const missing = derived.filter((n) => !fs.existsSync(path.join(OUT, n)));
    if (missing.length) {
      console.error(`실물 파생 픽스처 없음: ${missing.join(", ")} — --source <캡처.png> 로 만들어라`);
      process.exit(1);
    }
    console.log("  (실물 파생분 유지 — --source 없음)");
  } else {
    const raw = fs.readFileSync(source);
    const img = decodePng(raw);
    const stat = fs.statSync(source);
    const prov = {
      origin: "실물 캡처 파생",
      source: path.resolve(source),
      sourceSize: `${img.w}x${img.h}`,
      sourceMtime: stat.mtime.toISOString(),
      sourceSha256: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16),
    };

    const win = shrink(img, 4);
    write("rendered-window.png", encodePng(win),
      { ...prov, note: "창 전체를 1/4 로 축소 — 정상 렌더" }, entries);

    // 뷰 슬롯 크기의 원본 해상도 크롭. 축소 없이 실물 픽셀 그대로다.
    const sx = Math.floor(img.w * 0.3);
    const sy = Math.floor(img.h * 0.25);
    write("rendered-slot.png", encodePng(crop(img, sx, sy, 320, 200)),
      { ...prov, note: `원본 해상도 크롭 (${sx},${sy} 320x200) — 뷰 슬롯 하나 크기의 정상 렌더` }, entries);

    // 크롬은 그대로, 콘텐츠 영역만 단색 — Electron capturePage 가 네이티브 자식을 못 찍은
    // 프레임과 같은 모양이다.
    const hole = {
      x: Math.floor(win.w * 0.26),
      y: Math.floor(win.h * 0.08),
      w: Math.floor(win.w * 0.70),
      h: Math.floor(win.h * 0.62),
    };
    write("hole-window.png", encodePng(stampHole(win, hole, APP_BG)),
      { ...prov, note: `rendered-window 위에 콘텐츠 구멍 합성 rect=(${hole.x},${hole.y} ${hole.w}x${hole.h})`, hole }, entries);
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify({ generator: "scripts/e2e/make-frame-fixtures.mjs", frames: entries }, null, 2)}\n`);
  console.log(`  frames.json 갱신`);
}

main();
