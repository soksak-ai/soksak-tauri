// 프레임워크 결속 장부 게이트의 자가검사 — 게이트가 위반을 실제로 잡는지부터 확인한다.
//
// 장부가 소스와 갈라져도 조용히 통과하면 분류는 값이 아니라 소문이 된다. 그래서 임시 트리에
// 위반을 심어 게이트가 죽는지 보고(잡는 능력 확인), 그다음 실제 scripts/e2e 를 대조한다.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BANNED_PATTERNS,
  SURFACE_PATTERNS,
  classify,
  scanFiles,
  readLedger,
  verify,
} from "./framework-binding.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "framework-binding-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (name, body) => {
  const full = join(root, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
};

/** 장부 한 벌 — 심은 파일만 담는다. 금지 목록은 탐지기와 짝이라 항상 채운다. */
const ledgerFor = (files, surfaces) => ({
  banned: Object.fromEntries(BANNED_PATTERNS.map((p) => [p.name, { why: p.why }])),
  surfaces,
  files: files.map((f) => ({ role: "harness", note: "테스트 픽스처", ...f })),
});

describe("표면 실측", () => {
  it("소켓 명령만 쓰는 파일은 A", () => {
    write("plain.mjs", 'await rpc("state.tree", {});\n');
    const [row] = scanFiles(root);
    expect(row.class).toBe("A");
    expect(row.surfaces).toEqual([]);
  });

  it("네이티브 표면이 하나라도 있으면 C", () => {
    write("pix.mjs", 'const r = await rpc("window.snapshot", { base64: true });\n');
    const [row] = scanFiles(root);
    expect(row.class).toBe("C");
    expect(row.surfaces.map((s) => s.name)).toEqual(["window.snapshot"]);
  });

  it("경로만 직접 아는 파일은 B", () => {
    write("pathy.sh", 'SOK="$REPO/target/debug/sok"\n');
    const [row] = scanFiles(root);
    expect(row.class).toBe("B");
    expect(row.surfaces.map((s) => s.name)).toEqual(["build-artifact-path"]);
  });

  it("픽셀 판정을 오라클 함수로 부르는 파일도 pixel-oracle 로 잡힌다", () => {
    // 판정이 lib/frame-oracle.mjs 뒤로 들어가면서 디코더를 직접 부르지 않는 소비자가 생겼다.
    // 진입점만 보고 "표면 없음"을 내면 픽셀 위에 선 파일이 A 로 앉는다.
    write("verdict.mjs", "const v = judgeFrame(bytes, { region });\n");
    const [row] = scanFiles(root);
    expect(row.class).toBe("C");
    expect(row.surfaces.map((s) => s.name)).toEqual(["pixel-oracle"]);
  });

  it("문자열과 주석으로 픽셀 오라클 부재를 검사하는 계약 테스트는 C로 오인하지 않는다", () => {
    write("contract.test.mjs", [
      '// 하니스가 compareFrames 를 직접 부르면 안 된다.',
      'expect(source).not.toContain("decodePng");',
      "expect(source).not.toContain('judgeFrame');",
      'expect(source).toContain("observeFrameSequence");',
    ].join("\n"));
    const [row] = scanFiles(root);
    expect(row.class).toBe("A");
    expect(row.surfaces).toEqual([]);
  });

  it("Tauri AppKit surface resize 정책을 판정하는 코드는 C", () => {
    write("policy.mjs", "const verdict = tauriSurfaceResizePolicyVerdict(surfaces);\n");
    const [row] = scanFiles(root);
    expect(row.class).toBe("C");
    expect(row.surfaces.map((s) => s.name)).toEqual(["tauri-appkit-surface-policy"]);
  });

  it("픽셀 관측 공개 진입점을 쓰는 소비자도 pixel-oracle 로 잡힌다", () => {
    write("visual.mjs", [
      'import { observeFrameSequence as inspect } from "./visual.mjs";',
      "inspect(frames, name, scale);",
    ].join("\n"));
    const [row] = scanFiles(root);
    expect(row.class).toBe("C");
    expect(row.surfaces.map((s) => s.name)).toEqual(["pixel-oracle"]);
  });

  it("산문에 적힌 엔진 이름은 결속이 아니다", () => {
    write("prose.mjs", "// 백그라운드 WKWebView 는 스로틀된다\n");
    const [row] = scanFiles(root);
    expect(row.class).toBe("A");
  });

  it("네이티브가 있으면 줄일 결속이 함께 있어도 C", () => {
    expect(classify([{ kind: "reducible" }, { kind: "native" }])).toBe("C");
  });
});

describe("금지 패턴", () => {
  it("소켓 경로 기본값은 어느 파일에서든 잡힌다", () => {
    write("bad.mjs", 'const S = process.env.SOKSAK_SOCKET || "/tmp/x.sock";\n');
    const [row] = scanFiles(root);
    expect(row.banned.map((b) => b.name)).toEqual(["socket-default"]);
    expect(row.banned[0].line).toBe(1);
  });

  it("셸 문법의 기본값도 잡는다", () => {
    write("bad.sh", 'SOCK="${SOKSAK_SOCKET:-$HOME/x.sock}"\n');
    const [row] = scanFiles(root);
    expect(row.banned.map((b) => b.name)).toEqual(["socket-default"]);
  });

  it("금지 패턴은 전부 이유를 달고 있다", () => {
    for (const p of BANNED_PATTERNS) expect(p.why.trim().length).toBeGreaterThan(0);
  });

  it("장부가 금지 이유를 비워 두면 통과하지 못한다", () => {
    const { problems } = verify({
      root,
      ledger: { banned: { "socket-default": { why: "" } }, surfaces: {}, files: [] },
    });
    expect(problems.join("\n")).toMatch(/금지는 이유와 함께 적는다/);
  });
});

describe("장부 대조", () => {
  const surfaces = {
    "window.snapshot": { kind: "native", why: "프레임워크가 자기 창을 합성한다" },
  };

  it("선언과 실측이 같으면 문제 없음", () => {
    write("a.mjs", 'await rpc("window.snapshot", {});\n');
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "a.mjs", class: "C", surfaces: ["window.snapshot"] }], surfaces),
    });
    expect(problems).toEqual([]);
  });

  it("소스에만 있는 표면은 드리프트", () => {
    write("a.mjs", 'await rpc("window.snapshot", {});\n');
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "a.mjs", class: "C", surfaces: [] }], surfaces),
    });
    expect(problems.join("\n")).toMatch(/장부에 없다/);
  });

  it("장부에만 있는 표면은 죽은 선언", () => {
    write("a.mjs", "// 아무것도 안 한다\n");
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "a.mjs", class: "C", surfaces: ["window.snapshot"] }], surfaces),
    });
    expect(problems.join("\n")).toMatch(/죽은 선언/);
  });

  it("선언한 무리가 실측과 다르면 실패", () => {
    write("a.mjs", 'await rpc("window.snapshot", {});\n');
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "a.mjs", class: "A", surfaces: ["window.snapshot"] }], surfaces),
    });
    expect(problems.join("\n")).toMatch(/무리가 갈렸다/);
  });

  it("장부에 없는 새 파일은 통과하지 못한다", () => {
    write("a.mjs", "// 새로 들어온 하니스\n");
    const { problems } = verify({ root, ledger: ledgerFor([], {}) });
    expect(problems.join("\n")).toMatch(/장부에 없다/);
  });

  it("파일이 사라지면 장부에서도 지우게 한다", () => {
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "gone.mjs", class: "A", surfaces: [] }], {}),
    });
    expect(problems.join("\n")).toMatch(/파일이 없다/);
  });

  it("이유 없는 표면 등재는 통과하지 못한다", () => {
    write("a.mjs", 'await rpc("window.snapshot", {});\n');
    const { problems } = verify({
      root,
      ledger: ledgerFor([{ file: "a.mjs", class: "C", surfaces: ["window.snapshot"] }], {
        "window.snapshot": { kind: "native", why: "  " },
      }),
    });
    expect(problems.join("\n")).toMatch(/why 가 비었다/);
  });

  it("이유 없는 분류는 통과하지 못한다", () => {
    write("a.mjs", "// 소켓만 쓴다\n");
    const { problems } = verify({
      root,
      ledger: { surfaces: {}, files: [{ file: "a.mjs", class: "A", role: "harness", note: "" }] },
    });
    expect(problems.join("\n")).toMatch(/note 가 비었다/);
  });
});

describe("실제 scripts/e2e", () => {
  it("장부와 소스가 일치한다", () => {
    const { problems } = verify();
    expect(problems).toEqual([]);
  });

  it("지어낸 소켓 기본값이 하나도 없다", () => {
    const offenders = scanFiles()
      .filter((f) => f.banned.length > 0)
      .map((f) => `${f.file}:${f.banned[0].line}`);
    expect(offenders).toEqual([]);
  });

  it("장부의 표면 이름은 전부 탐지기가 아는 이름이다", () => {
    const known = new Set(SURFACE_PATTERNS.map((p) => p.name));
    for (const name of Object.keys(readLedger().surfaces)) expect(known.has(name)).toBe(true);
  });

  it("줄일 수 있는 결속은 대체 통로를 이름으로 달고 있다", () => {
    for (const [name, meta] of Object.entries(readLedger().surfaces)) {
      if (meta.kind !== "reducible") continue;
      expect(meta.env, `${name} 에 env 가 없다`).toBeTruthy();
    }
  });
});
