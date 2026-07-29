#!/usr/bin/env node
// 배치 어휘 게이트 — `frameworks/` 아래 이름은 **framework 어휘만** 쓴다.
//
// 왜 있나. 폴더 이름은 그 안에 든 것의 **소유자를 선언한다**(docs/REPO-LAYOUT.md). 이름과
// 내용이 어긋나도 오류로 나타나지 않는다 — 사람이 "여기 있으니 이것의 일부겠지"라고 읽고,
// 그 오독 위에 다음 결합이 쌓인다. 이 저장소는 이미 그 값을 치렀다(실측 2026-07-29):
// `crates/` 의 크레이트 10 개와 `crates/soksak-cli` 는 tauri 에 **전혀** 의존하지
// 않는데(모든 Cargo.toml 실측), 그중 `soksak-cored` 는 `tauri`·`wry`·`tao` 를 **이름으로**
// 금지하는 `tests/no_framework.rs` 를 들고 있다. 프레임워크를 이름으로 거절하는 코드가 그
// 프레임워크 이름의 폴더 안에 산다.
//
// 어휘 넷의 뜻은 표준이 고정했다(docs/REPO-LAYOUT.md 의 표):
//   framework = 창·이벤트루프·번들을 주는 것(Tauri·Electron) / platform = 운영체제 /
//   engine = 웹뷰 엔진 / shell = 사용자 셸.
// 그러니 tauri·electron 이 사는 자리의 이름은 `frameworks` 다. `platform` 이 아니다.
//
// **어휘를 여기에 베끼지 않는다.** 낱말과 그 예는 표준 문서에서 실측해 읽는다 — 사본을 두면
// 표준과 게이트가 갈리고, 갈린 순간부터 게이트는 표준이 아닌 제 사본을 지킨다. 프레임워크가
// 셋이 되면 먼저 표준 표에 예로 올려라. 그러면 이 게이트가 따라온다.
//
// 규칙 넷:
//   R1 `frameworks/` 가 있다. 법의 주어가 없으면 이 게이트는 아무것도 안 지키면서 통과한다 —
//      빈 통과는 지킨 것이 아니라 못 잰 것이다. 그래서 부재 자체를 위반으로 낸다.
//   R2 `frameworks/` 의 **깊이 1** 이름은 표준 표의 framework 예다. platform·engine·shell
//      축의 말이면 어느 축인지 짚어 거절하고, 표에 없는 이름이면 "표준에 올리고 들어와라".
//   R3 framework 이름을 단 자리는 `frameworks/` **밖에 없다**. 이게 없으면 법은 우회된다 —
//      `frameworks/` 밖에 두면 그만이기 때문이다. 오늘 `frameworks/electron/` 과 `frameworks/tauri/` 가 정확히
//      그 자리에 있다.
//   R4 `frameworks/<A>/` 안에 **다른 프레임워크 이름의 자리**가 없다. 한 폴더의 소유자는 하나다.
//
// **왜 깊이 1 만 재나.** `frameworks/tauri/src/macos.rs` 는 정당하다 — 그 폴더의 소유자는
// Tauri 이고 macOS 부분은 그 어댑터의 일이다(실측: browser 엔진 사이드카는 per-OS presenter 로
// 갈린다). 같은 이유로 `scripts/electron/` 도 위반이 아니다 — 소유자는 scripts 이고 electron 은
// 그 스크립트가 무엇을 다루는지다. 어긋남이 생기는 자리는 **프레임워크 슬롯**, 곧 frameworks/
// 의 자식뿐이다. 거기서만 이름이 "이것은 프레임워크다"라고 선언한다.
//
// 한계를 정직하게: 이름은 구분자로 쪼개 대조한다(`frameworks/tauri` → src·tauri). 붙여 쓴 이름
// (`tauriBridge`)은 잡지 못한다. 오인의 대가가 "고쳐라"가 되지 않게 대조를 넓히지 않았다 —
// 넓히면 `windowSize` 가 platform 의 `windows` 로 잡힌다.
//
// 실행: node scripts/gates/framework-folder-vocabulary.mjs [--root <경로>] [--json]

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/** 어휘의 단일 진실 — 이 문서의 표가 낱말과 예를 정한다. */
export const STANDARD = join(REPO_ROOT, "docs", "REPO-LAYOUT.md");
export const AXES = ["framework", "platform", "engine", "shell"];
export const FRAMEWORKS_DIR = "frameworks";

