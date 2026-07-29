// 프레임워크 폴더에 세든 **프레임워크 무관 코드**를 센다.
//
// 배치의 법 1번은 "프레임워크 무관 코드는 프레임워크 이름 밑에 두지 않는다"이다. 그런데
// 그것을 지키던 게이트(framework-free-placement)는 **크레이트 단위**로 본다 — 크레이트가
// tauri 를 의존하면 그 안의 모든 파일이 통과한다. 실측: `frameworks/tauri/src/` 안에 프레임워크를
// 한 번도 이름으로 부르지 않는 파일이 9개, 2523줄 있었고 게이트는 전부 통과시켰다.
//
// 그 코드가 거기 있는 것은 결정이 아니라 **이력**이다. 앱이 유일한 백엔드이던 시절에 저장소
// 규칙이 앱 폴더 안에서 자랐고, 프레임워크가 둘이 되자 그 규칙이 한쪽에만 있게 됐다.
//
// ── 판정 근거(정직) ─────────────────────────────────────────────────────────────
// "프레임워크를 부른다"의 신호는 **크레이트 경로 이름**이다(`tauri::`, `require("electron")`).
// 실측으로 이 저장소의 프레임워크 접촉은 전부 그 경로를 지난다(`#[tauri::command]` 171,
// `tauri::Window` 28, `tauri::AppHandle` 23 …). 지역 모듈로 재수출해 그 이름을 감추면 이 게이트가
// 그 파일을 무관으로 오인한다 — 그때는 재수출을 없애라. 이름을 감춘 결합은 이 게이트만 속이는
// 것이 아니라 읽는 사람도 속인다.
//
// ── 무엇을 막는가 ───────────────────────────────────────────────────────────────
// 금지가 아니라 **등재**다. 지금 세든 것은 장부에 있고, 장부에 없는 것이 새로 생기면 위반이다.
// 그리고 장부에 있는데 트리에 없으면 그것도 위반이다 — 옮기고 장부를 안 지우면 건수가 거짓말이
// 되고, 거짓말하는 장부는 곧 무시된다.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/** 프레임워크를 이름으로 부르는 신호. 폴더 이름이 곧 그 프레임워크다. */
export const CONTACT = {
  tauri: [/\btauri\s*::/, /#\[\s*tauri\s*::/, /\bextern\s+crate\s+tauri\b/],
  electron: [/require\(\s*["']electron["']\s*\)/, /from\s+["']electron["']/],
};

const SOURCE_EXT = /\.(rs|cjs|mjs|js|ts|tsx)$/;

/**
 * 프레임워크를 이름으로 부르지 않는 파일 전부. 갈래를 **사람이** 정한다.
 *
 *   framework — 주제가 프레임워크다. 이름을 안 부르는 이유는 창·웹뷰 핸들을 **주입받기**
 *               때문이고, 그것이 옳은 모양이다. 여기 있어야 한다.
 *   tenant    — 프레임워크 무관이다. 여기 있는 것은 결정이 아니라 이력이고, 코어로 간다.
 *
 * 새 파일은 둘 중 하나로 등재해야 한다. 등재를 강제하는 이유는 판정이 문법이 아니라 **의미**의
 * 문제여서다(ambient_gate 와 같은 선례). 옮기면 그 줄을 지운다 — 안 지우면 건수가 거짓말이 된다.
 */
export const DECLARED = new Map([
  // ── framework: 주제가 창·웹뷰·이 프레임워크의 배선이다 ──────────────────────
  ["frameworks/electron/activity.cjs", ["framework", "활동 부채질 중 프레임워크의 몫"]],
  ["frameworks/electron/backend.cjs", ["framework", "이 프레임워크의 백엔드 다리(소켓 클라이언트)"]],
  ["frameworks/electron/control.cjs", ["framework", "밖에서 온 명령이 창에 닿는 길"]],
  ["frameworks/electron/cored.cjs", ["framework", "이 프레임워크가 자기 백엔드를 세우는 자리"]],
  ["frameworks/electron/windowEvents.cjs", ["framework", "창에 사건을 배달하는 한 자리"]],
  ["frameworks/electron/native/capture.cjs", ["framework", "창의 픽셀"]],
  ["frameworks/electron/native/engine.cjs", ["framework", "엔진 서피스가 붙는 자리가 창이다"]],
  ["frameworks/electron/native/error.cjs", ["framework", "프레임워크가 이름을 달고 실패하는 방법"]],
  ["frameworks/electron/native/index.cjs", ["framework", "창·웹뷰·네이티브 표면 명령표"]],
  ["frameworks/electron/native/project.cjs", ["framework", "어느 창이 어느 root 를 점유하는가"]],
  ["frameworks/electron/native/titlebar.cjs", ["framework", "창 크롬"]],
  ["frameworks/electron/native/webview.cjs", ["framework", "창 안에서만 답이 나온다"]],
  ["frameworks/electron/native/window.cjs", ["framework", "창 자체 — cored 에는 창이 없다"]],
  ["frameworks/tauri/build.rs", ["framework", "이 프레임워크의 빌드 스크립트"]],
  ["frameworks/tauri/src/main.rs", ["framework", "이 실행물의 진입점"]],
  ["frameworks/tauri/src/identity.rs", ["framework", "이 프로세스의 앰비언트 정체성 결속(규칙은 코어)"]],
  ["frameworks/tauri/src/login_shell.rs", ["framework", "이 프로세스가 상속한 로그인 셸을 읽는 유일한 자리"]],
  ["frameworks/tauri/src/os_key.rs", ["framework", "OS 키체인 — 플랫폼 표면이라 코어 금지 목록에 걸린다"]],
  ["frameworks/tauri/src/seal_keys.rs", ["framework", "코어 계약의 이 프레임워크 구현(고아 규칙으로 껍질이 필요하다)"]],
  ["frameworks/tauri/src/pty_delivery.rs", ["framework", "코어 규칙의 얇은 결속"]],
  ["frameworks/tauri/src/data/process_probe.rs", ["framework", "이 프로세스의 메모리 형편 — 저장소 규칙이 인자로 받는다"]],
  ["frameworks/tauri/src/cored_ledger.rs", ["framework", "이식 장부 — 표가 둘인 동안만 있다(FRAMEWORK-PORT '남은 중복')"]],

  // ── tenant: 프레임워크 무관인데 여기 산다. 코어로 간다 ──────────────────────
  ["frameworks/tauri/src/ambient_gate.rs", ["tenant", "앰비언트 등재 게이트 — 판정이 순수하다"]],
  ["frameworks/tauri/src/data/backup.rs", ["tenant", "저장소 백업 — 백엔드 일원화에서 코어로"]],
  ["frameworks/tauri/src/data/crypto.rs", ["tenant", "필드 봉인 — soksak-store/doc.rs 의 짝을 확인해야 한다"]],
  ["frameworks/tauri/src/data/mod.rs", ["tenant", "저장소 개방·스키마 — store_open/store_lock 의 짝을 확인해야 한다"]],
]);

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "target" || n === "node_modules" || n === "gen" || n === "dist") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(n)) out.push(p);
  }
  return out;
}

