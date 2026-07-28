// 프레임워크 표는 **얇은 배선**이다 — 규칙을 갖지 않는다.
//
// 원칙: 규칙은 `soksak-core` 가 소유하고 Tauri·Electron·cored 는 **연결**한다. 프레임워크가
// JS 로 규칙을 다시 쓰면 그것은 이식이 아니라 두 번째 앱이고, 두 벌은 갈리는 순간까지 조용하다.
//
// 이 세션에서 실제로 여덟 번 그랬다 — ipc.rs 재구현(걷어냄) · 점유 지도 · 창 라벨·멱등 규칙 ·
// 뷰 조작 · 낡은 사유로 거절 선언 · 요약 규칙 오작성 · 보존 규칙 반쪽 분산 · 심링크 검사에서
// junction 누락. 사람 주의력으로는 막히지 않는다는 것이 그 여덟 번의 결론이다.
//
// **무엇이 규칙이고 무엇이 배선인가.** 배선은 프레임워크 API 를 부르고 값을 그대로 나른다.
// 규칙은 값을 보고 갈라지거나 새 값을 만든다 — 그 갈래가 Rust 에도 있으면 두 벌이다.
//
// 그래서 여기는 **분기 밀도**로 잰다. 완벽한 판별이 아니라 임계다: 넘으면 "이 로직이 코어에
// 있어야 하는 것 아닌가"를 사람이 한 번 답하게 만든다. 답이 "아니다"면 장부에 사유와 함께
// 올린다 — 오인의 대가는 "고쳐라"가 아니라 "선언하라"다.
//
// 장부는 래칫이다: 늘면 위반(새로 발명했다), 줄어도 위반(코어로 옮겼으면 장부에서 빼라).

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
export const REPO_ROOT = resolve(HERE, "../..");
const TABLE_DIR = join(REPO_ROOT, "electron/native");

/** 이 수를 넘는 분기가 있으면 규칙일 가능성이 높다. */
export const BRANCH_LIMIT = 2;

/**
 * 선언된 로직 — 코어로 못 옮기는 이유를 한 줄씩 적는다.
 *
 * 여기 있다는 것은 "이 갈래는 프레임워크 API 의 모양 때문이지 우리 규칙이 아니다"라는 주장이다.
 * 그 주장이 틀리면 옮기고 장부에서 뺀다.
 */
export const LOGIC_LEDGER = new Map([
  [
    "window_set_background",
    [3, "판정을 부르는 자리와 부른 창 부재. 색 규칙(#rrggbb·축약 불가)은 코어가 소유하고 같은 픽스처가 묶는다(fixtures/surface-spec.json)"],
  ],
  [
    "window_create",
    [5, "남은 갈래는 창 사실(살아 있는가)과 라벨 생성뿐이다. rect 유효성·focus 기본·워크스페이스 라벨 판정은 코어가 소유하고(soksak-core window_spec), 이 사본이 갈리지 않는다는 것은 같은 픽스처가 묶는다(fixtures/window-rect.json)"],
  ],
  [
    "window_place",
    [2, "rect 네 값의 타입 검사 — 같은 규칙을 코어가 소유하고 픽스처가 묶는다(window-rect.json). 여기 남는 것은 그 판정을 부르는 자리다"],
  ],
  [
    "window_monitors",
    [2, "화면 읽기의 갈래만 남았다. 소속 판정(중심점·경계·버림 방향)은 코어가 소유하고(soksak-core geometry), 이 사본이 갈리지 않는다는 것은 같은 픽스처가 묶는다(fixtures/monitor-of.json — 양쪽 검사가 그 파일 하나를 읽는다). 왕복으로 바꾸는 것도 재 봤다: 창마다 프로세스를 건너고, 백엔드가 없으면 프레임워크 사실이 죽는다"],
  ],
  [
    "webview_open_window",
    [2, "여는 주소 판정을 부르는 자리. 스킴 정책(http/https 만·소문자 비교)은 코어가 소유하고 같은 픽스처가 묶는다 — 갈리면 한쪽만 막던 스킴을 다른 쪽이 연다"],
  ],
  [
    "project_claim",
    [4, "점유 지도 판정. **옮기지 않는다** — 지도의 수명이 곧 창의 수명이라 창을 소유한 쪽이 져야 한다(cored 가 쥐면 재기동 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다. cored 의 UNSERVED 가 같은 사유를 적었다). 그래서 구현은 둘이고, 규칙이 갈리지 않는다는 것은 같은 픽스처가 묶는다(fixtures/project-claims.json — Rust ProjectRegistry 검사와 JS 검사가 그 파일 하나를 읽는다)"],
  ],
  [
    "project_release",
    [2, "같은 지도의 소유자 판정 — 같은 픽스처가 함께 묶는다(해제는 소유 창만)"],
  ],
]);

/** 표 파일에서 `answer` 본문과 그 명령 이름을 뽑는다. */
export function logicSites(dir = TABLE_DIR) {
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".cjs"))) {
    if (file === "index.cjs" || file === "error.cjs") continue; // 표가 아니라 배선·상수
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/answer:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n    \},/g)) {
      const name = src.slice(0, m.index).match(/(\w+):\s*\{[^{]*$/)?.[1] ?? "?";
      // 분기로 센다 — 조건·반복·단축평가·삼항. 완벽한 판별이 아니라 임계다.
      const branches = (m[1].match(/\bif\b|\bfor\b|\bwhile\b|\?\s|&&|\|\|/g) || []).length;
      if (branches >= BRANCH_LIMIT) out.push({ file, name, branches });
    }
  }
  return out;
}

export function violations() {
  const found = logicSites();
  const seen = new Set();
  const out = [];
  for (const { file, name, branches } of found) {
    seen.add(name);
    const declared = LOGIC_LEDGER.get(name);
    if (!declared) {
      out.push(
        `${file}: ${name} 에 분기 ${branches}개 — 규칙을 프레임워크가 갖는다. ` +
          `코어로 옮기거나 LOGIC_LEDGER 에 사유와 함께 올려라`,
      );
    } else if (declared[0] !== branches) {
      out.push(
        `${file}: ${name} 장부 ${declared[0]}개 ≠ 실측 ${branches}개 — ` +
          `늘었으면 발명했고, 줄었으면 장부를 줄여라`,
      );
    }
  }
  for (const [name] of LOGIC_LEDGER) {
    if (!seen.has(name)) out.push(`${name}: 장부에 있는데 로직이 없다 — 옮겼으면 장부에서 빼라`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 오라클 생존 — 표를 못 읽으면 위반 0 이 되어 통과로 위장한다("0 의 두 얼굴").
  const sites = logicSites();
  if (sites.length === 0) {
    console.error("framework-thin-binding: FAIL — 표에서 answer 를 하나도 못 읽었다(파서가 죽었다)");
    process.exit(1);
  }
  const v = violations();
  if (v.length) {
    console.error(`framework-thin-binding: FAIL (${v.length})`);
    for (const line of v) console.error(`  - ${line}`);
    process.exit(1);
  }
  const total = [...LOGIC_LEDGER.values()].reduce((n, [c]) => n + c, 0);
  console.log(`framework-thin-binding: PASS (선언된 로직 ${total}분기 — 코어로 옮기면 장부도 줄여라)`);
}
