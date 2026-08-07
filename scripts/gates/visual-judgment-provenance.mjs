// 캡처는 판정을 정하지 못한다. 그리고 사람의 시각 검토에는 도달 가능한 자리가 있어야 한다.
//
// 두 축을 한 자리에서 센다. 같은 배신의 앞뒤이기 때문이다 — 기계 판정이 캡처 산출물을 근거로
// 삼으면 사람이 볼 몫을 기계가 먼저 삼키고, 그러고 나면 사람이 실제로 본 것을 적을 자리가 없다.
//
// 실측(2026-08-07, buildId=c437078c): 36칸 중 blocked 29.
//   ① `slot-freeze.mjs` 가 PNG 디코드에서 얻은 배율을 `windowedSurfaceCompositionVerdict` 의
//      `scaleFactor` 로 넘겼다. 그 값은 `physical()` 의 반올림 기준이라 **캡처 산출물이 기계
//      판정의 허용오차를 정했다.** 더 나쁜 것은 PNG 좌표계 산출이 실패하면 조용히 `scale=1` 로
//      대체된 것이다 — 못 읽음이 성공값으로 둔갑해 같은 판정이 더 느슨해졌다.
//   ② `titlebar-composition.mjs` 가 `recording.frames === 64` 를 B12 통과 조건으로 썼다.
//      B12 judge 는 그 프레임을 입력으로 받지도 않는다. 녹화가 63장이면 판정은 서지도 못했다.
//   ③ `recordVisualReview` 를 자기 테스트 말고는 아무도 부르지 않았다. 지시서 최종 조건이
//      "모든 UI gate 의 visualReview 가 passed" 인데 그 상태로 갈 경로 자체가 없었다.
//
// 규칙 세 줄.
//   A. 캡처에서 나온 값(PNG 디코드·녹화 프레임)은 기계 판정 입구에 인자로 들어가지 않는다.
//      배율은 창/표시면의 사실이다 — `displayScaleFact(window.info)` 로 읽어라.
//   B. 녹화 완결성은 사람이 볼 캡처의 사실이다. 그것으로 던져서 판정 자리를 비우지 마라.
//      측정 불가(주소 없음·창 없음·명령 무응답)만 던진다. 계약 위반은 evidence 에 실어 red 로 남겨라.
//   C. `visualReview` 를 passed/failed 로 적는 경로가 테스트 밖에 하나 이상 있어야 한다.
//      사람이 artifact 경로와 메모를 명시해 기록하는 재사용 가능한 자리여야 한다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** 하니스가 사는 곳. 판정도 캡처도 여기서 난다. */
const DIRS = ["scripts/e2e"];

/** 이 게이트 자신은 규칙을 설명하느라 아래 이름들을 전부 적는다. */
const SELF = "scripts/gates/visual-judgment-provenance.mjs";

/** 캡처 산출물을 낳는 자리. 여기서 나온 값은 사람용 진단이지 판정 근거가 아니다. */
const CAPTURE_PRODUCERS = [
  "snapshotCssScale",
  "snapshotScaleForVisualEvidence",
  "decodePng",
  "observeFrameSequence",
  "observeFullCapture",
  "inspectFrameSequence",
];

/** 기계 판정 입구. 이 괄호 안에 캡처에서 나온 이름이 있으면 판정을 캡처가 정한 것이다. */
const MACHINE_SINKS = [
  "windowedSurfaceCompositionVerdict",
  "assertWindowedComposition",
  "recordMachineEvidence",
  /judge[A-Za-z0-9]*MachineEvidence/.source,
];

/**
 * 녹화 완결성을 **기대값과 맞대는** 모양. 이것이 조건이 되어 throw 로 이어지면 규칙 B 위반이다.
 *
 * 스키마 거절과는 다르다. `RECORDING_STATUSES.has(recording.status)` 나
 * `optionalFrameCount("recording.frames", ...)` 는 넘겨받은 봉투가 말이 되는지 묻는 것이고,
 * 그 throw 는 `reviewVisualRecordingSafely` 가 받아 증거로 바꾼다. 여기서 세는 것은
 * `recording.status !== "complete"`, `recording.frames !== EXPECTED` 처럼 **완결성을 통과
 * 조건으로 삼은** 비교뿐이다.
 */
const RECORDING_COMPLETENESS =
  /(recording\??\.(frames|status)\s*(?:!==|===|!=|==|<=|>=|<|>)|(?:!==|===|!=|==|<=|>=|<|>)\s*[\w$.?]*recording\??\.(frames|status))/;

/** 사람의 시각 검토를 정본 보고서에 적는 자리. */
const VISUAL_REVIEW_WRITERS = ["recordVisualReview", "applyVisualReview"];

function walk(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "build" || name.startsWith(".")) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(join(dir, name)));
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/**
 * 이름 자체를 쓴 자리만 센다. `originalWindow.scale` 의 `scale` 은 창의 사실을 읽은 것이지
 * 캡처에서 나온 그 이름이 아니다 — 속성 접근을 같은 이름으로 세면 사실을 읽은 자리까지 고발한다.
 */