/**
 * 표준 표에 예로 적히지 않은 동의어 — 축을 **짚어 주기 위해서만** 쓴다.
 *
 * 없어도 판정은 같다(표에 없는 이름은 어차피 "선언하고 들어와라"로 막힌다). 있는 이유는
 * 메시지다: "모르는 이름"과 "그건 운영체제 이름이다"는 다음 사람이 할 일이 다르다.
 * 한 줄씩 왜 그 축인지 적는다.
 */
export const SYNONYMS = new Map([
  ["darwin", ["platform", "macOS 커널 이름 — 운영체제 축"]],
  ["osx", ["platform", "macOS 옛 표기"]],
  ["mac", ["platform", "macOS 줄임"]],
  ["win", ["platform", "Windows 줄임"]],
  ["win32", ["platform", "Windows API 축약 — 운영체제"]],
  ["win64", ["platform", "같은 축"]],
  ["unix", ["platform", "운영체제 계열"]],
  ["posix", ["platform", "운영체제 인터페이스 규격"]],
  ["ios", ["platform", "운영체제"]],
  ["android", ["platform", "운영체제"]],
  ["cocoa", ["platform", "macOS 네이티브 UI 계층 — OS 가 주는 것"]],
  ["appkit", ["platform", "같은 축(macOS 창·메뉴 API)"]],
  ["gtk", ["platform", "Linux 데스크톱 UI 툴킷 — OS 쪽 표면"]],
  ["x11", ["platform", "Linux 디스플레이 서버"]],
  ["wayland", ["platform", "Linux 디스플레이 서버"]],
  ["webkit", ["engine", "웹뷰 엔진"]],
  ["webview", ["engine", "웹을 그리는 것 그 자체 — 엔진 축"]],
  ["webview2", ["engine", "Windows 의 웹뷰 엔진"]],
  ["blink", ["engine", "Chromium 의 렌더 엔진"]],
  ["gecko", ["engine", "Firefox 의 렌더 엔진"]],
  ["cef", ["engine", "Chromium Embedded Framework — 이름에 framework 가 있어도 웹뷰 엔진이다"]],
  ["servo", ["engine", "렌더 엔진"]],
  ["sh", ["shell", "명령 해석기"]],
  ["fish", ["shell", "명령 해석기"]],
  ["powershell", ["shell", "Windows 명령 해석기"]],
  ["pwsh", ["shell", "같은 해석기의 실행 파일명"]],
  ["cmd", ["shell", "Windows 명령 해석기"]],
]);

/** 표준 문서의 표에서 축별 예를 읽는다. 못 읽으면 던진다 — 못 읽는 게이트는 통과하면 안 된다. */
export function readVocabulary(docPath = STANDARD) {
  const body = readFileSync(docPath, "utf8");
  const vocab = new Map();
  // 표 한 줄: `| framework | 뜻 | Tauri · Electron |` — 세 번째 칸만 예로 읽는다.
  for (const m of body.matchAll(/^\|\s*(framework|platform|engine|shell)\s*\|([^|]*)\|([^|]*)\|/gm)) {
    const words = m[3]
      .split(/[·,]/)
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(Boolean);
    if (words.length) vocab.set(m[1], new Set(words));
  }
  for (const axis of AXES) {
    if (!vocab.get(axis)?.size) {
      throw new Error(
        `${docPath}: '${axis}' 행의 예를 못 읽었다 — 표준 표를 못 읽는 게이트는 ` +
          "아무것도 안 지키면서 통과한다",
      );
    }
  }
  return vocab;
}

