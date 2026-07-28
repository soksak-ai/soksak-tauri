// @vitest-environment node
// 픽셀 오라클의 기준 — "이 프레임이 그려졌는가"에 셸이 끼어들지 않는다.
//
// 같은 이름의 캡처 명령이 셸마다 다른 것을 찍는다(Tauri 는 창 합성물, Electron capturePage 는
// 네이티브 자식이 빠진 그림). 판정까지 캡처에 묶이면 "그려졌다"가 셸마다 다른 뜻이 된다.
// 그래서 판정은 PNG 바이트만 받는 순수 함수여야 하고, 이 파일이 그 함수의 기준이다.
//
// 픽스처 출처는 fixtures/frames/frames.json 에 값으로 있다(실물 캡처 파생 / 합성 구분).
// 재생성: node scripts/e2e/make-frame-fixtures.mjs --source <캡처.png>

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";
import { BLANK_REASONS, compareFrames, judgeFrame } from "./frame-oracle.mjs";

const FRAMES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "frames");
const bytesOf = (name) => fs.readFileSync(path.join(FRAMES, name));
const judge = (name, opts) => judgeFrame(bytesOf(name), opts);

// hole-window.png 에 찍힌 구멍(생성기가 frames.json 에 적어 둔 값 — 테스트가 짐작하지 않는다).
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FRAMES, "frames.json"), "utf8"));
const HOLE = MANIFEST.frames["hole-window.png"].hole;

describe("전체 백지", () => {
  it("단색 프레임은 BLANK 이고 이유는 SOLID_FILL", () => {
    const v = judge("blank-window.png");
    expect(v.verdict).toBe("BLANK");
    expect(v.drawn).toBe(false);
    expect(v.reason).toBe(BLANK_REASONS.SOLID_FILL);
    expect(v.metrics.uniqueColors).toBe(1);
    expect(v.metrics.dominantRatio).toBe(1);
    expect(v.metrics.dominantColor).toBe("#1c1c1c");
    expect(v.metrics.edgeRatio).toBe(0);
  });

  it("그라디언트는 고유색도 엔트로피도 높지만 BLANK — 경계가 없다", () => {
    const v = judge("blank-gradient.png");
    // 색 수 휴리스틱(고유색 8 이상이면 렌더됨)도, 엔트로피 하나만 보는 판정도 이 프레임을
    // '그려짐'이라 부른다. 국소 대비가 0 이라는 사실만이 이걸 백지로 가른다.
    expect(v.metrics.uniqueColors).toBeGreaterThanOrEqual(8);
    expect(v.metrics.lumaEntropy).toBeGreaterThan(0.5);
    expect(v.metrics.edgeRatio).toBe(0);
    expect(v.verdict).toBe("BLANK");
    expect(v.reason).toBe(BLANK_REASONS.FLAT_STRUCTURE);
  });
});

describe("기준이 실제로 일한다", () => {
  it("경계 임계를 0 으로 내리면 그라디언트가 통과한다 — 판정을 떠받치는 건 이 기준이다", () => {
    expect(judge("blank-gradient.png").drawn).toBe(false);
    expect(judge("blank-gradient.png", { edgeFloor: 0 }).drawn).toBe(true);
  });

  it("최빈색 임계를 1 초과로 올리면 단색 프레임이 SOLID_FILL 을 빠져나간다", () => {
    expect(judge("blank-window.png").reason).toBe(BLANK_REASONS.SOLID_FILL);
    // 단색은 그래도 색 수에서 걸린다 — 기준이 겹쳐 있어 하나가 무너져도 통과하지 않는다.
    expect(judge("blank-window.png", { solidRatio: 1.1 }).reason).toBe(BLANK_REASONS.FEW_COLORS);
  });
});

describe("정상 렌더", () => {
  it("창 전체 실물 캡처는 그려진 것으로 본다", () => {
    const v = judge("rendered-window.png");
    expect(v.drawn).toBe(true);
    expect(v.metrics.edgeRatio).toBeGreaterThan(0.05);
    // 실렌더 창에도 여백은 있다 — 평평한 구역이 있다는 사실이 곧 결함은 아니다.
    expect(v.holes.count).toBeLessThan(v.holes.total / 2);
  });

  it("뷰 슬롯 크기의 실물 크롭은 DRAWN, 평평한 구역 없음", () => {
    const v = judge("rendered-slot.png");
    expect(v.verdict).toBe("DRAWN");
    expect(v.holes.count).toBe(0);
  });
});

