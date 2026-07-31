// UI 는 명령을 통해 움직인다 — 명령이 이미 노출한 동작을 store 로 우회하지 않는다.
//
// 명령 층이 하는 일은 실행만이 아니다: 관측(활동 원장 발행)·정규화·봉투·danger 게이트·hint 가
// 전부 거기 있다. UI 가 store 를 직접 부르면 그 층을 통째로 건너뛴다.
//
// 실측(2026-07-31): 사용자가 탭의 `+` 로 스페이스를 만들었는데 cored 활동 원장에 **한 줄도
// 남지 않았다**. `+` 는 `space.create` 명령을 부르지 않고 store 의 `addContent` 를 직접 불렀기
// 때문이다. 그래서 "무엇이 일어났는가"를 밖에서 읽을 방법이 없었고, 원인 추적이 추측이 됐다.
//
// 규칙: catalog 핸들러가 부르는 store 함수는 **그 동작의 명령이 존재한다는 뜻**이다. 같은
// 함수를 UI 컴포넌트가 직접 부르면 같은 동작에 두 경로가 생기고, 두 경로는 갈릴 때까지 조용하다.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

// 못 박은 우회 수 — **래칫이다.** 늘면 실패한다: 명령을 우회하는 UI 경로가 새로 생겼다는
// 뜻이고, 그 경로의 동작은 원장에 남지 않아 사후에 추적할 수 없다.
//
// 실측 2026-07-31: 17 → 16. 사용자 원 증상의 경로(스페이스 생성)를 먼저 옮겼다. 남은 것은
// 전환·이름변경·뷰 닫기·이동·분할 크기다 — 전부 사용자 의도 동작이고 전부 원장에 안 남는다.
// 0 까지 내린다. 연속 제스처(드래그 리사이즈)는 중간값까지 명령으로 보낼 이유가 없으므로,
// 옮길 때 완결 시점 하나만 명령으로 남기고 중간은 로컬로 둔다.
const BYPASS_CAP = 16;

function files(glob) {
  return execSync(`git ls-files ${glob}`, { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test."));
}

// catalog 핸들러가 부르는 store 변이 함수 — 이 이름들은 "명령이 있다"는 증거다.
const commanded = new Set();
for (const f of files("'src/commands/catalog*.ts'")) {
  const text = readFileSync(ROOT + f, "utf8");
  for (const m of text.matchAll(/\bS\(\)\.(\w+)\(/g)) commanded.add(m[1]);
}

// 오라클 생존 — 하나도 못 모으면 0 은 "깨끗함"이 아니라 "못 쟀음"이다.
if (commanded.size === 0) {
  console.error("ui-through-commands-scan: catalog 에서 store 호출을 하나도 읽지 못했다 — 판정 불가");
  process.exit(1);
}

// 플러그인이 자기 사실을 보고하는 ctx 콜백은 명령 우회가 아니다 — 호출자가 UI 가 아니라
// 플러그인이고, 그 보고는 뷰 컨텍스트 계약(PluginViewContext)이 이미 규정한 채널이다.
const REPORTING_CHANNELS = new Set([
  "setViewStatus",
  "setViewTitle",
  "setViewIcon",
  "setViewRuntime",
]);

const bypass = [];
for (const f of [...files("'src/components/*.tsx'"), ...files("'src/ui/*.ts'")]) {
  const text = readFileSync(ROOT + f, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const fn of commanded) {
      if (REPORTING_CHANNELS.has(fn)) continue;
      // `s.addContent` 구독이든 `getState().addContent` 든 같은 우회다.
      if (new RegExp(`\\.${fn}\\b`).test(line)) {
        bypass.push({ file: f, line: i + 1, fn, text: line.trim() });
        break;
      }
    }
  });
}

if (bypass.length > BYPASS_CAP) {
  console.error(
    `ui-through-commands-scan: 명령을 우회하는 UI 경로 ${bypass.length}건(못 박은 수 ${BYPASS_CAP}).`,
  );
  console.error("  같은 동작의 명령을 execute() 로 부르라 — 원장·정규화·게이트가 거기 있다.");
  for (const b of bypass.slice(0, 30)) {
    console.error(`  ${b.file}:${b.line}  ${b.fn} — ${b.text}`);
  }
  process.exit(1);
}

console.log(
  `ui-through-commands-scan: OK (명령 소유 store 함수 ${commanded.size}개 · 우회 ${bypass.length}/${BYPASS_CAP})`,
);