const word = (name) => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`);

/**
 * 캡처에서 나온 이름을 고정점까지 번지게 한다. `const a = snapshotCssScale(...)` 뿐 아니라
 * `const b = a.scale` 처럼 한 겹 벗겨 낸 것도 같은 출처다 — 벗겼다고 사실이 되지 않는다.
 */
export function captureTaintedNames(source, producers = CAPTURE_PRODUCERS) {
  const lines = source.split("\n");
  const tainted = new Set();
  for (let pass = 0; pass < 8; pass += 1) {
    const before = tainted.size;
    for (const line of lines) {
      const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(line);
      if (!bind) continue;
      const [, name, rhs] = bind;
      const fromProducer = producers.some((p) => word(p).test(rhs));
      const fromTainted = [...tainted].some((t) => new RegExp(`\\b${t}\\s*\\??\\.`).test(rhs));
      if (fromProducer || fromTainted) tainted.add(name);
    }
    if (tainted.size === before) break;
  }
  return tainted;
}

/** 호출 하나의 괄호 안 텍스트. 여러 줄에 걸친 인자도 통째로 본다. */
export function callArgumentText(source, index) {
  const open = source.indexOf("(", index);
  if (open < 0) return "";
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "(") depth += 1;
    else if (source[at] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, at);
    }
  }
  return source.slice(open + 1);
}

/** 규칙 A — 기계 판정 입구에 캡처에서 나온 이름이 인자로 들어갔는가. */
export function captureFedMachineJudgments(source, {
  producers = CAPTURE_PRODUCERS,
  sinks = MACHINE_SINKS,
} = {}) {
  const tainted = captureTaintedNames(source, producers);
  if (tainted.size === 0) return [];
  const found = [];
  for (const sink of sinks) {
    const pattern = new RegExp(`\\b(${sink})\\s*\\(`, "g");
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const args = callArgumentText(source, match.index);
      for (const name of tainted) {
        if (!word(name).test(args)) continue;
        found.push({
          sink: match[1],
          argument: name,
          line: source.slice(0, match.index).split("\n").length,
        });
      }
    }
  }
  return found;
}

/** 규칙 B — 녹화 완결성이 조건이 되어 throw 로 이어지는가. */
export function recordingCompletenessThrows(source) {
  const lines = source.split("\n");
  const found = [];
  for (let at = 0; at < lines.length; at += 1) {
    if (!RECORDING_COMPLETENESS.test(lines[at])) continue;
    const ahead = lines.slice(at, Math.min(lines.length, at + 7)).join("\n");
    const behind = lines.slice(Math.max(0, at - 4), at + 1).join("\n");
    if (!/\bthrow\b/.test(ahead)) continue;
    if (!/\bif\s*\(/.test(behind)) continue;
    found.push({ line: at + 1, text: lines[at].trim().slice(0, 90) });
  }
  return found;
}

function main() {
  const files = DIRS.flatMap(walk);
  if (files.length === 0) {
    console.error("visual-judgment: 대상 파일을 하나도 못 찾았다 — 빈 스캔은 통과가 아니다");
    return 1;
  }

  let bad = 0;
  let scanned = 0;
  let reviewWriters = 0;
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === SELF) continue;
    const source = readFileSync(file, "utf8");
    const isTest = rel.endsWith(".test.mjs");
    if (!isTest && VISUAL_REVIEW_WRITERS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source))) {
      reviewWriters += 1;
    }
    if (isTest) continue;
    scanned += 1;

    for (const hit of captureFedMachineJudgments(source)) {
      bad += 1;
      console.error(
        `visual-judgment: ${rel}:${hit.line} 기계 판정 ${hit.sink}( 에 캡처에서 나온 \`${hit.argument}\` 를 ` +
          "넘겼다 — 배율·프레임은 캡처의 산출물이지 판정의 근거가 아니다. 창/표시면의 사실을 읽어라",
      );
    }
    for (const hit of recordingCompletenessThrows(source)) {
      bad += 1;
      console.error(
        `visual-judgment: ${rel}:${hit.line} 녹화 완결성으로 던진다 — \`${hit.text}\`. ` +
          "던지면 judge 가 닿지 못해 blocked 로 남는다. 이것은 사람이 볼 캡처의 사실이니 " +
          "visual evidence 에 실어라",
      );
    }
  }

  if (reviewWriters === 0) {
    bad += 1;
    console.error(
      "visual-judgment: visualReview 를 passed/failed 로 적는 경로가 테스트 밖에 없다 — " +
        "사람이 artifact 경로와 메모를 명시해 기록하는 재사용 가능한 자리를 만들어라",
    );
  }

  if (bad > 0) return 1;
  console.log(
    `visual-judgment: OK — 하니스 ${scanned}개 · 캡처가 정한 판정 0 · 사람 검토 기록 경로 ${reviewWriters}개`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