/** 이 파일이 자기 프레임워크를 이름으로 부르는가. */
export function touchesFramework(src, framework) {
  const sigs = CONTACT[framework];
  if (!sigs) return true; // 모르는 프레임워크는 판정하지 않는다(무관으로 오인하지 않는다)
  return sigs.some((r) => r.test(src));
}

export function verify(root = REPO_ROOT, ledger = DECLARED) {
  const base = join(root, "frameworks");
  let frameworks;
  try {
    frameworks = readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory());
  } catch {
    return { scanned: 0, violations: [{ file: "frameworks", why: "스캔할 자리가 없다 — 경로가 바뀌었다" }] };
  }
  // 0의 두 얼굴 — 훑을 프레임워크가 없으면 통과가 아니라 실패다.
  if (frameworks.length === 0) {
    return { scanned: 0, violations: [{ file: "frameworks", why: "프레임워크 폴더가 하나도 없다" }] };
  }

  const violations = [];
  const found = new Set();
  let scanned = 0;

  for (const fw of frameworks) {
    for (const abs of walk(join(base, fw))) {
      const rel = relative(root, abs);
      if (/(^|\/)[^/]*_tests?\.(rs|mjs|ts|tsx)$|\.test\.(mjs|ts|tsx|js)$/.test(rel)) continue;
      scanned++;
      const src = readFileSync(abs, "utf8");
      if (touchesFramework(src, fw)) continue;
      found.add(rel);
      if (!ledger.has(rel)) {
        violations.push({
          file: rel,
          why: `${fw} 를 이름으로 부르지 않는다 — framework(주입받는다)인지 tenant(코어로 간다)인지 등재하라`,
        });
      }
    }
  }
  if (scanned === 0) {
    return { scanned, violations: [{ file: "frameworks", why: "훑은 소스가 0이다 — 확장자 규칙이 낡았다" }] };
  }
  for (const rel of ledger.keys()) {
    if (!found.has(rel)) {
      violations.push({
        file: rel,
        why: "장부에 있는데 더는 세들어 있지 않다 — 옮겼으면 장부에서 지워라(건수가 거짓말이 된다)",
      });
    }
  }
  const tenants = [...ledger].filter(([rel, [lane]]) => lane === "tenant" && found.has(rel));
  return { scanned, violations, declared: found.size, tenants: tenants.map(([r]) => r) };
}

if (basename(process.argv[1] || "") === "framework-free-tenant.mjs") {
  const { scanned, violations, declared, tenants } = verify();
  if (violations.length === 0) {
    console.log(
      `framework-free-tenant: PASS (${scanned}벌 훑음 — 등재 ${declared}건, 그중 코어로 갈 것 ${tenants.length}건)`,
    );
    for (const t of tenants) console.log(`    남은 이관: ${t}`);
  } else {
    console.log(`framework-free-tenant: FAIL (${violations.length})`);
    for (const v of violations) console.log(`  - ${v.file}: ${v.why}`);
    process.exitCode = 1;
  }
}
