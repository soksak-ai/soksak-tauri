// 사람이 캡처를 보고 남기는 판정을 정본 보고서에 적는다.
//
// 앱을 띄우지 않는다. 실행이 끝나 닫힌 `browser-gates.json` 위에서만 돈다 — 시각 검토는
// machine 판정이 닫힌 **다음에** 사람이 눈으로 하는 일이기 때문이다.
//
//   node scripts/e2e/visual-review.mjs --report <runs/...>/browser-gates.json --list
//   node scripts/e2e/visual-review.mjs \
//     --report <runs/...>/browser-gates.json \
//     --engine browser-chromium --gate B04 --status passed \
//     --artifact browser-chromium/first-paint.png \
//     --artifact browser-chromium/flow-right/f0048.png \
//     --notes "좌우 전환에서 레일이 붙어 있고 표면이 밀리지 않는다"
//
// artifact 경로는 보고서가 있는 디렉터리 기준이며, 실제로 있는 파일만 받는다.
// `--status`는 생략할 수 없다. 자동으로 `passed`가 되는 길은 이 스크립트에도 없다.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyVisualReview,
  pendingVisualReviews,
} from "./lib/browser-visual-review.mjs";

const USAGE = [
  "사용법:",
  "  node scripts/e2e/visual-review.mjs --report <browser-gates.json> --list",
  "  node scripts/e2e/visual-review.mjs --report <browser-gates.json> \\",
  "    --engine <engine> --gate <B01..B12> --status <passed|failed> \\",
  "    --artifact <보고서 기준 상대경로> [--artifact ...] --notes <확인한 내용>",
].join("\n");

/** 반복 가능한 키는 목록으로 모은다. 나머지는 마지막 값이 이긴다. */
export function parseArguments(argv) {
  const options = { artifact: [] };
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at];
    if (token === "--list") {
      options.list = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`알 수 없는 인자: ${token}`);
    const key = token.slice(2);
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} 에 값이 없다`);
    at += 1;
    if (key === "artifact") options.artifact.push(value);
    else options[key] = value;
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`visual-review: ${error.message}\n${USAGE}`);
    return 2;
  }

  if (!options.report) {
    console.error(`visual-review: --report 로 정본 보고서를 지목해라\n${USAGE}`);
    return 2;
  }
  const reportPath = path.resolve(options.report);
  let text;
  try {
    text = fs.readFileSync(reportPath, "utf8");
  } catch (error) {
    console.error(`visual-review: 보고서를 읽지 못했다 ${reportPath} — ${error.message}`);
    return 2;
  }

  if (options.list) {
    const pending = pendingVisualReviews(text);
    for (const cell of pending) {
      console.log(`  ${cell.engine}/${cell.gate}  machine=${cell.machine}  visualReview=pending`);
    }
    console.log(`visual-review: pending ${pending.length} — ${reportPath}`);
    return 0;
  }

  const reportDir = path.dirname(reportPath);
  let next;
  try {
    next = applyVisualReview(text, {
      engine: options.engine,
      gate: options.gate,
      status: options.status,
      artifacts: options.artifact,
      notes: options.notes,
      artifactExists: (artifact) => {
        const resolved = path.resolve(reportDir, artifact);
        // 보고서 바깥을 가리키는 경로는 이 실행의 증거가 아니다.
        if (!resolved.startsWith(`${reportDir}${path.sep}`)) return false;
        return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
      },
    });
  } catch (error) {
    console.error(`visual-review: ${error.message}`);
    return 1;
  }

  // 판정이 서기 전에는 정본을 건드리지 않는다. 원자 교체로 반쯤 쓰인 보고서를 남기지 않는다.
  const staging = `${reportPath}.staging`;
  fs.writeFileSync(staging, next);
  fs.renameSync(staging, reportPath);

  const remaining = pendingVisualReviews(next).length;
  console.log(
    `visual-review: ${options.engine}/${options.gate} visualReview=${options.status} `
      + `artifacts=${options.artifact.length} — pending ${remaining} 남음`,
  );
  console.log(`  notes: ${options.notes}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
