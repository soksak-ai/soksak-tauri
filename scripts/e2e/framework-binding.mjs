#!/usr/bin/env node
// e2e 하니스의 프레임워크 결속 장부 — 하니스를 하나도 돌리지 않고 "무엇이 프레임워크에 묶였는가"를 값으로 읽는다.
//
// 세 무리로 가른다:
//   A 프레임워크 무관 — 소켓 명령만 쓴다. 프레임워크가 바뀌어도 같은 답을 요구한다.
//   B 경로 결속       — 프로세스·빌드 산출물·앱 홈을 직접 안다. 환경에서 받으면 A 가 된다.
//   C 네이티브        — 창 캡처·네이티브 자식 표면·합성 입력. 프레임워크마다 답이 다른 것이 정상이다.
//
// 무리는 선언이 아니라 대조다. 소스에서 표면을 실측하고 장부(framework-binding.json)와 양방향으로
// 맞춘다: 소스에 있는데 선언에 없으면 드리프트, 선언에 있는데 소스에 없으면 죽은 선언 — 둘 다
// 실패다. 한쪽만 보면 장부가 사실과 갈라진 채로 통과한다.
//
// 표면 이름은 코드가 찾고(탐지기는 메커니즘), 그 표면이 왜 그 무리인지는 장부가 적는다(이유는
// 사람의 판단). 이유 없는 표면 선언은 통과시키지 않는다 — 빈 이유는 우회로가 된다.
//
// 사용:
//   node scripts/e2e/framework-binding.mjs             표 + 개수
//   node scripts/e2e/framework-binding.mjs --json      기계 판독(분류 전체)
//   node scripts/e2e/framework-binding.mjs --class C   그 무리만
//   node scripts/e2e/framework-binding.mjs --surfaces  프레임워크마다 갈리는 자리(9단계 입력)
//   node scripts/e2e/framework-binding.mjs --check     조용히 대조만(게이트)
// 종료코드: 0=장부와 소스 일치, 1=드리프트·금지 패턴, 2=사용법 오류.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
export const LEDGER_PATH = join(E2E_DIR, "framework-binding.json");
const SCANNED_EXT = /\.(mjs|sh|py)$/;
// 탐지기와 그 짝 테스트는 자기 자신의 대상이 아니다 — 패턴을 문자열로 들고 있어 전부 자기에게 맞는다.
const SELF = new Set(["framework-binding.mjs", "framework-binding.test.mjs"]);

/** 탐지기 — 표면 이름과 그 표면을 소스에서 알아보는 모양.
 *
 *  kind:
 *    native    프레임워크가 스스로 답해야 하는 자리. 답이 프레임워크마다 다른 것이 정상이다.
 *    reducible 지금은 프로세스·경로를 직접 알지만, 값이 밖에서 오면 사라진다.
 *
 *  이름은 장부의 키다 — 여기 없는 이름은 장부에 적을 수 없고, 장부에만 있는 이름은 죽은 선언이다. */
