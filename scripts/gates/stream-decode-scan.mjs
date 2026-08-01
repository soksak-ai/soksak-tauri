// 스트림에서 온 바이트는 **모으고 나서** 디코드한다 — 청크 경계는 글자 경계가 아니다.
//
// 소켓·파이프 청크는 임의 지점에서 나뉜다. 멀티바이트 한 글자가 거기 걸린 채 청크마다
// `toString("utf8")` 하면 앞뒤가 각각 U+FFFD 로 대체된다. 그 값은 **오류가 아니라 손상된
// 문자열**로 흘러가고, 상태에 들어가 다시 저장되면 손상이 영구히 남는다.
//
// 실측(2026-08-01): `frameworks/electron/backend.cjs` 가 `buf += chunk.toString("utf8")` 였다.
// 그 다리로 읽은 워크스페이스 스냅샷의 탭 제목이 `터미널(����티)` 로 깨져 저장됐고, 정본도
// 앱이 받는 값도 멀쩡한데 화면만 계속 깨져 보였다. 형제 파일(`control.cjs`)은 같은 자리에
// `setEncoding("utf8")` 를 걸어 두었다 — 같은 사실이 두 자리에 다르게 적혀 한쪽만 틀린 모양이다.
//
// 규칙: `data` 이벤트로 텍스트를 읽는 스트림은 `setEncoding` 을 건다. 그러면 Node 가 경계를
// 들고 있다가 온전한 글자만 넘긴다. 바이너리를 읽는 자리는 애초에 문자열로 만들지 않는다.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 노드에서 도는 코드 — 스트림을 직접 읽는 자리가 여기 있다. */
const DIRS = ["frameworks/electron", "scripts"];

/** 청크를 개별 디코드하는 모양. 이 셋 다 같은 결함이다. */
const DECODE_PER_CHUNK = [
  /\bchunk\s*\.\s*toString\s*\(/,
  /\bd\s*\.\s*toString\s*\(\s*["']utf-?8["']\s*\)/,
  /\+=\s*[A-Za-z_$][\w$]*\.toString\(\s*["']utf-?8["']\s*\)/,
];

function files(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "build") continue;
        walk(p);
      } else if (/\.(c?js|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const all = DIRS.flatMap(files);
if (all.length === 0) {
  console.error("stream-decode: 대상 파일을 하나도 못 찾았다 — 파싱이 비면 위반이 0 으로 보인다");
  process.exit(1);
}

let bad = 0;
let scanned = 0;
for (const file of all) {
  const rel = file.slice(ROOT.length + 1);
  scanned += 1;
  // 주석은 코드가 아니다 — 이 규칙을 설명하는 문장이 자기 자신에 걸리면 안 된다.
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (DECODE_PER_CHUNK.some((re) => re.test(code))) {
      bad += 1;
      console.error(
        `stream-decode: ${rel}:${i + 1} 이 청크를 개별 디코드한다 — \`${code.trim().slice(0, 60)}\`. ` +
          `스트림에 \`setEncoding("utf8")\` 를 걸어라: 청크 경계는 글자 경계가 아니고, ` +
          `걸린 멀티바이트는 오류가 아니라 U+FFFD 로 조용히 바뀐다`,
      );
    }
  });
}

if (bad > 0) process.exit(1);
console.log(`stream-decode: OK — 노드 소스 ${scanned}개 · 청크 개별 디코드 0`);
