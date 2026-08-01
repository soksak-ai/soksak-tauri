// 검증이 겨누는 주소에 **프레임워크 이름이 없다.**
//
// 하니스가 한 프레임워크의 앱 소켓을 겨누면 그 프레임워크만 검증된다. 나머지는 "안 돌린 것"이
// 아니라 **돌린 줄 아는 것**이 되고, 그 착시는 그 프레임워크에서만 죽는 결함을 그대로 살려 둔다.
//
// 실측(2026-08-01): 스위트의 기본 주소가 `com.soksak.<id>.sock`(그 앱의 소켓)이라 Electron 은
// 매번 검증에서 빠졌다. 그동안 Electron 에서만 죽는 결함 둘이 살아 있었다 —
//   ① 명령 다리가 이름 접두사로 `window_manifest_upsert` 를 가로채 **워크스페이스 저장이 통째로
//      실패**했고(Tauri 는 멀쩡), ② 제어면이 끊긴 뒤 다시 안 붙어 cored 를 갈아 끼우면 밖에서
//      부를 수 없는 창이 됐다.
//
// 중립 주소는 **cored 소켓**이다: cored 는 그 창을 든 쪽으로 배달하므로 어느 프레임워크가 떠
// 있든 같은 명령이 닿는다. 그것이 "두 프레임워크는 동급"을 검증에서도 참으로 만드는 유일한 방법이다.
//
// 예외는 없다. 한 프레임워크만 겨눠야 하는 검사가 생기면 그것은 그 프레임워크의 테스트이지
// 공용 스위트가 아니다 — `frameworks/<name>/` 아래로 간다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** 검증이 주소를 고르는 자리. 여기 프레임워크 이름이 박히면 그 순간 한쪽만 검증된다. */
const DIRS = ["scripts/e2e", "scripts/gates"];
const FILES = ["Makefile"];

/** 프레임워크 이름. 어휘4 의 그 축이다(framework/platform/engine/shell). */
const FRAMEWORKS = ["tauri", "electron"];

/** 소켓 주소를 짓는 모양 — 확장자로 잡는다(변수명은 자리마다 다르다). */
const ADDRESS = /(SOKSAK_SOCKET|socketPath|\.sock)/;

function walk(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "build" || name.startsWith(".")) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(join(dir, name)));
    else out.push(p);
  }
  return out;
}

const files = [...DIRS.flatMap(walk), ...FILES.map((f) => join(ROOT, f))];
if (files.length === 0) {
  console.error("harness-address: 대상 파일을 하나도 못 찾았다 — 빈 스캔은 통과가 아니다");
  process.exit(1);
}

let bad = 0;
let scanned = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  // 이 게이트 자신은 규칙을 설명하느라 그 이름들을 적는다.
  if (rel.endsWith("harness-address-scan.mjs")) continue;
  scanned += 1;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const code = line.replace(/#.*$/, "").replace(/\/\/.*$/, "");
      if (!ADDRESS.test(code)) return;
      const hit = FRAMEWORKS.find((f) => code.includes(f));
      if (!hit) return;
      bad += 1;
      console.error(
        `harness-address: ${rel}:${i + 1} 이 주소에 프레임워크 이름을 박았다(${hit}) — ` +
          `\`${code.trim().slice(0, 80)}\`. cored 소켓을 겨눠라: 한 앱의 소켓을 겨누면 나머지는 ` +
          `"안 돌린 것"이 아니라 "돌린 줄 아는 것"이 된다`,
      );
    });
}

if (bad > 0) process.exit(1);
console.log(`harness-address: OK — 검증 소스 ${scanned}개 · 프레임워크 박힌 주소 0`);
