// PNG 코덱 — e2e 픽셀 오라클의 단일 진실.
//
// 네 벌로 복사돼 있던 것을 한 벌로 모은다. 복사본마다 같은 결함을 안고 있었고, 그 결함은
// 조용했다: 화면엔 선이 있는데 판정기만 못 보고 "테두리 없음"을 냈다(실측 2026-07-27,
// rail-border 스윕). 오라클이 틀리면 없는 결함을 쫓고 있는 결함을 놓친다.
//
// 스캔라인 복원 규칙: 이전 줄(prev)은 현재 줄을 복원하는 동안 절대 건드리지 않는다.
// x 루프 안에서 prev[x]=line[x] 로 덮어쓰면 뒤이은 x 의 c(=prev[x-ch])가 "이전 줄"이 아니라
// "이미 복원된 현재 줄"이 되어 Average(3)/Paeth(4) 줄이 통째로 어긋난다.

import zlib from "node:zlib";

/** @returns {{w:number,h:number,ch:number,px:Buffer}} ch = 픽셀당 바이트 수, px = 필터 해제된 원본 */
export function decodePng(buf) {
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
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 0xff;
      else if (f === 2) line[x] = (line[x] + b) & 0xff;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, ch, px: out };
}

// --- 인코더 -----------------------------------------------------------------
// 픽셀 오라클의 픽스처를 코드로 만들기 위해 있다. 판정기가 "무엇을 백지로 보는가"는
// 실물 바이트로만 증명되고, 그 바이트는 재생성 가능해야 한다(픽스처는 손으로 줍지 않는다).

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * {w,h,ch,px} → PNG 바이트(8-bit, non-interlaced). ch 1=gray, 3=RGB, 4=RGBA.
 * 줄마다 None/Sub/Up 중 절대차 합이 가장 작은 필터를 고른다 — 단색·그라디언트 픽스처가
 * 파일 크기 휴리스틱을 반증할 만큼 실제로 작게 눌리도록.
 */
export function encodePng({ w, h, ch, px }) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[ch];
  if (colorType === undefined) throw new Error(`encodePng: 지원 안 하는 채널 수 ${ch}`);
  if (px.length !== w * h * ch) throw new Error(`encodePng: 픽셀 길이 불일치(${px.length} ≠ ${w * h * ch})`);
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  const prev = Buffer.alloc(stride);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    const line = px.subarray(y * stride, y * stride + stride);
    const score = [0, 0, 0];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      cand[0][x] = line[x];
      cand[1][x] = (line[x] - a) & 0xff;
      cand[2][x] = (line[x] - b) & 0xff;
      for (let f = 0; f < 3; f++) {
        const v = cand[f][x];
        score[f] += v < 128 ? v : 256 - v;
      }
    }
    let best = 0;
    if (score[1] < score[best]) best = 1;
    if (score[2] < score[best]) best = 2;
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
    line.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 이 프레임이 백지인가 — **픽셀로** 판정한다.
 *
 * 파일 크기는 프록시일 뿐이라 실제로 그려졌지만 성긴 화면(프롬프트만 있는 터미널)을 백지로
 * 오판한다(실측 2026-07-29: 전 화면이 그려진 프레임이 57KB). 그 오판은 "렌더가 안 됐다"로
 * 읽혀 원인을 엉뚱한 데서 찾게 만든다.
 *
 * 한 색으로 덮인 프레임이 백지다. 셈은 표본으로 충분하다 — 전수는 느리고, 백지는 표본에서도
 * 한 색이다. 반환 = { colors, w, h } (부르는 쪽이 사유에 실을 수 있게 수를 함께 준다).
 */
export function frameColors(buf, cap = 64) {
  const { w, h, ch, px } = decodePng(buf);
  const seen = new Set();
  const step = Math.max(1, Math.floor((w * h) / 20_000));
  for (let i = 0; i < w * h; i += step) {
    const o = i * ch;
    seen.add((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]);
    if (seen.size > cap) break;
  }
  return { colors: seen.size, w, h };
}
