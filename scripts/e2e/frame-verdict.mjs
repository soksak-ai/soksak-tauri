// PNG 를 픽셀 오라클에 물어보는 커맨드 — 프레임워크가 어떻게 찍었든 같은 자로 잰다.
//
// 캡처는 셸마다 다르지만(Tauri 창 합성 / Electron capturePage) 판정은 여기 하나다. 캡처
// 스크립트가 남긴 파일을 그대로 넣으면 된다.
//
// 실행:
//   node scripts/e2e/frame-verdict.mjs <png...>                 # 사람이 읽는 한 줄 + 빈 구역
//   node scripts/e2e/frame-verdict.mjs --json <png...>          # 판정 전체를 값으로
//   node scripts/e2e/frame-verdict.mjs --region 0,0,800,600 a.png
//   node scripts/e2e/frame-verdict.mjs --require no-holes <png> # 평평한 구역 하나도 불허
//   node scripts/e2e/frame-verdict.mjs --baseline 정상.png <png>  # 정상 프레임 대비 사라진 구역
//
// --baseline 은 여백과 구멍을 가른다. 한 장만으로는 평평한 구역이 원래 여백인지 안 찍힌
// 구멍인지 알 길이 없다 — 정상 프레임이 그 사실을 준다.
//
// 종료코드: 0=요구 충족, 1=미충족, 2=읽을 수 없는 입력(형식·경로). 못 재는 것은 이름을 달고
// 실패한다 — 조용히 통과시키지 않는다.

import fs from "node:fs";
import process from "node:process";
import { compareFrames, judgeFrame } from "./lib/frame-oracle.mjs";

function usage(msg) {
  console.error(`${msg}\n사용: node scripts/e2e/frame-verdict.mjs [--json] [--tiles N] [--region x,y,w,h] [--baseline 정상.png] [--require drawn|no-holes] <png...>`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const files = [];
  const options = {};
  let json = false;
  let require_ = "drawn";
  let baseline = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--baseline") {
      baseline = argv[++i];
      if (!baseline) usage("--baseline 은 정상 프레임 PNG 경로");
    } else if (a === "--region") {
      const parts = String(argv[++i] ?? "").split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) usage("--region 은 x,y,w,h");
      options.region = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    } else if (a === "--tiles") {
      options.tiles = Number(argv[++i]);
      if (!Number.isFinite(options.tiles) || options.tiles < 1) usage("--tiles 는 1 이상");
    } else if (a === "--require") {
      require_ = argv[++i];
      if (!["drawn", "no-holes"].includes(require_)) usage("--require 는 drawn 또는 no-holes");
    } else if (a.startsWith("--")) usage(`모르는 옵션 ${a}`);
    else files.push(a);
  }
  if (!files.length) usage("PNG 경로가 없다");

  const out = [];
  let bad = 0;
  for (const file of files) {
    let verdict;
    let compared = null;
    try {
      const bytes = fs.readFileSync(file);
      verdict = judgeFrame(bytes, options);
      if (baseline) compared = compareFrames(fs.readFileSync(baseline), bytes, options);
    } catch (e) {
      console.error(`${file}: ${e.code ?? "READ_FAILED"} — ${e.message}`);
      process.exit(2);
    }
    // 기준선을 줬으면 "사라진 것이 없는가"가 요구다 — 여백은 처음부터 여백이었다.
    const met = compared
      ? verdict.drawn && compared.regressed.length === 0
      : require_ === "no-holes"
        ? verdict.verdict === "DRAWN"
        : verdict.drawn;
    if (!met) bad += 1;
    if (json) out.push({ file, met, verdict, compared });
    else {
      console.log(`${met ? "GREEN" : "RED  "} ${file}`);
      console.log(`      ${verdict.summary}`);
      if (compared) {
        console.log(`      ${compared.summary}  (기준선 ${baseline})`);
        for (const t of compared.regressed) {
          console.log(
            `      사라짐 [${t.col},${t.row}] (${t.rect.x},${t.rect.y} ${t.rect.w}x${t.rect.h}) ${t.reason} ` +
              `경계 ${(t.was.edgeRatio * 100).toFixed(1)}% → ${(t.now.edgeRatio * 100).toFixed(1)}%`,
          );
        }
      } else {
        for (const t of verdict.tiles.filter((t) => t.blank)) {
          console.log(
            `      평평 [${t.col},${t.row}] (${t.rect.x},${t.rect.y} ${t.rect.w}x${t.rect.h}) ${t.reason} ` +
              `최빈 ${t.metrics.dominantColor} ${(t.metrics.dominantRatio * 100).toFixed(1)}% 고유색 ${t.metrics.uniqueColors} 경계 ${(t.metrics.edgeRatio * 100).toFixed(1)}%`,
          );
        }
      }
    }
  }
  if (json) console.log(JSON.stringify({ require: require_, files: out }, null, 2));
  process.exit(bad ? 1 : 0);
}

main();
