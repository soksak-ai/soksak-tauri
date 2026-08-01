// 답의 주인은 **선언과 코드가 같아야** 한다.
//
// 명령이 `windowScoped: false` 라고 적으면 "어느 창에서 돌든 같은 답"이라는 뜻이다. 그 선언을
// 보고 배달이 한 번만 보낸다 — 한 홈에 두 앱이 뜨면 `main` 같은 이름을 둘이 들고(오케스트레이터는
// 앱마다 하나다), 그때 전부에게 보내면 주인이 답하는 명령은 **같은 일이 두 번 돈다**
// (실측 2026-08-01: `data.kv.set` 이 두 프로세스에서 각각 실행됐다).
//
// 선언이 틀리면 그 대가는 조용하다: 창-지역 명령을 주인의 것이라 적으면 한 창에서만 돌아
// 다른 창이 안 바뀌고, 반대면 두 번 돈다. 둘 다 오류로 안 보인다.
//
// 그래서 소스에서 **다시 센다**: 핸들러가 창-지역 상태(useSessions·useProjection·document·
// window.·currentWindowLabel·querySelector·getState())를 만지면 창-지역이다. 그 판정과 선언이
// 어긋나면 실패한다. 세는 쪽이 규칙이 아니라 **선언이 규칙**이고, 이 게이트는 선언이 코드를
// 배신하지 않는지만 본다.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIR = "src/commands";

/** 창-지역 상태의 표식. 이 중 하나라도 핸들러에 있으면 그 답은 이 창의 것이다. */
const WINDOW_LOCAL = [
  /\buseSessions\b/,
  /\buseProjection\b/,
  /\bdocument\./,
  /\bwindow\./,
  /currentWindowLabel/,
  /querySelector/,
  /getState\(\)/,
];

const files = readdirSync(join(ROOT, DIR)).filter(
  (f) => f.endsWith(".ts") && !f.includes(".test."),
);
if (files.length === 0) {
  console.error("owner-answer: 명령 소스를 하나도 못 찾았다 — 빈 스캔은 통과가 아니다");
  process.exit(1);
}

const wrong = [];
let declared = 0;
for (const f of files) {
  const src = readFileSync(join(ROOT, DIR, f), "utf8");
  const marks = [...src.matchAll(/\n  register\("([\w.-]+)",\s*\{/g)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(start, end);
    const saysOwner = /windowScoped:\s*false/.test(body);
    if (!saysOwner) return; // 선언 안 한 것은 창-지역이 기본 — 잴 것이 없다
    declared += 1;
    const hs = body.indexOf("handler:");
    const handler = hs >= 0 ? body.slice(hs) : body;
    const touch = WINDOW_LOCAL.find((re) => re.test(handler));
    if (touch) wrong.push(`${DIR}/${f} :: ${m[1]} — 핸들러가 창-지역 상태를 만진다(${touch})`);
  });
}

if (declared === 0) {
  console.error("owner-answer: 주인이 답한다고 적은 명령이 하나도 없다 — 선언이 사라졌다");
  process.exit(1);
}
if (wrong.length > 0) {
  console.error(`owner-answer: 선언이 코드와 어긋난 명령 ${wrong.length}건.`);
  console.error("  주인이 답한다고 적었는데 핸들러가 이 창의 상태를 만진다 — 그러면 한 창에서만 돌아");
  console.error("  다른 창이 안 바뀌고, 그 어긋남은 오류가 아니라 '가끔 반영이 안 된다'로 나타난다.");
  for (const w of wrong) console.error(`  ${w}`);
  process.exit(1);
}
console.log(`owner-answer: OK — 주인이 답하는 명령 ${declared}개 · 코드와 어긋남 0`);
