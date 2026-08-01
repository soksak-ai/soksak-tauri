// 프로세스를 건너는 이름은 **한 자리에서 온다** — 리터럴로 적으면 갈린다.
//
// 사건 이름과 만나는 자리 이름(소켓 파일명)이 같은 축이다: 한쪽만 고치면 발행이 아무에게도
// 안 닿거나, 붙으려는 쪽이 빈 자리를 두드린다. 둘 다 오류가 아니라 **아무 일도 안 일어남**이다.
//
// 발행자가 여럿이고 구독자는 어느 프로세스가 보냈는지 모른다. 이름이 갈리면 한쪽 발행은
// 아무에게도 안 닿고, 그 부재는 오류가 아니라 **안 오는 사건**이다.
//
// 실측(2026-08-01): `"activity"` 가 Rust 발행 세 곳·Tauri 한 곳·Electron 한 곳에 리터럴로
// 있었고, 같은 축의 `data-change` 는 앱이 `kv_set`·cored 가 `kv-set` 을 실어 이미 갈려 있었다.
//
// Rust 는 상수를 공유하므로 컴파일이 묶는다. **JS 는 못 묶는다** — 그래서 이 게이트가 JS
// 리터럴을 Rust 정본과 대조한다. 값을 손으로 적지 않는다: 두 파일에서 읽어 비교한다.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 정본(Rust 상수) ↔ 사본(JS 리터럴). 사본이 정본과 다르면 실패다. */
const PAIRS = [
  {
    what: "활동 사건",
    truth: { file: "crates/soksak-core/src/activity.rs", re: /pub const EVENT: &str = "([^"]+)"/ },
    copies: [{ file: "frameworks/electron/activity.cjs", re: /const ACTIVITY_EVENT = "([^"]+)"/ }],
  },
  {
    what: "프로젝트 지도 변경 사건",
    truth: {
      file: "crates/soksak-core/src/project_registry.rs",
      re: /pub const CHANGE_EVENT: &str = "([^"]+)"/,
    },
    copies: [
      { file: "frameworks/electron/native/project.cjs", re: /const CHANGE_EVENT = "([^"]+)"/ },
      { file: "src/state/projectRegistry.ts", re: /safeListen\("([^"]+)", refresh\)/ },
    ],
  },
  {
    what: "저장소 변경 사건",
    truth: { file: "crates/soksak-core/src/data_change.rs", re: /pub const EVENT: &str = "([^"]+)"/ },
    copies: [],
  },
  {
    // 갈리면 두 프로세스가 **다른 장부**를 본다. 앱이 쓴 slot 을 cored 가 못 찾고, 재시작하면
    // 그 창이 안 열린다 — 오류가 아니라 "창이 사라졌다"로 나타난다. 오늘 이 키 위에서
    // 워크스페이스를 네 번 잃었다.
    what: "워크스페이스 장부 키",
    truth: {
      file: "crates/soksak-core/src/window_traces.rs",
      re: /pub const MANIFEST_KEY: &str = "([^"]+)"/,
    },
    // **값을 패턴에 박지 않는다** — 박으면 틀린 값이 아예 안 잡혀 게이트가 통과한다(실측:
    // 그렇게 만들었고 심은 위반을 못 물었다). 자리는 형제 줄(lsKey)로 짚는다.
    copies: [
      { file: "src/state/windowBoot.ts", re: /key: "([^"]+)",\n\s*lsKey: "soksak\.windows"/ },
    ],
  },
  {
    // 오케스트레이터 라벨. 갈리면 컨트롤 플레인 분기가 영영 거짓이라 앱이 부팅만 하고 만다
    // (src/main.tsx 가 이 이름 하나로 분기한다).
    what: "오케스트레이터 창 라벨",
    truth: {
      file: "crates/soksak-core/src/control.rs",
      re: /pub const CONTROL_PLANE_LABEL: &str = "([^"]+)"/,
    },
    copies: [{ file: "src/state/windowPersistence.ts", re: /s\.label !== "([^"]+)"/ }],
  },
  {
    what: "콘텐츠 뷰 항행 사건",
    truth: { file: "crates/soksak-core/src/webview_event.rs", re: /pub const NAV: &str = "([^"]+)"/ },
    copies: [{ file: "src/lib/contentViewEvents.ts", re: /nav: "([^"]+)"/ }],
  },
  {
    what: "콘텐츠 뷰 제목 사건",
    truth: { file: "crates/soksak-core/src/webview_event.rs", re: /pub const TITLE: &str = "([^"]+)"/ },
    copies: [{ file: "src/lib/contentViewEvents.ts", re: /title: "([^"]+)"/ }],
  },
  {
    what: "콘텐츠 뷰 적재 사건",
    truth: { file: "crates/soksak-core/src/webview_event.rs", re: /pub const LOADING: &str = "([^"]+)"/ },
    copies: [{ file: "src/lib/contentViewEvents.ts", re: /loading: "([^"]+)"/ }],
  },
  {
    what: "콘텐츠 뷰 상태 사건",
    truth: { file: "crates/soksak-core/src/webview_event.rs", re: /pub const STATUS: &str = "([^"]+)"/ },
    copies: [{ file: "src/lib/contentViewEvents.ts", re: /status: "([^"]+)"/ }],
  },
  {
    what: "콘텐츠 뷰 외부열기 사건",
    truth: {
      file: "crates/soksak-core/src/webview_event.rs",
      re: /pub const OPEN_EXTERNAL: &str = "([^"]+)"/,
    },
    copies: [{ file: "src/lib/contentViewEvents.ts", re: /openExternal: "([^"]+)"/ }],
  },
  {
    // 이름이 아니라 **문법**이다. 웹뷰 목록은 앱 전역이라 "자기 창 것만 고르는 일"이 세 자리에서
    // 일어난다 — 접두사가 갈리면 한쪽은 남의 창 웹뷰를 자기 것으로 세거나 자기 것을 못 찾는다.
    what: "브라우저 자식 웹뷰 라벨 접두사",
    truth: {
      file: "crates/soksak-core/src/window_spec.rs",
      re: /pub const BROWSER_PREFIX: &str = "([^"]+)"/,
    },
    copies: [
      { file: "src/lib/webviewLabels.ts", re: /export const BROWSER_PREFIX = "([^"]+)"/ },
      { file: "frameworks/electron/native/webview.cjs", re: /const BROWSER_PREFIX = "([^"]+)"/ },
    ],
  },
  {
    // 사건이 아니라 **만나는 자리**의 이름이다. 갈리면 한쪽이 띄운 cored 를 다른 쪽이 못 찾고,
    // 그때 프레임워크는 자기 것을 또 띄운다 — 같은 홈에 백엔드가 둘이 된다.
    what: "cored 소켓 파일명",
    truth: {
      file: "crates/soksak-core/src/identity.rs",
      re: /pub const CORED_SOCKET_FILE: &str = "([^"]+)"/,
    },
    copies: [{ file: "frameworks/electron/cored.cjs", re: /const SOCKET_FILE = "([^"]+)"/ }],
  },
];

function read(rel, re, label) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    console.error(`event-name: ${label} 파일이 없다 — ${rel}`);
    process.exit(1);
  }
  const m = re.exec(readFileSync(p, "utf8"));
  if (!m) {
    console.error(`event-name: ${label} 에서 이름을 못 읽었다 — ${rel}. 파싱이 조용히 비면 갈림이 0 으로 보인다`);
    process.exit(1);
  }
  return m[1];
}

let bad = 0;
for (const pair of PAIRS) {
  const truth = read(pair.truth.file, pair.truth.re, `${pair.what} 정본`);
  for (const c of pair.copies) {
    const copy = read(c.file, c.re, `${pair.what} 사본`);
    if (copy !== truth) {
      bad += 1;
      console.error(
        `event-name: ${pair.what} 이름이 갈렸다 — ${pair.truth.file}="${truth}" vs ${c.file}="${copy}". ` +
          `구독자는 어느 프로세스가 보냈는지 모른다: 갈리면 한쪽 발행이 아무에게도 안 닿는다`,
      );
    }
  }
  console.log(`event-name: ${pair.what} "${truth}" — 사본 ${pair.copies.length}개 대조`);
}
if (bad > 0) process.exit(1);
