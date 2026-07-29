// 작업 공간 진단의 기준.
//
// 보는 것은 **판정 로직**이다 — 어긋난 모양을 주면 잡는가, 정상인 모양을 통과시키는가.
// "오늘 이 기계가 어떤가"만 단언하면 고치는 순간 검사가 낡는다.
//
// 그리고 **멱등**을 잰다: 두 번 고쳐도 같은 상태고, 이미 정상이면 아무것도 안 한다.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diagnose, diskVerdict, freeGiB, cargoConfigBody, MIN_FREE_GIB, REPO_ROOT } from "./workspace-doctor.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-doctor-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const place = (rel, body = "") => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const worktree = (name) => mkdirSync(join(root, ".claude/worktrees", name), { recursive: true });

/** 진단 결과에서 문구 하나를 찾는다. */
const found = (needle, r = root) => diagnose(r).some((f) => f.what.includes(needle));

describe("공유 target 설정", () => {
  it("없으면 잡는다", () => {
    expect(found("공유 target 설정")).toBe(true);
  });

  it("절대경로로 이 저장소를 가리키면 통과", () => {
    place(".cargo/config.toml", cargoConfigBody(root));
    expect(found("공유 target 설정")).toBe(false);
  });

  /** 상대경로면 워크트리마다 자기 아래로 풀려 아무것도 공유되지 않는다. */
  it("상대경로면 잡는다", () => {
    place(".cargo/config.toml", '[build]\ntarget-dir = "target"\n');
    expect(found("공유 target 설정")).toBe(true);
  });

  it("남의 저장소를 가리켜도 잡는다", () => {
    place(".cargo/config.toml", cargoConfigBody("/somewhere/else"));
    expect(found("공유 target 설정")).toBe(true);
  });
});

describe("워크트리의 사본", () => {
  it("워크트리의 node_modules 를 잡는다", () => {
    worktree("w1");
    place(".claude/worktrees/w1/node_modules/.keep");
    expect(found("w1/node_modules")).toBe(true);
  });

  /** 껍데기와 온전한 사본은 **다른 사실**이다 — 하나는 죽고 하나는 낭비다. */
  it("껍데기와 온전한 사본을 사유로 가른다", () => {
    worktree("broken");
    place(".claude/worktrees/broken/node_modules/.keep");
    worktree("whole");
    place(
      ".claude/worktrees/whole/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    );
    const rs = diagnose(root);
    expect(rs.find((f) => f.what.includes("broken")).what).toContain("껍데기");
    expect(rs.find((f) => f.what.includes("whole")).what).toContain("온전");
  });

  it("워크트리의 target 을 잡는다", () => {
    worktree("w1");
    place(".claude/worktrees/w1/target/.keep");
    expect(found("w1/target")).toBe(true);
  });

  it("워크트리가 깨끗하면 아무것도 안 잡는다", () => {
    place(".cargo/config.toml", cargoConfigBody(root));
    worktree("clean");
    expect(diagnose(root)).toEqual([]);
  });
});

describe("버려도 되는 캐시", () => {
  /** 늘 지우면 이 도구가 빌드를 느리게 만드는 도구가 된다 — 부족할 때만 낸다. */
  it("여유가 넉넉하면 증분 캐시를 건드리지 않는다", () => {
    place(".cargo/config.toml", cargoConfigBody(root));
    place("target/debug/incremental/.keep");
    // 이 임시 루트의 볼륨 여유가 기준보다 크면 항목이 없어야 한다.
    const free = freeGiB(root);
    if (free !== null && free >= MIN_FREE_GIB) {
      expect(found("증분 컴파일 캐시")).toBe(false);
    }
  });
});

describe("정본 Electron", () => {
  /** 껍데기는 자동으로 못 고친다 — 재설치는 네트워크를 타므로 사람이 정한다. */
  it("Framework 가 없으면 잡되 고치지는 않는다", () => {
    place("node_modules/electron/dist/Electron.app/Contents/Info.plist");
    const f = diagnose(root).find((x) => x.what.includes("정본 Electron"));
    expect(f).toBeTruthy();
    expect(f.fix).toBeNull();
    expect(f.hint).toContain("npm install");
  });

  it("Framework 가 있으면 통과", () => {
    place("node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework");
    expect(found("정본 Electron")).toBe(false);
  });

  /** Electron 을 안 쓰는 트리에서 없는 것을 결함으로 세지 않는다. */
  it("Electron 이 아예 없으면 보지 않는다", () => {
    expect(found("정본 Electron")).toBe(false);
  });
});

describe("멱등", () => {
  it("고치면 두 번째 진단이 비고, 다시 고쳐도 같다", () => {
    worktree("w1");
    place(".claude/worktrees/w1/node_modules/.keep");
    place(".claude/worktrees/w1/target/.keep");

    for (const f of diagnose(root)) f.fix?.();
    const after = diagnose(root);
    expect(after).toEqual([]);

    for (const f of after) f.fix?.();
    expect(diagnose(root)).toEqual([]);
    // 고친 것이 실제로 사라졌는지 — 진단이 비었다는 말만 믿지 않는다.
    expect(existsSync(join(root, ".claude/worktrees/w1/node_modules"))).toBe(false);
    expect(existsSync(join(root, ".claude/worktrees/w1/target"))).toBe(false);
    expect(readFileSync(join(root, ".cargo/config.toml"), "utf8")).toBe(cargoConfigBody(root));
  });
});

describe("디스크", () => {
  /** 못 잰 것과 넉넉한 것을 같게 보면, 못 재는 환경에서 이 게이트가 통째로 사라진다. */
  it("못 재면 넉넉하다고 보지 않는다", () => {
    expect(diskVerdict("/no/such/path").ok).toBe(false);
  });

  it("기준을 넘으면 통과, 못 미치면 실패", () => {
    const free = freeGiB(REPO_ROOT);
    expect(free, "이 기계의 여유를 재지 못했다").not.toBeNull();
    expect(diskVerdict(REPO_ROOT, 0).ok).toBe(true);
    expect(diskVerdict(REPO_ROOT, free + 1000).ok).toBe(false);
  });

  it("기준이 이 저장소의 빌드 한 벌보다 크다", () => {
    // 한 벌이 17.5GiB 다(실측). 그보다 낮은 기준은 시작하자마자 차는 것을 허용한다.
    expect(MIN_FREE_GIB).toBeGreaterThanOrEqual(18);
  });
});
