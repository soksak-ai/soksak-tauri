// 픽셀 오라클 — PNG 바이트만 보고 "이 프레임이 그려졌는가"를 답한다.
//
// 왜 캡처에서 떼어 놓나: 같은 이름의 캡처 명령이 프레임워크마다 다른 것을 찍는다(Tauri 는 창 합성물,
// Electron capturePage 는 네이티브 자식이 빠진 그림). 판정까지 캡처에 붙어 있으면 "그려졌다"가
// 셸마다 다른 뜻이 된다. 여기는 순수 함수만 둔다 — 누가 어떻게 찍었든 같은 자로 잰다.
//
// 왜 파일 크기가 아닌가(기존 휴리스틱: 41KB=백지 / 190KB=실렌더):
//   ① 크기는 압축률의 그림자다. 해상도·셸·내용이 바뀌면 임계가 따라 움직인다. 실측
//      (fixtures/frames): 백지 레티나 창 27,697B > 실렌더 슬롯 크롭 18,840B — 순서가 뒤집힌다.
//   ② 크기는 스칼라라 "어디가" 비었는지 못 말한다. 크롬은 그려지고 콘텐츠만 구멍인 프레임
//      (46,629B)은 크기로 보면 멀쩡한 렌더다. 그게 바로 네이티브 자식이 안 찍힌 모습이다.
//
// 판정은 세 가지 사실 위에 선다 — 색 분포(단색인가), 엔트로피(정보가 있는가),
// 국소 대비(이웃 표본 사이에 경계가 있는가). 셋 다 값으로 돌려준다.
//
// 한 장으로는 못 하는 것(오라클의 한계 — 감추지 않는다): 평평한 구역이 "원래 여백"인지
// "있어야 할 것이 안 찍힌 구멍"인지는 프레임 안에 답이 없다. 실렌더 창에도 여백은 있다
// (실측: rendered-window 는 16 구역 중 3 이 평평하다). 그래서 구멍을 지목하려면 밖에서
// 사실을 하나 줘야 한다 — 콘텐츠가 있어야 할 rect(region) 이거나, 같은 창의 정상 프레임
// (compareFrames). 둘 다 없으면 오라클은 "여기가 평평하다"까지만 말한다.

import { decodePng } from "./png.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** 백지로 본 이유 — 열거값이다. 호출자가 문자열을 짜맞추지 않게. */
export const BLANK_REASONS = Object.freeze({
  SOLID_FILL: "SOLID_FILL", // 사실상 한 색으로 덮여 있다
  FEW_COLORS: "FEW_COLORS", // 색이 손에 꼽는다
  FLAT_LUMA: "FLAT_LUMA", // 밝기 분포에 정보가 없다
  FLAT_STRUCTURE: "FLAT_STRUCTURE", // 색은 있으나 경계가 없다(그라디언트·단색 노이즈)
  TILES_BLANK: "TILES_BLANK", // 전체는 그려졌는데 빈 구역이 있다
});

// 임계 — fixtures/frames 실측(scripts/e2e/frame-verdict.mjs 출력)으로 정했다. 실렌더와 백지가
// 경계 비율에서 자릿수로 갈린다(14.9~19.0% 대 0.0%) — edgeFloor 0.5% 는 30배 마진이다.
//   rendered-window: 고유색 212 / 최빈 81.5% / 엔트로피 0.2333 / 경계 14.9%
//   rendered-slot:   고유색 163 / 최빈 82.0% / 엔트로피 0.2121 / 경계 19.0%
//   hole-window:     고유색 116 / 최빈 50.0% / 엔트로피 0.2607 / 경계  5.8%
//   blank-gradient:  고유색  67 / 최빈  1.5% / 엔트로피 0.9264 / 경계  0.0%
//     ← 색 수(67)로도 엔트로피(0.93)로도 안 잡힌다. 경계가 없어야 백지로 걸린다.
//   blank-window:    고유색   1 / 최빈  100% / 엔트로피 0.0000 / 경계  0.0%
export const DEFAULTS = Object.freeze({
  sampleLines: 60, // 짧은 변을 이 개수로 훑는다(= 표본 격자 간격)
  tiles: 4, // 구역 판정 격자(4x4). 구멍의 위치를 이 해상도로 짚는다
  solidRatio: 0.99, // 최빈색이 이 비율 이상이면 단색
  minColors: 8, // 고유색이 이보다 적으면 백지(기존 browser-pixels 기준과 같은 값)
  entropyFloor: 0.02, // 정규 엔트로피(0..1) 바닥
  edgeDelta: 12, // 이웃 표본 밝기 차가 이보다 크면 경계 하나
  edgeFloor: 0.005, // 경계 비율 바닥 — 이보다 낮으면 그림이 아니라 면이다
});

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** IHDR 만 읽는다 — 디코더에 넘기기 전에 감당 못 하는 형식을 이름 달고 거절하려고. */
export function readPngHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw fail("NOT_PNG", `PNG 서명이 아니다(${buf.length}B)`);
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw fail("NOT_PNG", "첫 청크가 IHDR 이 아니다");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
    channels: CHANNELS[buf[25]] ?? null,
  };
}