describe("일부만 백지 — 무엇이 없는지 짚는다", () => {
  it("구멍은 정상 프레임과 견줘야 여백과 갈린다", () => {
    const cmp = compareFrames(bytesOf("rendered-window.png"), bytesOf("hole-window.png"));
    expect(cmp.regressed.length).toBeGreaterThan(0);
    // 사라진 구역은 전부 찍은 구멍 위에 있다(면적의 절반 이상이 구멍 안).
    for (const t of cmp.regressed) {
      const ox = Math.max(0, Math.min(t.rect.x + t.rect.w, HOLE.x + HOLE.w) - Math.max(t.rect.x, HOLE.x));
      const oy = Math.max(0, Math.min(t.rect.y + t.rect.h, HOLE.y + HOLE.h) - Math.max(t.rect.y, HOLE.y));
      expect((ox * oy) / (t.rect.w * t.rect.h), `구역 [${t.col},${t.row}]`).toBeGreaterThan(0.5);
      expect(t.was.edgeRatio).toBeGreaterThan(t.now.edgeRatio);
    }
  });

  it("정상 프레임끼리 견주면 사라진 구역이 없다 — 여백을 구멍이라 부르지 않는다", () => {
    const cmp = compareFrames(bytesOf("rendered-window.png"), bytesOf("rendered-window.png"));
    expect(cmp.regressed).toEqual([]);
    expect(cmp.bounds).toBe(null);
  });

  it("크기가 다른 프레임끼리는 SIZE_MISMATCH", () => {
    expect(() => compareFrames(bytesOf("rendered-window.png"), bytesOf("rendered-slot.png"))).toThrow(
      expect.objectContaining({ code: "SIZE_MISMATCH" }),
    );
  });

  it("구멍 난 프레임은 PARTIAL 이고 빈 구역을 값으로 준다", () => {
    const v = judge("hole-window.png");
    expect(v.verdict).toBe("PARTIAL");
    expect(v.reason).toBe(BLANK_REASONS.TILES_BLANK);
    expect(v.holes.count).toBeGreaterThan(judge("rendered-window.png").holes.count);
    expect(v.holes.count).toBeLessThan(v.holes.total); // 전체가 빈 게 아니다
    expect(v.holes.indices.length).toBe(v.holes.count);
    expect(v.holes.bounds.w).toBeLessThan(v.image.width); // 프레임 전체를 가리키면 진단이 아니다
  });

  it("구멍 rect 만 물으면 BLANK, 크롬 rect 만 물으면 DRAWN", () => {
    const inside = judge("hole-window.png", {
      region: { x: HOLE.x + 20, y: HOLE.y + 20, w: HOLE.w - 40, h: HOLE.h - 40 },
    });
    expect(inside.verdict).toBe("BLANK");
    expect(inside.reason).toBe(BLANK_REASONS.SOLID_FILL);

    const sidebar = judge("hole-window.png", { region: { x: 0, y: HOLE.y, w: HOLE.x - 8, h: HOLE.h } });
    expect(sidebar.verdict).toBe("DRAWN");
  });
});

describe("근거는 값으로 돌아온다", () => {
  it("판정에 붙은 수치로 왜 그렇게 봤는지 읽을 수 있다", () => {
    const v = judge("hole-window.png");
    expect(v.image).toMatchObject({ width: expect.any(Number), height: expect.any(Number), channels: expect.any(Number) });
    expect(v.sampling.step).toBeGreaterThan(0);
    expect(v.sampling.samples).toBeGreaterThan(100);
    for (const k of ["uniqueColors", "dominantRatio", "lumaEntropy", "lumaStdDev", "edgeRatio"]) {
      expect(typeof v.metrics[k], k).toBe("number");
      expect(Number.isFinite(v.metrics[k]), k).toBe(true);
    }
    expect(v.tiles.length).toBe(v.sampling.tiles.cols * v.sampling.tiles.rows);
    for (const t of v.tiles) {
      expect(t.rect.w).toBeGreaterThan(0);
      expect(typeof t.blank).toBe("boolean");
      expect(t.reason === null || Object.values(BLANK_REASONS).includes(t.reason)).toBe(true);
    }
    // 한 줄로도 읽힌다 — "false" 한 글자는 디버깅이 안 된다.
    expect(v.summary).toContain(v.metrics.dominantColor);
    expect(v.summary).toContain("PARTIAL");
  });
});

describe("캡처 방식과 무관", () => {
  it("같은 그림이면 RGB 로 찍히든 RGBA 로 찍히든 같은 판정", () => {
    const img = decodePng(bytesOf("rendered-slot.png"));
    const rgb = Buffer.alloc(img.w * img.h * 3);
    const rgba = Buffer.alloc(img.w * img.h * 4);
    for (let i = 0, j = 0, k = 0; i < img.w * img.h; i++, j += img.ch, k += 3) {
      rgb[k] = img.px[j];
      rgb[k + 1] = img.px[j + 1];
      rgb[k + 2] = img.px[j + 2];
      rgba[i * 4] = img.px[j];
      rgba[i * 4 + 1] = img.px[j + 1];
      rgba[i * 4 + 2] = img.px[j + 2];
      rgba[i * 4 + 3] = 255;
    }
    const a = judgeFrame(encodePng({ w: img.w, h: img.h, ch: 3, px: rgb }));
    const b = judgeFrame(encodePng({ w: img.w, h: img.h, ch: 4, px: rgba }));
    expect(a.verdict).toBe(b.verdict);
    expect(a.metrics).toEqual(b.metrics);
  });

  it("같은 바이트는 언제나 같은 판정", () => {
    expect(judge("hole-window.png")).toEqual(judge("hole-window.png"));
  });
});

