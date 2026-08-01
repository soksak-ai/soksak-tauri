// 산출물 자리를 손으로 적지 마라 — cargo 에게 물어라.
//
// cargo 워크스페이스의 뿌리가 `frameworks/tauri` 에서 저장소 뿌리로 옮겨간 뒤에도
// `frameworks/tauri/target` 은 남아 있다. 옛 자리를 가리키는 명령은 실패하지 않는다 —
// **옛 산출물이 거기 있으므로 조용히 그것이 잡힌다.**
//
// 실측(2026-08-01): `frameworks/tauri/target/debug/sok-dev`(7/28 빌드)로 검증해서, 그날 이미
// 고친 정체성 결함이 아직 살아 있다는 답을 받았다. 오류는 없었다. 답만 틀렸다.
//
// 그래서 tracked 파일에 이 자리를 적는 것을 금지한다. 자리는 `cargo metadata` 가 답한다
// (Makefile 의 `CARGO_TARGET`).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

/** 손으로 적힌 옛 산출물 자리. 이 문자열이 tracked 파일에 있으면 그 명령은 옛 것을 잡는다. */
const STALE = "frameworks/tauri/target";

/** 이 파일은 그 자리를 **설명**한다 — 금지의 사유가 사는 곳이라 세지 않는다. */
const EXPLAINS = new Set(["scripts/gates/build-output-path.mjs"]);

/** `plans/` 는 **그때 무엇이 사실이었는지의 기록**이다. 지금 기준으로 고쳐 쓰면 기록이 아니다. */
const LEDGER = "plans/";

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const hits = [];
for (const f of tracked) {
  if (EXPLAINS.has(f) || f.startsWith(LEDGER)) continue;
  let src;
  try {
    src = readFileSync(ROOT + f, "utf8");
  } catch {
    continue; // 바이너리·심링크 없음 — 읽히는 것만 센다
  }
  if (!src.includes(STALE)) continue;
  src.split("\n").forEach((line, i) => {
    if (!line.includes(STALE)) return;
    // 그 자리를 **지우는 명령**은 이름을 알아야 한다. 단 한 줄 — 선언 하나만 허용한다.
    if (f === "Makefile" && /^ORPHAN_TARGET\s*:=/.test(line)) return;
    // 주석에서 사유로 인용하는 것은 허용한다 — 다만 사유가 있어야 한다.
    const isProse = /^\s*(#|\/\/|\*)/.test(line);
    if (isProse) return;
    hits.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}

if (hits.length > 0) {
  console.error(`build-output-path: 옛 산출물 자리를 손으로 적은 곳 ${hits.length}건.`);
  console.error("  cargo 뿌리가 옮겨간 뒤에도 그 자리는 남아 있다 — 옛 산출물이 조용히 잡힌다.");
  console.error("  Makefile 은 `$(CARGO_TARGET)` 을 쓴다(cargo metadata 가 답한다).");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}

// 자리를 묻는 길이 살아 있는지도 확인한다 — 금지만 하고 대안이 죽어 있으면 규칙이 아니라 벽이다.
const mk = readFileSync(ROOT + "Makefile", "utf8");
const decl = mk.match(/^CARGO_TARGET\s*:=\s*(.+)$/m);
if (!decl) {
  console.error("build-output-path: Makefile 에 CARGO_TARGET 선언이 없다 — 물어볼 길이 사라졌다");
  process.exit(1);
}
if (!decl[1].includes("cargo metadata")) {
  console.error(`build-output-path: CARGO_TARGET 이 cargo 에게 묻지 않는다 — ${decl[1].trim()}`);
  process.exit(1);
}

// 같은 자리를 두 철자로 부른다: Makefile 은 cargo 에게 묻고, 스크립트는 `$REPO/target` 을 쓴다.
// **두 철자가 같은 자리를 가리키는 근거**를 여기서 잰다 — cargo 를 부르지 않는다(게이트가 툴체인을
// 요구하면, 툴체인 없는 자리에서 이 규칙만 조용히 안 돌게 된다). 근거는 하나다: 워크스페이스
// 뿌리가 저장소 뿌리다. 뿌리가 다시 옮겨가면 이 검사가 먼저 깨진다.
const rootManifest = readFileSync(ROOT + "Cargo.toml", "utf8");
if (!/^\[workspace\]/m.test(rootManifest)) {
  console.error("build-output-path: 저장소 뿌리가 워크스페이스 뿌리가 아니다 — $REPO/target 의 근거가 사라졌다");
  process.exit(1);
}
const fwManifest = readFileSync(ROOT + "frameworks/tauri/Cargo.toml", "utf8");
if (/^\[workspace\]/m.test(fwManifest)) {
  console.error("build-output-path: 프레임워크가 다시 워크스페이스 뿌리다 — 산출물이 두 자리로 갈린다");
  process.exit(1);
}
console.log("build-output-path: OK — 손으로 적은 옛 자리 0 · 뿌리는 저장소 뿌리($REPO/target)");
