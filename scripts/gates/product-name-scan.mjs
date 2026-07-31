// 제품 이름은 정체성에서 나온다 — 빌드 설정이 그 규칙 밖에서 자기 값을 적으면 안 된다.
//
// 이름 규칙의 정본은 `crates/soksak-core/fixtures/identity.json` 이고, Rust 구현과 JS 쌍둥이가
// 그 픽스처에 묶여 있다. 그런데 **소비처**는 묶여 있지 않았다: 프레임워크 빌드 설정이
// productName 을 손으로 적고 있었고 아무도 대조하지 않았다(실측 2026-07-31).
//
// 규칙과 소비처가 갈리면 조용하다. 갈린 뒤에 보이는 것은 "앱 이름이 왜 이래?" 하나뿐이고,
// 그때 어느 쪽이 맞는지는 아무도 모른다. 대조 자리를 여기 둔다.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname;

const fixture = JSON.parse(
  readFileSync(ROOT + "crates/soksak-core/fixtures/identity.json", "utf8"),
);
const cases = Array.isArray(fixture) ? fixture : (fixture.cases ?? []);
const expected = new Map(
  cases.filter((c) => c.productName).map((c) => [c.identifier, c.productName]),
);

// 오라클 생존 — 픽스처를 못 읽으면 0 은 "깨끗함"이 아니라 "못 쟀음"이다.
if (expected.size === 0) {
  console.error("product-name-scan: 픽스처에서 productName 을 하나도 읽지 못했다 — 판정 불가");
  process.exit(1);
}

// 빌드 설정이 스스로 적은 (정체성, 제품이름) 짝. 여기 없는 설정 파일이 생기면 그 파일은
// 대조 밖이므로, 새 프레임워크 설정을 더할 때 이 목록도 함께 는다.
const CONFIGS = [
  "frameworks/tauri/tauri.conf.json",
  "frameworks/tauri/tauri.debug.conf.json",
  "frameworks/tauri/tauri.release.conf.json",
];

const bad = [];
let checked = 0;

for (const rel of CONFIGS) {
  let conf;
  try {
    conf = JSON.parse(readFileSync(ROOT + rel, "utf8"));
  } catch {
    bad.push(`${rel}: 읽지 못했다`);
    continue;
  }
  const identifier = conf.identifier ?? conf.bundle?.identifier;
  if (!identifier) {
    bad.push(`${rel}: identifier 가 없다 — 무엇의 이름인지 말하지 않는다`);
    continue;
  }
  const want = expected.get(identifier);
  if (!want) {
    bad.push(`${rel}: ${identifier} 가 픽스처에 없다 — 규칙 밖의 정체성이다`);
    continue;
  }
  checked += 1;
  if (conf.productName !== want) {
    bad.push(
      `${rel}: productName "${conf.productName}" ≠ 규칙 "${want}"(${identifier})`,
    );
  }
}

// JS 쌍둥이도 같은 답을 내는지 — 빌드 스크립트(bundle.sh)가 이쪽에 물어본다.
for (const [identifier, want] of expected) {
  const got = execSync(
    `node -e "process.stdout.write(require('${ROOT}frameworks/electron/cored.cjs').productName(process.argv[1]))" ${identifier}`,
    { cwd: ROOT, encoding: "utf8" },
  );
  checked += 1;
  if (got !== want) {
    bad.push(`cored.cjs productName(${identifier}) = "${got}" ≠ 규칙 "${want}"`);
  }
}

if (bad.length > 0) {
  console.error("product-name-scan: 제품 이름이 규칙과 어긋난다.");
  console.error("  규칙 정본 = crates/soksak-core/fixtures/identity.json");
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}

console.log(`product-name-scan: OK (규칙 ${expected.size}건 · 대조 ${checked}건)`);
