// 모듈 전역 가변 상태는 갈아끼우기 경계를 넘도록 선언해야 한다.
//
// dev 서버는 고친 모듈과 그 importer 체인을 갈아끼운다. 모듈 top-level 에 사는 가변 상태는
// 그때 새 빈 것이 되는데, 그것을 채우던 모듈이 함께 갈리지 않으면 영영 빈 채로 남는다 —
// 등록이 모듈 평가의 부수효과이기 때문이다.
//
// 실측(2026-07-31): 코어 명령 카탈로그가 통째로 사라졌다. 창은 살아 있고 플러그인 명령은
// 답하는데 `ui.*`·`state.*`·`window.*` 만 전부 UNKNOWN_COMMAND. 사용자에겐 "탭의 + 로
// 생성이 안 된다"로 보였다(+ 는 등록 프로그램 0이면 사라지는 버튼).
//
// 판별을 "등록부인가 캐시인가"로 나누지 않는다 — 그 판별은 사람이 매번 손으로 해야 하고,
// 손으로 하는 판별은 하나를 놓친다. 규칙은 하나다: **모듈 top-level 가변 상태는 moduleState
// 로 선언한다.** dev 에서만 관여하므로 캐시를 보존해도 해가 없고, 규칙이 하나면 빠질 자리가
// 없다.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

// 못 박은 미선언 수 — **래칫이다.** 늘면 실패한다: 갈아끼우기에 사라질 상태가 새로 생겼다는
// 뜻이고, 그 소실은 "되던 게 우연처럼 안 된다"로만 드러난다. 줄면 이 수를 내려라.
//
// 실측 2026-07-31: 106 → 96. 등록부(명령·뷰·플러그인 활성·버스·훅·헤더·상태바)에 이어
// **"이미 붙였다"는 기억**(installed·started)과 **주입점**(다른 모듈이 채우는 자리)을 내렸다 —
// 이 둘이 사라지면 채운 쪽은 이미 채웠다고 알아 다시 채우지 않고, 남는 것은 "아무도 답하지
// 않음"이라는 침묵이다(실측: 계측 sink 가 그 모양이었고 원장이 통째로 비었다).
// 남은 것은 대부분 자기 모듈이 채우는 캐시·카운터지만, 그 판별을 사람이 매번 하면 하나를
// 놓친다 — 0 까지 내린다.
const DECLARED_CAP = 20;

function sourceFiles() {
  const out = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test."));
}

// top-level(들여쓰기 0) 의 가변 컬렉션·let 선언.
const PATTERNS = [
  /^const\s+(\w+)\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/,
  /^let\s+(\w+)\s*[:=]/,
  // zustand store 도 모듈 전역 상태다 — 갈리면 등록이 사라진다(뷰 레지스트리가 그 자리다).
  /^export\s+const\s+(\w+)\s*=\s*create[<(]/,
  /^const\s+(\w+)\s*=\s*create[<(]/,
];

function scan(file) {
  const text = readFileSync(ROOT + file, "utf8");
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      hits.push({ file, line: i + 1, name: m[1], text: line.trim() });
      break;
    }
  });
  return hits;
}

const undeclared = sourceFiles().flatMap(scan);

// 오라클 생존 — 파일을 하나도 못 읽었으면 0 은 "깨끗함"이 아니라 "못 쟀음"이다.
const files = sourceFiles();
if (files.length === 0) {
  console.error("module-state-scan: 소스를 하나도 읽지 못했다 — 판정 불가");
  process.exit(1);
}

if (undeclared.length > DECLARED_CAP) {
  console.error(
    `module-state-scan: 갈아끼우기에 사라질 모듈 전역 상태 ${undeclared.length}건(못 박은 수 ${DECLARED_CAP}).`,
  );
  console.error("  moduleState(\"<모듈경로>#<변수명>\", () => ...) 로 선언하라.");
  for (const h of undeclared.slice(0, 40)) {
    console.error(`  ${h.file}:${h.line}  ${h.text}`);
  }
  if (undeclared.length > 40) console.error(`  … 외 ${undeclared.length - 40}건`);
  process.exit(1);
}

console.log(
  `module-state-scan: OK (${files.length}개 파일 · 미선언 ${undeclared.length}/${DECLARED_CAP})`,
);
