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