/** 표본 격자 — 이미지 전체를 다 읽지 않고 같은 간격으로 훑는다(결정적: 같은 바이트=같은 격자). */
function sampleGrid(img, rect, step) {
  const xs = [];
  const ys = [];
  for (let x = rect.x; x < rect.x + rect.w; x += step) xs.push(x);
  for (let y = rect.y; y < rect.y + rect.h; y += step) ys.push(y);
  const rgb = new Int32Array(xs.length * ys.length);
  const luma = new Uint8Array(xs.length * ys.length);
  for (let r = 0; r < ys.length; r++) {
    for (let c = 0; c < xs.length; c++) {
      const i = (ys[r] * img.w + xs[c]) * img.ch;
      const R = img.px[i];
      const G = img.ch >= 3 ? img.px[i + 1] : R;
      const B = img.ch >= 3 ? img.px[i + 2] : R;
      const k = r * xs.length + c;
      rgb[k] = (R << 16) | (G << 8) | B;
      luma[k] = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
  }
  return { xs, ys, rgb, luma, cols: xs.length, rows: ys.length };
}

const round = (v, d) => Number(v.toFixed(d));
const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, "0")}`;

/** 격자의 한 구역을 재서 값으로 만든다. 판정은 이 값들 위에서만 이뤄진다. */
function measure(grid, c0, c1, r0, r1, opt) {
  const counts = new Map();
  const hist = new Uint32Array(64);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const k = r * grid.cols + c;
      const color = grid.rgb[k];
      counts.set(color, (counts.get(color) ?? 0) + 1);
      const l = grid.luma[k];
      hist[l >> 2] += 1;
      sum += l;
      sumSq += l * l;
      n += 1;
    }
  }
  let dominant = 0;
  let dominantN = 0;
  for (const [color, cnt] of counts) {
    if (cnt > dominantN) {
      dominantN = cnt;
      dominant = color;
    }
  }
  let entropy = 0;
  for (const cnt of hist) {
    if (!cnt) continue;
    const p = cnt / n;
    entropy -= p * Math.log2(p);
  }
  // 이웃 표본(오른쪽·아래) 사이의 밝기 차 — 글자·테두리가 있으면 경계가 선다.
  let pairs = 0;
  let edges = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const k = r * grid.cols + c;
      if (c + 1 < c1) {
        pairs += 1;
        if (Math.abs(grid.luma[k] - grid.luma[k + 1]) >= opt.edgeDelta) edges += 1;
      }
      if (r + 1 < r1) {
        pairs += 1;
        if (Math.abs(grid.luma[k] - grid.luma[k + grid.cols]) >= opt.edgeDelta) edges += 1;
      }
    }
  }
  const mean = sum / n;
  return {
    samples: n,
    uniqueColors: counts.size,
    dominantColor: hex(dominant),
    dominantRatio: round(dominantN / n, 4),
    lumaMean: round(mean, 2),
    lumaStdDev: round(Math.sqrt(Math.max(0, sumSq / n - mean * mean)), 2),
    lumaEntropy: round(entropy / 6, 4), // 64 빈 → 최대 6 bit 로 정규화
    lumaEntropyBits: round(entropy, 4),
    edgeRatio: pairs ? round(edges / pairs, 4) : 0,
    edgePairs: pairs,
  };
}

/** 재 놓은 값에서 백지 여부를 가른다. 먼저 걸리는 이유가 답이다. */
function classify(m, opt) {
  if (m.dominantRatio >= opt.solidRatio) return BLANK_REASONS.SOLID_FILL;
  if (m.uniqueColors < opt.minColors) return BLANK_REASONS.FEW_COLORS;
  if (m.lumaEntropy < opt.entropyFloor) return BLANK_REASONS.FLAT_LUMA;
  if (m.edgeRatio < opt.edgeFloor) return BLANK_REASONS.FLAT_STRUCTURE;
  return null;
}

/**
 * PNG 바이트 → 판정.
 *
 * @param {Buffer|Uint8Array} bytes PNG(8-bit, non-interlaced)
 * @param {object} [options] region {x,y,w,h}(픽셀) 로 물으면 그 구역만 잰다. 임계는 DEFAULTS 참고.
 * @returns {{verdict:"DRAWN"|"PARTIAL"|"BLANK", drawn:boolean, reason:string|null, summary:string,
 *            image:object, sampling:object, metrics:object, tiles:object[], holes:object}}
 *   drawn = "무언가 그려졌다"(BLANK 아님). PARTIAL 은 그리긴 그렸는데 빈 구역이 있다는 사실이고,
 *   그 구역 몇 개까지 봐줄지는 게이트가 holes 값을 보고 정한다 — 오라클은 사실만 준다.
 */
export function judgeFrame(bytes, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const head = readPngHeader(bytes);
  if (head.bitDepth !== 8) throw fail("UNSUPPORTED_PNG", `8-bit 만 잰다(bitDepth=${head.bitDepth})`);
  if (head.channels === null) throw fail("UNSUPPORTED_PNG", `팔레트/미지 컬러타입 ${head.colorType}`);
  if (head.interlace !== 0) throw fail("UNSUPPORTED_PNG", "인터레이스 PNG 는 못 읽는다");
  if (!head.width || !head.height) throw fail("UNSUPPORTED_PNG", `크기 0 (${head.width}x${head.height})`);

  const img = decodePng(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const req = options.region ?? { x: 0, y: 0, w: img.w, h: img.h };
  const x = Math.max(0, Math.round(req.x));
  const y = Math.max(0, Math.round(req.y));
  const rect = {
    x,
    y,
    w: Math.min(img.w - x, Math.round(req.w)),
    h: Math.min(img.h - y, Math.round(req.h)),
  };
  if (rect.w <= 0 || rect.h <= 0) {
    throw fail("EMPTY_REGION", `이미지(${img.w}x${img.h}) 밖 region ${JSON.stringify(req)}`);
  }

  const step = Math.max(1, Math.floor(Math.min(rect.w, rect.h) / opt.sampleLines));
  const grid = sampleGrid(img, rect, step);
  const metrics = measure(grid, 0, grid.cols, 0, grid.rows, opt);
  const wholeReason = classify(metrics, opt);

  // 구역 격자 — 표본이 얇으면 타일을 줄인다(줄인 사실은 sampling.tiles 로 돌려준다).
  const tilesX = Math.max(1, Math.min(opt.tiles, Math.floor(grid.cols / 2)));
  const tilesY = Math.max(1, Math.min(opt.tiles, Math.floor(grid.rows / 2)));
  const tiles = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const c0 = Math.floor((tx * grid.cols) / tilesX);
      const c1 = Math.floor(((tx + 1) * grid.cols) / tilesX);
      const r0 = Math.floor((ty * grid.rows) / tilesY);
      const r1 = Math.floor(((ty + 1) * grid.rows) / tilesY);
      const m = measure(grid, c0, c1, r0, r1, opt);
      const reason = classify(m, opt);
      const x0 = grid.xs[c0];
      const y0 = grid.ys[r0];
      tiles.push({
        index: ty * tilesX + tx,
        col: tx,
        row: ty,
        rect: {
          x: x0,
          y: y0,
          w: (c1 < grid.cols ? grid.xs[c1] : rect.x + rect.w) - x0,
          h: (r1 < grid.rows ? grid.ys[r1] : rect.y + rect.h) - y0,
        },
        blank: reason !== null,
        reason,
        metrics: m,
      });
    }
  }

  const blankTiles = tiles.filter((t) => t.blank);
  const bounds = blankTiles.length
    ? blankTiles.reduce(
        (acc, t) => ({
          x: Math.min(acc.x, t.rect.x),
          y: Math.min(acc.y, t.rect.y),
          x2: Math.max(acc.x2, t.rect.x + t.rect.w),
          y2: Math.max(acc.y2, t.rect.y + t.rect.h),
        }),
        { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity },
      )
    : null;

  const verdict = wholeReason ? "BLANK" : blankTiles.length ? "PARTIAL" : "DRAWN";
  const reason = wholeReason ?? (blankTiles.length ? BLANK_REASONS.TILES_BLANK : null);
  const holes = {
    count: blankTiles.length,
    total: tiles.length,
    ratio: round(blankTiles.length / tiles.length, 4),
    indices: blankTiles.map((t) => t.index),
    bounds: bounds ? { x: bounds.x, y: bounds.y, w: bounds.x2 - bounds.x, h: bounds.y2 - bounds.y } : null,
  };

  const summary =
    `${verdict}${reason ? `(${reason})` : ""} ${rect.w}x${rect.h}@${rect.x},${rect.y} ` +
    `최빈 ${metrics.dominantColor} ${(metrics.dominantRatio * 100).toFixed(1)}% ` +
    `고유색 ${metrics.uniqueColors} 엔트로피 ${metrics.lumaEntropy} 경계 ${(metrics.edgeRatio * 100).toFixed(1)}% ` +
    `빈구역 ${holes.count}/${holes.total}`;

  return {
    verdict,
    drawn: verdict !== "BLANK",
    reason,
    summary,
    image: { width: img.w, height: img.h, channels: img.ch, colorType: head.colorType, bitDepth: head.bitDepth },
    sampling: { region: rect, step, samples: metrics.samples, grid: { cols: grid.cols, rows: grid.rows }, tiles: { cols: tilesX, rows: tilesY } },
    thresholds: { solidRatio: opt.solidRatio, minColors: opt.minColors, entropyFloor: opt.entropyFloor, edgeDelta: opt.edgeDelta, edgeFloor: opt.edgeFloor },
    metrics,
    tiles,
    holes,
  };
}

/**
 * 같은 창의 정상 프레임과 견줘 "무엇이 사라졌는가"를 짚는다.
 *
 * 여백과 구멍을 가르는 사실은 프레임 안에 없다(위 한계). 정상 프레임이 그 사실이다 —
 * 거기서 그려져 있던 구역이 여기서 평평해졌다면 그건 여백이 아니라 사라진 것이다.
 * 셸 두 벌의 같은 화면을 견주는 것도 같은 함수로 한다(캡처가 무엇을 빠뜨렸는지가 그대로 나온다).
 *
 * @returns {{regressed:object[], bounds:object|null, baseline:object, frame:object}}
 *   regressed = 정상에선 그려졌는데 여기선 평평한 구역들. 비어 있으면 사라진 것이 없다.
 */
export function compareFrames(baselineBytes, frameBytes, options = {}) {
  const baseline = judgeFrame(baselineBytes, options);
  const frame = judgeFrame(frameBytes, options);
  const a = baseline.sampling;
  const b = frame.sampling;
  if (a.region.w !== b.region.w || a.region.h !== b.region.h) {
    throw fail(
      "SIZE_MISMATCH",
      `견줄 두 프레임의 크기가 다르다(${a.region.w}x${a.region.h} ≠ ${b.region.w}x${b.region.h})`,
    );
  }
  const regressed = frame.tiles.filter((t) => t.blank && !baseline.tiles[t.index].blank).map((t) => ({
    index: t.index,
    col: t.col,
    row: t.row,
    rect: t.rect,
    reason: t.reason,
    was: {
      uniqueColors: baseline.tiles[t.index].metrics.uniqueColors,
      edgeRatio: baseline.tiles[t.index].metrics.edgeRatio,
    },
    now: { uniqueColors: t.metrics.uniqueColors, edgeRatio: t.metrics.edgeRatio },
  }));
  const bounds = regressed.length
    ? regressed.reduce(
        (acc, t) => ({
          x: Math.min(acc.x, t.rect.x),
          y: Math.min(acc.y, t.rect.y),
          x2: Math.max(acc.x2, t.rect.x + t.rect.w),
          y2: Math.max(acc.y2, t.rect.y + t.rect.h),
        }),
        { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity },
      )
    : null;
  return {
    regressed,
    bounds: bounds ? { x: bounds.x, y: bounds.y, w: bounds.x2 - bounds.x, h: bounds.y2 - bounds.y } : null,
    summary:
      regressed.length === 0
        ? `사라진 구역 없음 (${frame.holes.count}/${frame.holes.total} 평평 — 정상도 같은 자리)`
        : `사라진 구역 ${regressed.length} (${regressed.map((t) => `[${t.col},${t.row}]`).join(" ")})`,
    baseline,
    frame,
  };
}