/** 이름을 구분자로 쪼갠다 — `frameworks/tauri` → [src, tauri], `tauri.conf.json` → [tauri, conf, json]. */
export function tokensOf(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 이 이름이 framework 아닌 축의 말인가. 맞으면 어느 축인지·왜인지 함께 낸다. */
export function forbiddenHit(name, vocab) {
  for (const token of tokensOf(name)) {
    // 축 이름 그 자체(platform·engine·shell, 복수형 포함)도 framework 어휘가 아니다.
    const bare = token.replace(/s$/, "");
    if (AXES.includes(bare) && bare !== "framework") {
      return { word: token, axis: bare, why: "축 이름 그 자체 — 프레임워크의 말이 아니다" };
    }
    for (const axis of AXES) {
      if (axis === "framework") continue;
      if (vocab.get(axis).has(token)) {
        return { word: token, axis, why: `표준 표의 ${axis} 예` };
      }
    }
    const syn = SYNONYMS.get(token);
    if (syn) return { word: token, axis: syn[0], why: syn[1] };
  }
  return null;
}

/** 저장소가 실제로 들고 있는 경로 — 추적본 + 무시되지 않은 미추적본. 배치 이동은 커밋 전에도 보인다. */
function listPaths(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rels = out.split("\n").filter(Boolean);
    if (rels.length) return rels;
  } catch {
    /* git 밖(테스트 픽스처) — 같은 규칙으로 훑는다 */
  }
  return walk(root, "");
}

