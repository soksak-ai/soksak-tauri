// 저장소를 바꾸는 명령은 그 사실을 알린다 — 알림의 주인은 저장소의 주인과 같다(A22).
//
// 실측(2026-08-01): 저장소 소유는 cored 로 옮겼는데 알림은 프레임워크가 자기 창에만 뿌리고
// 있었다. 그러면 같은 홈을 보는 다른 프레임워크는 자기가 든 옛 값을 진실로 알고, 다음 저장에서
// 상대의 변경을 **덮는다** — 그 손실은 오류로 보이지 않는다.
//
// 새 쓰기 명령이 알림을 빠뜨리는 것도 같은 모양으로 조용하다. 그래서 손목록이 아니라 표식으로
// 센다: `deny_without_write_ownership` 를 부르는 함수가 곧 쓰기 명령이고, 그것이 이 게이트의
// 대상 집합이다. 트리에서 발견하므로 새 명령이 저절로 걸린다.
//
// 알리지 않는 쓰기가 있을 수 있다 — 그 사유는 여기 표에 이름으로 적는다. 표에 없으면 실패다.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = join(ROOT, "crates/soksak-cored/src/registry_store.rs");

/** 알리지 않아도 되는 쓰기 — 사유는 이름 옆에 적는다. */
const SILENT = new Map([
  ["run_data_canary", "카나리아는 진단용 자기 쓰기다 — 사용자 데이터가 아니다"],
  [
    "run_data_encrypt_convert",
    "암호화 전환은 값이 아니라 저장 형식을 바꾼다 — 읽는 쪽이 보는 값은 그대로다",
  ],
]);

if (!existsSync(FILE)) {
  console.error(`data-change-notify: 대상 파일이 없다 — ${FILE}`);
  process.exit(1);
}

const src = readFileSync(FILE, "utf8");

/** 함수 블록들 — 경계는 **다음 함수**다(이름이 무엇이든).
 *
 *  `run_` 만으로 자르면 사이에 낀 헬퍼가 앞 블록에 붙고, 마지막 블록은 파일 끝까지 삼킨다.
 *  그러면 옆 함수의 호출이 자기 것으로 세어져 빠뜨림이 통과로 보인다 — 위반을 심어 확인했다. */
function functions() {
  const bounds = [...src.matchAll(/(?:pub(?:\(crate\))? )?fn ([a-z_][a-z0-9_]*)\(/g)];
  return bounds
    .map((m, i) => ({
      name: m[1],
      body: src.slice(m.index ?? 0, i + 1 < bounds.length ? bounds[i + 1].index : src.length),
    }))
    .filter((f) => f.name.startsWith("run_"));
}

const all = functions();
if (all.length === 0) {
  console.error("data-change-notify: run_ 함수를 하나도 못 읽었다 — 파싱이 비면 위반이 0 으로 보인다");
  process.exit(1);
}

const writes = all.filter((f) => f.body.includes("deny_without_write_ownership(ctx)"));
if (writes.length === 0) {
  console.error("data-change-notify: 쓰기 명령을 하나도 못 찾았다 — 표식이 바뀌었는지 확인하라");
  process.exit(1);
}

const missing = writes.filter(
  (f) => !f.body.includes("with_write(") && !f.body.includes(".announce()") && !SILENT.has(f.name),
);
const staleSilent = [...SILENT.keys()].filter((n) => !writes.some((f) => f.name === n));

for (const f of missing) {
  console.error(
    `data-change-notify: ${f.name} 이 저장소를 바꾸면서 알리지 않는다 — ` +
      `ctx.with_write 로 지나가거나(Changed 를 값으로 내놓는다), 안 알리는 사유를 SILENT 표에 적어라`,
  );
}
for (const n of staleSilent) {
  console.error(`data-change-notify: SILENT 표의 ${n} 은 더는 쓰기 명령이 아니다 — 표에서 지워라`);
}

if (missing.length > 0 || staleSilent.length > 0) process.exit(1);
console.log(
  `data-change-notify: OK — 쓰기 명령 ${writes.length}개 중 ${writes.length - SILENT.size}개가 알리고 ${SILENT.size}개는 사유가 적혀 있다(강제는 Changed 의 must_use, 이 게이트는 그 문을 안 지나는 쓰기를 센다)`,
);
