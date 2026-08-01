// 글꼴 스택은 **한 자리에서 온다** — 손으로 적으면 그중 몇 군데에서만 폴백이 빠진다.
//
// 규칙: CSS 에서 글꼴 스택을 적는 자리는 `:root` 의 `--font-mono` 정의 하나다. 나머지는 전부
// `var(--font-mono)` 로 그것을 부른다.
//
// 왜 규칙이어야 하는가(실측 2026-08-01): 모노 스택이 10곳 넘게 흩어져 있었고 **전부 한글
// 글리프가 없었다.** 한글은 엔진의 마지막 폴백으로 가는데 그 폴백이 엔진마다 다르다 —
// WebKit 은 시스템 한글 폰트를, Chromium 은 `monospace` 를 집는다. 그래서 같은 화면에서
// 탭 제목만 `터미널(고스티)` 의 `고`·`스` 가 □□ 로 그려지고 나머지 한글은 멀쩡했다.
// 자리마다 고치면 다음에 새로 적히는 자리가 또 빠진다. 스택이 하나면 폴백도 하나다.
//
// 이 게이트가 세는 것: CSS 안의 글꼴 패밀리 리터럴. 허용은 정의 한 줄(그 줄에만 실제 스택이
// 있다)과, 스택이 아닌 단독 키워드(`inherit`·`monospace` 단독은 폴백이 아니라 그 자체).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CSS_DIR = join(ROOT, "src");

/** 정본 변수 — 이 이름의 정의 한 줄만 실제 스택을 적을 수 있다. */
const TOKEN = "--font-mono";

/** 스택이 아닌 단독 값 — 이것만 쓰는 선언은 폴백을 고르는 일이 아니다. */
const SINGLE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert"]);

function cssFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

if (!existsSync(CSS_DIR)) {
  console.error(`font-stack: 대상 디렉터리가 없다 — ${CSS_DIR}`);
  process.exit(1);
}

const files = cssFiles(CSS_DIR);
if (files.length === 0) {
  console.error("font-stack: CSS 를 하나도 못 찾았다 — 파싱이 비면 위반이 0 으로 보인다");
  process.exit(1);
}

/** `font-family:` 와 `font:` 축약형의 값. 여러 줄 스택도 한 값으로 모은다.
 *
 *  `@font-face` 안은 세지 않는다 — 거기 `font-family` 는 스택을 **고르는** 것이 아니라 폰트에
 *  **이름을 주는** 선언이다. 그 자리를 변수로 바꾸면 폰트가 자기 이름을 잃는다. */
function declarations(src) {
  const faces = [];
  const faceRe = /@font-face\s*\{[^}]*\}/g;
  let f;
  while ((f = faceRe.exec(src)) !== null) faces.push([f.index, f.index + f[0].length]);
  const inFace = (i) => faces.some(([a, b]) => i >= a && i < b);

  const out = [];
  const re = /(^|[;{}\s])(font-family|font)\s*:\s*([^;}]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (inFace(m.index)) continue;
    const before = src.slice(0, m.index);
    out.push({
      prop: m[2],
      value: m[3].replace(/\s+/g, " ").trim(),
      line: before.split("\n").length,
    });
  }
  return out;
}

let bad = 0;
let definitions = 0;
let uses = 0;

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const src = readFileSync(file, "utf8");

  // 정의는 한 자리여야 한다. 둘이면 그 순간 두 벌이고, 어느 것이 이기는지는 순서가 정한다.
  const defs = [...src.matchAll(new RegExp(`${TOKEN}\\s*:`, "g"))].length;
  definitions += defs;

  for (const d of declarations(src)) {
    if (d.value.includes(`var(${TOKEN}`)) {
      uses += 1;
      continue;
    }
    const bareValue = d.value.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (SINGLE_KEYWORDS.has(bareValue)) continue;
    // `font:` 축약형은 크기·굵기도 담는다 — 패밀리 이름이 없으면 스택을 고르는 선언이 아니다.
    const namesFamily =
      /["']/.test(bareValue) || /\b(monospace|sans-serif|serif|system-ui|ui-monospace)\b/.test(bareValue);
    if (!namesFamily) continue;
    // 정의 줄 자신은 허용 — 실제 스택이 사는 유일한 자리다.
    if (src.split("\n").slice(Math.max(0, d.line - 3), d.line).join("\n").includes(TOKEN)) continue;

    bad += 1;
    console.error(
      `font-stack: ${rel}:${d.line} 이 글꼴 스택을 손으로 적는다 — \`${bareValue.slice(0, 60)}\`. ` +
        `\`var(${TOKEN})\` 로 부르라: 스택이 흩어지면 한글 폴백이 그중 몇 군데에서만 빠지고, ` +
        `같은 문자열이 같은 화면에서 어떤 요소만 두부(□)로 그려진다`,
    );
  }
}

if (definitions !== 1) {
  console.error(
    `font-stack: ${TOKEN} 정의가 ${definitions}개다 — 하나여야 한다. ` +
      `둘이면 그 순간 두 벌이고, 어느 쪽이 이기는지는 규칙이 아니라 순서가 정한다`,
  );
  bad += 1;
}
if (uses === 0) {
  console.error(`font-stack: ${TOKEN} 를 부르는 자리가 0 이다 — 파싱이 비면 위반도 0 으로 보인다`);
  bad += 1;
}

if (bad > 0) process.exit(1);
console.log(`font-stack: OK — 스택 정의 1개 · 부르는 자리 ${uses}개 · 손으로 적은 자리 0`);