describe("파일 크기는 오라클이 아니다", () => {
  it("백지 레티나 창이 실렌더 슬롯보다 무겁다 — 크기 임계는 순서를 뒤집는다", () => {
    const blank = bytesOf("blank-retina.png");
    const rendered = bytesOf("rendered-slot.png");
    expect(blank.length).toBeGreaterThan(rendered.length);
    expect(judgeFrame(blank).drawn).toBe(false);
    expect(judgeFrame(rendered).drawn).toBe(true);
  });

  it("구멍 난 창은 크기로는 실렌더 급이다 — 크기는 어디가 비었는지 말 못 한다", () => {
    const hole = bytesOf("hole-window.png");
    expect(hole.length).toBeGreaterThan(bytesOf("blank-window.png").length * 4);
    const v = judgeFrame(hole, { region: { x: HOLE.x + 20, y: HOLE.y + 20, w: HOLE.w - 40, h: HOLE.h - 40 } });
    expect(v.drawn).toBe(false);
  });
});

describe("기존 Tauri 경로와의 관계", () => {
  // browser-pixels.mjs 의 규칙(뷰 슬롯 크롭의 고유색 8 이상이면 렌더됨)을 그대로 다시 쓴다.
  // 새 오라클이 기존 GREEN 을 뒤집지 않는다는 것과, 어디서 더 엄해지는지를 값으로 남긴다.
  const legacyRendered = (name) => {
    const img = decodePng(bytesOf(name));
    const step = Math.max(1, Math.floor(Math.min(img.w, img.h) / 60));
    const seen = new Set();
    for (let y = 0; y < img.h; y += step) {
      for (let x = 0; x < img.w; x += step) {
        const i = (y * img.w + x) * img.ch;
        seen.add((img.px[i] << 16) | (img.px[i + 1] << 8) | img.px[i + 2]);
      }
    }
    return seen.size >= 8;
  };

  it("기존 규칙이 렌더라 부른 프레임을 새 오라클도 렌더라 부른다(그라디언트만 빼고)", () => {
    for (const name of ["rendered-window.png", "rendered-slot.png", "hole-window.png"]) {
      expect(legacyRendered(name), name).toBe(true);
      expect(judge(name).drawn, name).toBe(true);
    }
    for (const name of ["blank-window.png", "blank-retina.png"]) {
      expect(legacyRendered(name), name).toBe(false);
      expect(judge(name).drawn, name).toBe(false);
    }
    // 갈리는 곳은 여기 하나 — 기존 규칙은 그라디언트를 렌더라 부르고, 새 오라클은 아니다.
    expect(legacyRendered("blank-gradient.png")).toBe(true);
    expect(judge("blank-gradient.png").drawn).toBe(false);
  });
});

describe("못 하는 것은 이름을 달고 실패한다", () => {
  /** IHDR 만 있는 PNG — 판정 전에 헤더에서 거절되는지 보려는 것. */
  function headerOnlyPng({ bitDepth = 8, colorType = 6, interlace = 0 }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(16, 0);
    ihdr.writeUInt32BE(16, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[12] = interlace;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(13, 0);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      len,
      Buffer.from("IHDR", "ascii"),
      ihdr,
      Buffer.alloc(4),
    ]);
  }

  it("PNG 가 아니면 NOT_PNG", () => {
    expect(() => judgeFrame(Buffer.from("이건 PNG 가 아니다"))).toThrow(
      expect.objectContaining({ code: "NOT_PNG" }),
    );
  });

  it("16-bit·인터레이스·팔레트는 UNSUPPORTED_PNG — 조용히 틀린 답을 내지 않는다", () => {
    for (const bad of [{ bitDepth: 16 }, { interlace: 1 }, { colorType: 3 }]) {
      expect(() => judgeFrame(headerOnlyPng(bad)), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: "UNSUPPORTED_PNG" }),
      );
    }
  });

  it("이미지 밖 region 은 EMPTY_REGION", () => {
    expect(() => judge("rendered-slot.png", { region: { x: 9000, y: 9000, w: 10, h: 10 } })).toThrow(
      expect.objectContaining({ code: "EMPTY_REGION" }),
    );
  });
});
