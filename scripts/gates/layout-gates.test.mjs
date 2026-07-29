// 배치 게이트 셋의 기준.
//
// 배치가 문서에만 있으면 다음 사람이 다시 어긴다. 그래서 게이트가 있고, 게이트가 스스로
// 무너지지 않는 것이 곧 그 배치의 신뢰다.
//
// 여기서 보는 것은 **판정 로직**이다 — "오늘 이 저장소가 어긴다/안 어긴다"가 아니라
// "어기는 모양을 주면 잡는가, 안 어기는 모양을 주면 통과시키는가". 앞의 것만 보면 이주가
// 끝나는 순간 검사가 통째로 낡는다(실측: 이주 전 상태를 단언하던 검사 셋이 이주와 함께 죽었다).
//
// 그 위에 이 저장소 실측 하나를 더 얹는다 — 지금 배치가 셋 다 통과해야 한다.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as placement from "./framework-free-placement.mjs";
import * as wsroot from "./workspace-root-not-framework.mjs";
import * as vocab from "./framework-folder-vocabulary.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "layout-gate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 임시 트리에 매니페스트 한 장. 경로가 곧 배치이므로 경로로 모양을 말한다. */
function write(rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const freeCrate = (rel, name) =>
  write(rel, `[package]\nname = "${name}"\n\n[dependencies]\nserde = "1"\n`);
const frameworkApp = (rel, name) =>
  write(rel, `[package]\nname = "${name}"\n\n[dependencies]\ntauri = "2"\n`);

describe("① 프레임워크 무관 크레이트는 프레임워크 밖에 산다", () => {
  it("프레임워크 마당 밑의 무관 크레이트를 잡는다", () => {
    write("Cargo.toml", '[workspace]\nmembers = ["frameworks/tauri/crates/helper"]\n');
    frameworkApp("frameworks/tauri/Cargo.toml", "app");
    freeCrate("frameworks/tauri/crates/helper/Cargo.toml", "helper");
    const { violations } = placement.verify(root, { placement: [], dependency: [] });
    expect(violations.map((v) => `${v.law} ${v.name}`)).toContain("placement helper");
  });

  it("프레임워크 밖에서 프레임워크를 의존하면 잡는다", () => {
    write("Cargo.toml", '[workspace]\nmembers = ["crates/rogue"]\n');
    frameworkApp("crates/rogue/Cargo.toml", "rogue");
    const { violations } = placement.verify(root, { placement: [], dependency: [] });
    expect(violations.map((v) => `${v.law} ${v.name}`)).toContain("dependency rogue");
  });

  /** 어기지 않는 모양은 통과해야 한다 — 다 잡는 게이트는 아무것도 안 지키는 게이트와 같다. */
  it("옳은 배치는 통과시킨다", () => {
    write("Cargo.toml", '[workspace]\nmembers = ["crates/core", "frameworks/tauri"]\n');
    freeCrate("crates/core/Cargo.toml", "core");
    frameworkApp("frameworks/tauri/Cargo.toml", "app");
    const { violations } = placement.verify(root, { placement: [], dependency: [] });
    expect(violations).toEqual([]);
  });
});

describe("② 워크스페이스 루트는 프레임워크가 아니다", () => {
  it("루트가 곧 프레임워크 앱이면 잡는다", () => {
    write(
      "src-tauri/Cargo.toml",
      '[workspace]\nmembers = ["crates/core"]\n\n[package]\nname = "app"\n\n[dependencies]\ntauri = "2"\n',
    );
    freeCrate("src-tauri/crates/core/Cargo.toml", "core");
    const { problems } = wsroot.verify(root);
    expect(problems.join("\n")).toMatch(/프레임워크/);
  });

  /**
   * `[patch.*]` 는 의존 간선이 아니다 — 그리고 cargo 는 그것을 **루트에서만** 인정한다
   * (멤버에 두면 경고만 내고 무시한다). 상류 패치가 필요한 저장소는 루트에 프레임워크
   * 이름을 적을 수밖에 없으므로, 그것을 의존으로 세면 고칠 수 없는 위반이 영원히 남는다.
   */
  it("루트의 patch 는 의존으로 세지 않는다", () => {
    write(
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/core"]\n\n[patch.crates-io]\ntauri = { git = "x" }\n',
    );
    freeCrate("crates/core/Cargo.toml", "core");
    const { problems } = wsroot.verify(root);
    expect(problems).toEqual([]);
  });

  it("가상 루트 + 프레임워크 멤버는 통과시킨다", () => {
    write("Cargo.toml", '[workspace]\nmembers = ["crates/core", "frameworks/tauri"]\n');
    freeCrate("crates/core/Cargo.toml", "core");
    frameworkApp("frameworks/tauri/Cargo.toml", "app");
    expect(wsroot.verify(root).problems).toEqual([]);
  });
});

describe("③ frameworks/ 아래 이름은 framework 어휘만", () => {
  const V = vocab.readVocabulary();

  it("어휘 넷을 표준 문서에서 읽는다", () => {
    // 오라클 생존 — 못 읽으면 아래 판정이 전부 무의미하다.
    expect(V.size ?? V.length ?? Object.keys(V).length).toBeGreaterThan(0);
  });

  it("프레임워크 이름은 통과, 다른 축의 낱말은 잡는다", () => {
    expect(vocab.forbiddenHit("electron", V)).toBe(null);
    expect(vocab.forbiddenHit("tauri", V)).toBe(null);
    for (const bad of ["platform", "engine", "shell"]) {
      expect(vocab.forbiddenHit(bad, V), `${bad} 는 다른 축이다`).not.toBe(null);
    }
  });
});

describe("이 저장소 실측 — 이주가 끝났다", () => {
  // 셋 다 저장소 전체의 매니페스트를 걷는다 — 병렬 실행의 기본 시한(5s)보다 오래 걸린다.
  // 시한을 그 사실에 맞춘다(검사를 줄이는 것이 아니라 재는 시간을 정직하게 준다).
  it("셋 다 통과한다", { timeout: 30_000 }, () => {
    expect(placement.verify().violations, "배치").toEqual([]);
    expect(wsroot.verify().problems, "워크스페이스 루트").toEqual([]);
    expect(vocab.scanRoot().violations ?? [], "어휘").toEqual([]);
  });
});
