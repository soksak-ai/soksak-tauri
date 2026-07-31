// 같은 이름은 같은 것을 답한다 — 위임된 명령의 반환 모양을 대조한다.
//
// 저장소를 위임한 프로세스는 주인의 답을 자기 커맨드의 타입으로 역직렬화한다. 두 쪽이 같은
// 이름을 서빙하면서 모양이 다르면 그 자리는 **위임이 일어나는 순간에만** 깨진다 — 위임 전에는
// 두 모양이 만날 일이 없어 조용하다.
//
// 실측(2026-08-01): 앱이 저장소를 놓자마자 data.kv.delete 가 "주인의 답이 이 명령의 모양이
// 아니다: invalid type: null, expected a boolean" 으로 실패했다. cored 는 삭제 성공을 버리고
// null 을 답했고, 앱은 bool 을 기다렸다.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

const table = readFileSync(ROOT + "crates/soksak-cored/src/registry_table.rs", "utf8");
const cored = new Map();
for (const m of table.matchAll(/name:\s*"([\w.]+)",([\s\S]*?)returns:\s*"([^"]*)"/g)) {
  cored.set(m[1], m[3]);
}
if (cored.size === 0) {
  console.error("delegated-shape-scan: cored 표를 읽지 못했다 — 판정 불가");
  process.exit(1);
}

const files = execSync("git ls-files 'frameworks/tauri/src/**/*.rs'", { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);
const app = new Map();
for (const f of files) {
  const s = readFileSync(ROOT + f, "utf8");
  for (const m of s.matchAll(/#\[tauri::command\][^\n]*\n(?:[^\n]*\n)?pub (?:async )?fn (\w+)\([^)]*\)\s*->\s*([^{]+)\{/g)) {
    app.set(m[1], m[2].trim());
  }
}

// 값을 돌려주는 앱 커맨드가 주인 쪽에서 null 이면 역직렬화가 깨진다.
const bad = [];
let checked = 0;
for (const [name, cshape] of cored) {
  const ashape = app.get(name);
  if (!ashape) continue;
  checked += 1;
  const coredNull = /^\s*(null|\(\))?\s*$/.test(cshape);
  const appValue = !/Result<\(\)/.test(ashape) && !/->\s*\(\)/.test(ashape) && !/Result<\s*\(\)\s*,/.test(ashape);
  if (coredNull && appValue) bad.push(`${name}: 주인 "${cshape}" ↔ 앱 "${ashape}"`);
}

if (checked === 0) {
  console.error("delegated-shape-scan: 두 쪽 다 있는 이름을 하나도 못 찾았다 — 판정 불가");
  process.exit(1);
}
if (bad.length > 0) {
  console.error(`delegated-shape-scan: 위임 시 모양이 갈리는 이름 ${bad.length}건.`);
  console.error("  같은 이름은 같은 것을 답해야 한다 — 위임된 프로세스가 주인의 답을 자기 타입으로 읽는다.");
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`delegated-shape-scan: OK (양쪽 공통 ${checked}개)`);
