// 레퍼런스는 **표면 전체**다 — 창 하나가 답한 것을 전체로 삼지 않는다.
//
// `make docs` 는 실행 중인 앱에게 명령 목록을 물어 `docs/COMMANDS.md` 를 만든다. 그런데 명령
// 표면은 창마다 다르다: 컨트롤 플레인(main) 에만 등록되는 명령이 있고(orchestrator.* —
// 워크스페이스 창에서 UNKNOWN_COMMAND 가 정답이다), 워크스페이스 창이 답하면 그 명령들이
// **조용히 빠진 문서**가 나온다.
//
// 실측(2026-08-02): 창 지정 없이 재생성했더니 `orchestrator.ask`·`orchestrator.stop` 두 줄이
// 사라진 문서가 나왔다. 아무것도 실패하지 않는다 — 문서가 짧아졌을 뿐이고, 그 문서를 커밋하면
// 다음 사람은 그 명령이 없다고 읽는다. 없어진 줄을 눈으로 세는 것은 방법이 아니다.
//
// 그래서 규칙: **창 전용 명령이 레퍼런스에 있어야 한다.** 목록은 손으로 적지 않는다 — 창
// 전용으로 등록하는 카탈로그 파일에서 뽑는다(손으로 적으면 셋째 명령이 나는 날 빠진다).
// Makefile 은 `--window main` 으로 컨트롤 플레인에 물어 이 규칙을 만족시킨다.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 컨트롤 플레인 전용으로 등록되는 카탈로그 — 이 파일이 명령 이름의 원천이다. */
const CONTROL_PLANE_CATALOG = join(ROOT, "src/commands/catalogOrchestrator.ts");
const REFERENCE = join(ROOT, "docs/COMMANDS.md");

for (const p of [CONTROL_PLANE_CATALOG, REFERENCE]) {
  if (!existsSync(p)) {
    console.error(`command-reference: 대상이 없다 — ${p}`);
    process.exit(1);
  }
}

const catalog = readFileSync(CONTROL_PLANE_CATALOG, "utf8");
const names = [...catalog.matchAll(/register\("([\w.]+)"/g)].map((m) => m[1]);
if (names.length === 0) {
  console.error(
    "command-reference: 창 전용 명령을 하나도 못 찾았다 — 파싱이 비면 위반이 0 으로 보인다",
  );
  process.exit(1);
}

const reference = readFileSync(REFERENCE, "utf8");
const missing = names.filter((n) => !reference.includes(`## \`${n}\``));

if (missing.length > 0) {
  console.error("command-reference: 레퍼런스가 표면의 일부만 담고 있다.");
  console.error("빠진 명령(컨트롤 플레인 전용):");
  for (const n of missing) console.error(`  - ${n}`);
  console.error(
    "\n워크스페이스 창이 답한 문서일 가능성이 높다. `make docs` 는 --window main 으로 묻는다.",
  );
  process.exit(1);
}

console.log(`command-reference: PASS (창 전용 명령 ${names.length}개 전부 레퍼런스에 있다)`);
