// PNG 디코더 — e2e 픽셀 오라클의 단일 진실.
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
