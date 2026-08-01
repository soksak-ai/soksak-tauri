// 브라우저에서 도는 코드는 `require` 를 부를 수 없다 — 그 자리는 **런타임에만** 터진다.
//
// 실측(2026-08-01): `src/state/titleHeal.ts` 가 "지연 import" 라며 `require("../plugins/…")` 를
// 썼다. tsc 는 타입만 보므로 통과했고, vitest 는 node 환경이라 `require` 가 있어 5개 테스트가
// 전부 GREEN 이었다. 앱에서만 `ReferenceError: Can't find variable: require` 가 났고, 그것이
// 복원 경로 안이라 **워크스페이스가 통째로 안 열렸다** — 화면은 "열린 프로젝트가 없습니다"만
// 보여 주고, 원인은 활동 원장의 `restore:error` 한 줄에만 있었다.
//
// 타입도 테스트도 못 잡는 자리라 규칙이 필요하다. 규칙은 단순하다: `src/` 는 브라우저 코드이고,
// 거기서 모듈을 가져오는 길은 `import` 하나다. 앱 상태가 필요하면 **인자로 받는다** — 순수
// 규칙이 배선을 직접 부르려 할 때 이 유혹이 온다.
//
// 노드에서 도는 코드(`scripts/`·`frameworks/electron/`)는 대상이 아니다. 거기선 `require` 가 정상이다.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BROWSER_DIR = join(ROOT, "src");

/** 브라우저 코드가 쓸 수 없는 노드 전역 — 부르면 그 자리에서 터진다. */
const FORBIDDEN = [
  { re: /(^|[^.\w])require\s*\(/, what: "require(", why: "브라우저에 없다 — import 를 쓰거나 인자로 받아라" },
  { re: /(^|[^.\w])module\.exports\b/, what: "module.exports", why: "ESM 이다 — export 를 쓴다" },
  { re: /(^|[^.\w])__dirname\b/, what: "__dirname", why: "브라우저에 없다 — 경로는 값으로 받는다" },
];

/** 이 규칙 밖 — 노드에서 도는 파일. 테스트는 node 환경이라 `require` 가 정상이다. */
const isNodeSide = (rel) => /\.test\.[jt]sx?$/.test(rel) || rel.includes("/__tests__/");

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

if (!existsSync(BROWSER_DIR)) {
  console.error(`browser-module: 대상 디렉터리가 없다 — ${BROWSER_DIR}`);
  process.exit(1);
}

const files = sourceFiles(BROWSER_DIR);
if (files.length === 0) {
  console.error("browser-module: 소스를 하나도 못 찾았다 — 파싱이 비면 위반이 0 으로 보인다");
  process.exit(1);
}

let bad = 0;
let scanned = 0;
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  if (isNodeSide(rel)) continue;
  scanned += 1;
  // 주석은 코드가 아니다 — 규칙을 설명하는 문장이 자기 자신에 걸리면 안 된다. 블록 주석은
  // 여러 줄에 걸치므로 **파일 단위로** 지운다(줄 단위로 지우면 여는 줄만 사라지고 본문이 남아,
  // 산문 속 `must require (…)` 같은 문장이 위반으로 잡힌다 — 실측).
  const whole = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const lines = whole.split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const f of FORBIDDEN) {
      if (f.re.test(code)) {
        bad += 1;
        console.error(`browser-module: ${rel}:${i + 1} 이 \`${f.what}\` 을 쓴다 — ${f.why}`);
      }
    }
  });
}

if (bad > 0) process.exit(1);
console.log(`browser-module: OK — 브라우저 소스 ${scanned}개 · 노드 전역 사용 0`);
