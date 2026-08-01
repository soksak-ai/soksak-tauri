// 한 사건에 한 길 — 알림 활성화.
//
// 알림 활성화가 하는 일은 하나다: 알림이 실어 온 것을 명령 표면의 주인에게 돌려준다. OS 클릭과
// `notify_activate` 는 **같은 함수**를 불러야 한다. 사본을 두면 명령이 통과해도 클릭은 죽어 있을
// 수 있고, 그때 검증은 아무것도 증명하지 않는다 — 통과가 곧 거짓이 된다.
//
// 검사로는 이것을 잴 수 없다. 두 길이 각각 동작하는 것과 두 길이 같은 것은 다른 사실이고,
// 밖에서는 같은지 볼 수 없다. 그래서 **소스에서 센다**: 활성화가 하는 일을 적은 자리가 하나인가.
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const FILE = "frameworks/electron/native/notify.cjs";

const src = readFileSync(ROOT + FILE, "utf8");

/** 활성화가 하는 일 — 주인에게 넘긴다. 이 표현이 둘이면 두 길이다. */
const DOES = /ctx\.deepLink\(/g;
const does = [...src.matchAll(DOES)];
if (does.length !== 1) {
  console.error(`one-event-one-path: 활성화가 하는 일이 ${does.length}곳에 적혀 있다(1이어야 한다).`);
  console.error("  OS 클릭과 notify_activate 가 같은 함수를 불러야 한다 — 사본을 두면 명령이");
  console.error("  통과해도 클릭은 죽어 있을 수 있고, 그때 검증은 아무것도 증명하지 않는다.");
  console.error(`  ${FILE}`);
  process.exit(1);
}

/** 그 하나가 `activate` 라는 이름을 갖고, 두 부름이 모두 그 이름을 가리키는가. */
const named = /const activate = \(\) => ctx\.deepLink\(/.test(src);
const byClick = /\.on\("click", activate\)/.test(src);
const byName = /LIVE\.set\([^,]+, activate\)/.test(src);
const missing = [
  !named && "활성화에 이름(activate)이 없다 — 이름 없는 사건은 부를 수 없다",
  !byClick && 'OS 클릭이 그 이름을 부르지 않는다(.on("click", activate))',
  !byName && "주소부(LIVE)에 그 이름이 들어가지 않는다 — 밖에서 부를 길이 없다",
].filter(Boolean);
if (missing.length > 0) {
  console.error("one-event-one-path: 활성화의 한 길이 끊겼다.");
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

console.log("one-event-one-path: OK — 알림 활성화는 한 자리(activate) · OS 클릭과 명령이 같은 함수");