export const SURFACE_PATTERNS = [
  // ── 네이티브: 창 캡처와 그 위에서 도는 픽셀 오라클 ────────────────────────
  { name: "window.snapshot", kind: "native", re: /\bwindow\.snapshot\b/ },
  { name: "window.record", kind: "native", re: /\bwindow\.record\b/ },
  // 디코더를 직접 부르든 판정 함수만 부르든 같은 표면이다 — 진입점 하나만 알면 오라클 위에
  // 선 파일이 "표면 없음"으로 앉는다.
  {
    name: "pixel-oracle",
    kind: "native",
    re: /\bdecodePng\b|\bframeColors\b|\bjudgeFrame\b|\bcompareFrames\b|\bobserveFrameSequence\b|\bobserveFullCapture\b|\bsnapshotScaleForVisualEvidence\b|\bPIL\b|\bImage\.open\b/,
    jsIdentifiers: [
      "decodePng",
      "frameColors",
      "judgeFrame",
      "compareFrames",
      "observeFrameSequence",
      "observeFullCapture",
      "snapshotScaleForVisualEvidence",
    ],
  },
  // ── 네이티브: 네이티브 자식 표면(홀·스위즐·레이어) ────────────────────────
  { name: "window.layers", kind: "native", re: /\bwindow\.layers\b/ },
  { name: "webview.surfaces", kind: "native", re: /\bwebview\.surfaces\b/ },
  { name: "webview.emitNative", kind: "native", re: /\bwebview\.emitNative\b/ },
  { name: "webview.health.query", kind: "native", re: /\bwebview\.health\.query\b/ },
  { name: "webview.recover", kind: "native", re: /\bwebview\.recover\b/ },
  // 산문에 적힌 엔진 이름은 결속이 아니다 — 프로세스를 실제로 지목하는 모양만 잡는다.
  { name: "webview-runtime", kind: "native", re: /WebKit\.WebContent|com\.apple\.WebKit/ },
  // ── 네이티브: 화면 밖에서 앱을 치는 손 ────────────────────────────────────
  { name: "synthetic-input", kind: "native", re: /synth-input|CGEvent|\bswiftc\b/ },
  { name: "screen-record", kind: "native", re: /\bscreencapture\b/ },
  { name: "frame-decode", kind: "native", re: /\bffmpeg\b/ },
  {
    name: "tauri-appkit-surface-policy",
    kind: "native",
    re: /\btauriSurfaceResizePolicyVerdict\b|\bAPPKIT_(?:EXPLICIT_BOUNDS|PARENT_WIDTH_HEIGHT)_MASK\b/,
    jsIdentifiers: [
      "tauriSurfaceResizePolicyVerdict",
      "APPKIT_EXPLICIT_BOUNDS_MASK",
      "APPKIT_PARENT_WIDTH_HEIGHT_MASK",
    ],
  },
  // ── 줄일 수 있는 결속: 프로세스·빌드 산출물·앱 홈을 직접 안다 ─────────────
  { name: "socket-name", kind: "reducible", re: /com\.soksak\.[A-Za-z$${}_]+\.sock/ },
  { name: "app-home-path", kind: "reducible", re: /homedir\(\),\s*"\.soksak(?!-e2e)|\$HOME\/\.soksak(?!-e2e)/ },
  { name: "build-artifact-path", kind: "reducible", re: /frameworks\/tauri\/target|target\/(debug|release)\/|\$TARGET\// },
  { name: "app-bundle-launch", kind: "reducible", re: /bundle\/macos|\.app\/Contents\/MacOS/ },
  { name: "app-process-scan", kind: "reducible", re: /\bpgrep\b/ },
  { name: "app-activate", kind: "reducible", re: /\bosascript\b/ },
];

/** 어떤 파일에도 있어서는 안 되는 모양. 무리와 무관하게 즉시 실패한다 — 분류 대상이 아니라
 *  영구 금지라, 표면 목록이 아니라 여기 산다.
 *  환경변수 뒤에 기본 경로를 세우면, 값을 안 준 실행이 실패 대신 **다른 홈의 앱**에 붙는다. */
export const BANNED_PATTERNS = [
  {
    name: "socket-default",
    re: /SOKSAK_SOCKET\s*\|\||\$\{SOKSAK_SOCKET:-/,
    why: "소켓 경로에 기본값을 세운다 — 값이 없으면 남의 홈에 붙는 대신 이름을 달고 실패해야 한다",
  },
];

const CLASS_ORDER = ["A", "B", "C"];
const CLASS_TITLE = {
  A: "프레임워크 무관 — 소켓 명령만 쓴다",
  B: "경로 결속 — 프로세스·산출물·홈을 직접 안다",
  C: "네이티브 — 프레임워크마다 답이 다른 것이 정상이다",
};

/** 표면 목록에서 무리를 정한다. 네이티브가 하나라도 있으면 C, 아니면 줄일 결속이 있으면 B. */
export function classify(surfaces) {
  const kinds = new Set(surfaces.map((s) => s.kind));
  if (kinds.has("native")) return "C";
  if (kinds.has("reducible")) return "B";
  return "A";
}

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (SCANNED_EXT.test(name) && !SELF.has(name)) out.push(full);
  }
  return out;
}

/** JavaScript에서 실제 코드 토큰인 identifier의 첫 줄만 읽는다.
 * 문자열·정규식·주석에 API 이름을 적은 계약 테스트는 그 API를 호출한 것이 아니다. */
function javascriptIdentifierLines(source) {
  const parsed = ts.createSourceFile(
    "framework-binding-source.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const lines = new Map();
  const visit = (node) => {
    if (ts.isIdentifier(node) && !lines.has(node.text)) {
      lines.set(node.text, parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return lines;
}

/** 소스 실측 — 파일마다 발견된 표면과 첫 등장 줄. */
export function scanFiles(root = E2E_DIR) {
  return listFiles(root).map((full) => {
    const src = readFileSync(full, "utf8");
    const lines = src.split("\n");
    const identifierLines = full.endsWith(".mjs") ? javascriptIdentifierLines(src) : null;
    const surfaces = [];
    for (const { name, kind, re, jsIdentifiers } of SURFACE_PATTERNS) {
      const identifierAt = identifierLines && jsIdentifiers
        ? Math.min(...jsIdentifiers.map((identifier) => identifierLines.get(identifier) ?? Infinity))
        : Infinity;
      const at = Number.isFinite(identifierAt)
        ? identifierAt - 1
        : identifierLines && jsIdentifiers
          ? -1
          : lines.findIndex((l) => re.test(l));
      if (at >= 0) surfaces.push({ name, kind, line: at + 1 });
    }
    const banned = [];
    for (const { name, re, why } of BANNED_PATTERNS) {
      const at = lines.findIndex((l) => re.test(l));
      if (at >= 0) banned.push({ name, line: at + 1, why });
    }
    return {
      file: relative(root, full),
      class: classify(surfaces),
      surfaces,
      banned,
    };
  });
}

export function readLedger(path = LEDGER_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 장부 ↔ 소스 양방향 대조. 반환 = { entries, problems }. problems 가 비면 일치. */
export function verify({ root = E2E_DIR, ledger = readLedger() } = {}) {
  const scanned = scanFiles(root);
  const declared = new Map(ledger.files.map((f) => [f.file, f]));
  const problems = [];
  const entries = [];
  const usedSurfaces = new Set();

  for (const s of scanned) {
    const d = declared.get(s.file);
    if (!d) {
      problems.push(`${s.file}: 장부에 없다 — 새 하니스는 무리를 선언하고 들어온다`);
      entries.push({ ...s, role: null, note: null, declaredClass: null });
      continue;
    }
    declared.delete(s.file);
    for (const b of s.banned) problems.push(`${s.file}:${b.line}: ${b.why} (${b.name})`);

    const found = new Set(s.surfaces.map((x) => x.name));
    const said = new Set(d.surfaces ?? []);
    for (const name of found) {
      usedSurfaces.add(name);
      if (!said.has(name)) problems.push(`${s.file}: 표면 '${name}' 이 소스에 있는데 장부에 없다`);
    }
    for (const name of said) {
      usedSurfaces.add(name);
      if (!found.has(name)) problems.push(`${s.file}: 표면 '${name}' 이 장부에만 있다 — 죽은 선언`);
    }
    if (d.class !== s.class)
      problems.push(`${s.file}: 장부는 ${d.class}, 소스는 ${s.class} — 무리가 갈렸다`);
    if (!d.role) problems.push(`${s.file}: role 이 비었다`);
    if (!d.note?.trim()) problems.push(`${s.file}: note 가 비었다 — 이유 없는 분류는 우회로가 된다`);
    entries.push({ ...s, role: d.role, note: d.note, declaredClass: d.class });
  }

  for (const left of declared.keys())
    problems.push(`${left}: 장부에 있는데 파일이 없다 — 지워졌으면 장부에서도 지운다`);

  const bannedNames = new Set(BANNED_PATTERNS.map((p) => p.name));
  for (const name of bannedNames)
    if (!(ledger.banned ?? {})[name]?.why?.trim())
      problems.push(`banned.${name}: 장부에 이유가 없다 — 금지는 이유와 함께 적는다`);
  for (const name of Object.keys(ledger.banned ?? {}))
    if (!bannedNames.has(name)) problems.push(`banned.${name}: 탐지기에 없는 금지 이름`);

  const known = new Set(SURFACE_PATTERNS.map((p) => p.name));
  for (const [name, meta] of Object.entries(ledger.surfaces ?? {})) {
    if (!known.has(name)) problems.push(`surfaces.${name}: 탐지기에 없는 표면 이름`);
    if (!meta?.why?.trim()) problems.push(`surfaces.${name}: why 가 비었다`);
    if (!usedSurfaces.has(name)) problems.push(`surfaces.${name}: 쓰는 파일이 없다 — 죽은 표면`);
  }
  for (const name of usedSurfaces)
    if (!(name in (ledger.surfaces ?? {})))
      problems.push(`surfaces.${name}: 장부에 이유가 없다 — 표면은 이유와 함께 등재한다`);

  return { entries, problems, surfaces: ledger.surfaces ?? {} };
}

function counts(entries) {
  const c = { A: 0, B: 0, C: 0 };
  for (const e of entries) c[e.class] += 1;
  return c;
}

function main(argv) {
  const wantJson = argv.includes("--json");
  const wantSurfaces = argv.includes("--surfaces");
  const quiet = argv.includes("--check");
  const ci = argv.indexOf("--class");
  const only = ci >= 0 ? argv[ci + 1] : null;
  if (ci >= 0 && !CLASS_ORDER.includes(only)) {
    console.error("--class 는 A|B|C 하나여야 한다");
    return 2;
  }

  const { entries, problems, surfaces } = verify();
  const shown = only ? entries.filter((e) => e.class === only) : entries;

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          counts: counts(entries),
          surfaces,
          files: shown.map((e) => ({
            file: e.file,
            class: e.class,
            role: e.role,
            surfaces: e.surfaces.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
            note: e.note,
          })),
          problems,
        },
        null,
        2,
      ),
    );
    return problems.length ? 1 : 0;
  }

  if (wantSurfaces) {
    const byName = new Map();
    for (const e of entries)
      for (const s of e.surfaces) {
        if (!byName.has(s.name)) byName.set(s.name, { kind: s.kind, files: [] });
        byName.get(s.name).files.push(e.file);
      }
    for (const kind of ["native", "reducible"]) {
      console.log(`\n── ${kind === "native" ? "네이티브(프레임워크가 답한다)" : "줄일 수 있는 결속"} ──`);
      for (const [name, v] of [...byName].sort()) {
        if (v.kind !== kind) continue;
        const meta = surfaces[name] ?? {};
        const via = meta.env ? `  [${meta.env}]` : "";
        console.log(`${name}${via}\n    ${meta.why ?? ""}\n    ${v.files.length}개: ${v.files.join(" ")}`);
      }
    }
    return problems.length ? 1 : 0;
  }

  if (!quiet) {
    for (const cls of only ? [only] : CLASS_ORDER) {
      const rows = entries.filter((e) => e.class === cls);
      console.log(`\n── ${cls} ${CLASS_TITLE[cls]} — ${rows.length}개 ──`);
      for (const e of rows) {
        const names = e.surfaces.map((s) => s.name).join(" ");
        // 미선언 파일도 표에 선다 — 안 보이면 드리프트를 문제 목록에서만 읽게 된다.
        console.log(`  ${e.file.padEnd(28)} ${(e.role ?? "미선언").padEnd(8)} ${names}`);
      }
    }
    const c = counts(entries);
    console.log(`\n합계 A=${c.A} B=${c.B} C=${c.C} (총 ${entries.length})`);
  }

  if (problems.length) {
    console.error(`\n✗ e2e 프레임워크 결속 장부 불일치 ${problems.length}건`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  if (quiet) {
    const c = counts(entries);
    console.log(`✓ e2e 프레임워크 결속 장부 일치 — A=${c.A} B=${c.B} C=${c.C}`);
  } else {
    console.log("✓ 장부와 소스가 일치한다");
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
