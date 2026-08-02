// **자식 뷰를 전제한 장치는 그 전제를 물어야 한다.**
//
// Tauri 와 Electron 은 동급의 프레임워크다. 그런데 한쪽 프레임워크의 물리(콘텐츠가 문서 밖 네이티브 자식이라
// 표면이 명시 좌표 쓰기로만 움직인다)를 전제한 장치가 코어에 **조건 없이** 서면, 그 물리가
// 아닌 프레임워크에서 **없던 결함을 만든다.**
//
// 실측(2026-08-02): 판 교체가 끝나고 딱 한 프레임 브라우저가 사라졌다 나타났다. 원인은
// slotFreeze(움직이는 동안 정지 사진으로 덮고 표면을 감추는 장치)가 콘텐츠가 DOM 안에 사는
// 프레임워크에서도 돌았다는 것이다. 덮을 것도 감출 것도 없는데 감췄다 드러내니 그 사이가 빈다.
// 깜빡임을 워크어라운드가 만들고 있었다.
//
// 그 사실을 선언하는 축은 이미 있다: `engineProvision.nativeChildWebview`(어댑터가 답한다).
// 이 게이트는 **그 축을 묻지 않는 장치**를 잡는다. 물어보고 안 도는 것은 통과, 아예 안 묻는
// 것이 위반이다 — "이 프레임워크에서도 필요한가"를 코드가 스스로 답해야 한다.
//
// 새 장치가 나면 여기서 실패하고, 그 실패가 묻는다: 이건 어느 프레임워크의 물리인가.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "src");

/** 축의 이름 — 이것을 부르면 "물었다"로 센다. */
const AXIS = "nativeChildWebview";

/** 자식 뷰 물리를 실제로 **시행하는** 표식. 낱말이 아니라 장치의 이름들이다. */
const ENFORCERS = [
  "createSlotFreeze", // 표면을 감추고 사진으로 덮는다
  "ensureSlotFreezeHost",
  "emitVeil", // 표면에 "감춰라"를 보낸다
  "applyRailHoleClip", // 표면 위에 칠하지 않으려고 평면을 자른다
  "collectHoleRects",
  "webview_dom_holes", // OS 히트테스트에 홀을 보고한다
  "webview_bounds", // 표면을 명시 좌표로 옮긴다
];

/** 면제 — 이유가 있어야 한다. 이유 없는 면제는 면제가 아니다. */
const EXEMPT = new Map([
  [
    "src/lib/slotFreeze.ts",
    "장치의 구현 자체. 설치 여부는 소유자(slotFreezeHost)가 축을 물어 정한다 — 구현이 자기 존재를 되묻지 않는다.",
  ],
  [
    "src/lib/railHoleClip.ts",
    "클립 경로를 만드는 순수 함수. 걸지 말지는 소유자(railHoleClipHost)가 축을 물어 정한다.",
  ],
  [
    "src/lib/contentViews.ts",
    "두 길(네이티브 호스트·DOM 호스트)을 나란히 두는 자리. 어느 길인지는 프레임워크가 위임으로 답한다(FRAMEWORK_DELEGATED).",
  ],
  [
    "src/plugins/api.ts",
    "플러그인 표면 — 사실을 전달만 한다. 장치를 켜고 끄는 결정은 코어 소유자에 있다.",
  ],
]);

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

if (!existsSync(SRC)) {
  console.error(`framework-physics: 대상이 없다 — ${SRC}`);
  process.exit(1);
}

const offenders = [];
let scanned = 0;
for (const file of files(SRC)) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  // 주석은 벗긴다 — 사고를 적어 둔 근거 문장이 위반으로 잡히면 규칙이 자기 근거를 지운다.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const used = ENFORCERS.filter((name) => code.includes(name));
  if (used.length === 0) continue;
  scanned += 1;
  if (EXEMPT.has(rel)) continue;
  if (code.includes(AXIS)) continue;
  offenders.push({ rel, used });
}

if (scanned === 0) {
  console.error("framework-physics: 장치를 하나도 못 찾았다 — 파싱이 비면 위반이 0 으로 보인다");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error("framework-physics: 자식 뷰를 전제한 장치가 그 전제를 묻지 않는다.");
  for (const o of offenders) console.error(`  - ${o.rel} → ${o.used.join(", ")}`);
  console.error(
    `\n${AXIS} 를 물어 이 껍데기에서 필요한지 정하거나, 면제 표에 **이유와 함께** 올려라.`,
  );
  process.exit(1);
}

console.log(`framework-physics: PASS (장치를 쓰는 ${scanned}개 파일이 전부 전제를 묻거나 면제 사유를 가진다)`);