function walk(root, prefix) {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 배치 실측 — 판정 전에 사실만 모은다.
 *
 * 파일 목록에서 세운다: 경로의 첫 조각이 최상위 이름이고, `frameworks/` 로 시작하는 경로의
 * 두 번째 조각이 프레임워크 슬롯이다. 조각이 더 있으면 그 슬롯은 디렉터리다.
 */
export function survey(root = REPO_ROOT) {
  const paths = listPaths(root);
  const topLevel = new Map(); // 이름 → isDir
  const slots = new Map(); // frameworks/ 의 깊이 1 이름 → isDir
  const nested = new Map(); // 슬롯 이름 → 그 아래 상대경로 집합

  for (const rel of paths) {
    const seg = rel.split("/").filter(Boolean);
    if (!seg.length) continue;
    const isTopDir = seg.length > 1;
    topLevel.set(seg[0], (topLevel.get(seg[0]) ?? false) || isTopDir);
    if (seg[0] !== FRAMEWORKS_DIR || seg.length < 2) continue;
    const slot = seg[1];
    slots.set(slot, (slots.get(slot) ?? false) || seg.length > 2);
    if (seg.length > 2) {
      if (!nested.has(slot)) nested.set(slot, new Set());
      // 조각마다 누적 경로를 담는다 — 위반은 가장 얕은 자리 하나로만 낸다.
      let acc = "";
      for (const part of seg.slice(2)) {
        acc = acc ? `${acc}/${part}` : part;
        nested.get(slot).add(acc);
      }
    }
  }

  return {
    paths,
    hasFrameworks: topLevel.has(FRAMEWORKS_DIR),
    topLevel: [...topLevel].map(([name, isDir]) => ({ name, isDir })).sort((a, b) => a.name.localeCompare(b.name)),
    slots: [...slots].map(([name, isDir]) => ({ name, isDir })).sort((a, b) => a.name.localeCompare(b.name)),
    nested,
  };
}

export function scanRoot(root = REPO_ROOT, vocab = readVocabulary()) {
  const { hasFrameworks, topLevel, slots, nested } = survey(root);
  const frameworks = vocab.get("framework");
  const violations = [];

  // ── R1 — 법의 주어 ───────────────────────────────────────────────────────
  if (!hasFrameworks) {
    const stray = topLevel
      .filter((t) => tokensOf(t.name).some((x) => frameworks.has(x)))
      .map((t) => `${t.name}${t.isDir ? "/" : ""}`);
    violations.push(
      `${FRAMEWORKS_DIR}/ 가 없다 — 어댑터가 최상위에 흩어져 있다` +
        (stray.length ? `(실측: ${stray.join(" · ")})` : "") +
        `. 표준(docs/REPO-LAYOUT.md)의 자리로 옮겨라 — 주어가 없으면 이 게이트는 아무것도 안 지키면서 통과한다`,
    );
  }

  // ── R2 — 슬롯 이름은 framework 어휘 ──────────────────────────────────────
  for (const slot of slots) {
    // 파일은 확장자를 떼고 본다(`frameworks/chromium.ts` 도 이름이다).
    const base = slot.isDir ? slot.name : slot.name.replace(/\.[^.]+$/, "");
    const hit = forbiddenHit(base, vocab);
    if (hit) {
      violations.push(
        `${FRAMEWORKS_DIR}/${slot.name}: \`${hit.word}\` 는 ${hit.axis} 축의 말이다(${hit.why}) — ` +
          `${FRAMEWORKS_DIR}/ 아래는 framework 어휘만 쓴다`,
      );
      continue;
    }
    if (tokensOf(base).some((t) => frameworks.has(t))) continue;
    // 파일은 어느 프레임워크의 것도 아닐 수 있다(README) — 디렉터리만 선언을 요구한다.
    if (!slot.isDir) continue;
    violations.push(
      `${FRAMEWORKS_DIR}/${slot.name}/: 표준 표에 없는 이름 — 프레임워크면 ` +
        `docs/REPO-LAYOUT.md 의 표에 예로 올리고 들어와라(어휘의 단일 진실은 그 표다)`,
    );
  }

  // ── R3 — framework 이름은 frameworks/ 밖에 없다 ──────────────────────────
  for (const top of topLevel) {
    if (top.name === FRAMEWORKS_DIR) continue;
    const base = top.isDir ? top.name : top.name.replace(/\.[^.]+$/, "");
    const word = tokensOf(base).find((t) => frameworks.has(t));
    if (!word) continue;
    violations.push(
      `${top.name}${top.isDir ? "/" : ""}: 프레임워크 이름 \`${word}\` 이 최상위에 있다 — ` +
        `${FRAMEWORKS_DIR}/${word}/ 로 가야 "frameworks/ 아래" 라는 법이 미친다`,
    );
  }

  // ── R4 — 한 슬롯의 소유자는 하나 ─────────────────────────────────────────
  for (const [slot, rels] of nested) {
    const own = new Set(tokensOf(slot));
    const flagged = [];
    for (const rel of [...rels].sort()) {
      if (flagged.some((f) => rel === f || rel.startsWith(`${f}/`))) continue; // 가장 얕은 자리만
      const last = rel.split("/").pop();
      const word = tokensOf(last).find((t) => frameworks.has(t) && !own.has(t));
      if (!word) continue;
      flagged.push(rel);
      violations.push(
        `${FRAMEWORKS_DIR}/${slot}/${rel}: \`${word}\` 는 다른 프레임워크다 — 한 폴더의 소유자는 하나다`,
      );
    }
  }

  return violations;
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--root");
  const root = at >= 0 ? resolve(argv[at + 1]) : REPO_ROOT;
  const vocab = readVocabulary();
  const { hasFrameworks, slots, topLevel } = survey(root);
  const violations = scanRoot(root, vocab);

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          vocabulary: Object.fromEntries([...vocab].map(([k, v]) => [k, [...v]])),
          hasFrameworks,
          slots: slots.map((s) => s.name),
          violations,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("배치 어휘 — frameworks/ 아래 이름은 framework 어휘만 쓴다");
    console.log(
      `  표준 어휘(docs/REPO-LAYOUT.md): ` +
        AXES.map((a) => `${a} ${[...vocab.get(a)].join("/")}`).join(" · "),
    );
    console.log(`  frameworks/ 자식: ${slots.length ? slots.map((s) => s.name).join(" · ") : "(없음)"}`);
    const stray = topLevel
      .filter((t) => t.name !== FRAMEWORKS_DIR && tokensOf(t.name).some((x) => vocab.get("framework").has(x)))
      .map((t) => t.name);
    console.log(`  최상위 프레임워크 이름: ${stray.length ? stray.join(" · ") : "(없음)"}`);
    for (const v of violations) console.error(`  ✗ ${v}`);
  }

  if (violations.length) {
    console.error(`framework-folder-vocabulary: FAIL (${violations.length})`);
    process.exit(1);
  }
  console.log("framework-folder-vocabulary: PASS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
