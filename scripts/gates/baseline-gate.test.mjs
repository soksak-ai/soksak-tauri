// @vitest-environment node
// baseline-gate 자가검사 — 게이트를 실프로세스로 픽스처 루트에 대고 실행해
// 신규=실패 / stale=실패 / --prune 축소만 / --init 1회 / SELF 제외를 경로별로 단언한다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "baseline-gate.mjs");
const LENGTH_LIMIT = 1500; // 게이트의 상한과 같은 값 — 픽스처가 이 법에 대고 검증한다.

let root;

function runGate(...args) {
  const r = spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function write(rel, content) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// n건의 .unwrap( 을 가진 러스트 픽스처.
function rustWithUnwraps(n) {
  return `fn main() {\n${"    x.unwrap();\n".repeat(n)}}\n`;
}

function longFile(lines) {
  return "const x = 1;\n".repeat(lines);
}

/**
 * 게이트가 선언한 뿌리는 전부 있어야 한다 — 부재를 통과로 삼지 않는 것이 그 법이기 때문이다.
 * 픽스처가 그 법을 면제받으면 검사가 실물과 다른 규칙을 재게 된다.
 */
function standUpDeclaredRoots() {
  for (const r of [
    "frameworks/tauri/src",
    "frameworks/electron",
    "crates/soksak-core/src",
    "crates/soksak-store/src",
    "crates/soksak-vault/src",
    "crates/soksak-cored/src",
    "crates/soksak-ptyd/src",
    "crates/soksak-cli/src",
    "crates/soksak-net/src",
    "packages/plugin-api/src",
    "packages/plugin-spec/src",
    "src",
    "scripts",
  ]) {
    mkdirSync(join(root, r), { recursive: true });
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baseline-gate-"));
  standUpDeclaredRoots();
  write("frameworks/tauri/src/a.rs", rustWithUnwraps(2));
  write("src/big.ts", longFile(LENGTH_LIMIT + 1));
  write("src/ok.ts", "export const ok = true;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("baseline-gate", () => {
  it("기준선 부재면 실패한다", () => {
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("기준선 부재");
  });

  it("--init 이 기준선을 봉인하고 이후 실행이 통과한다", () => {
    expect(runGate("--init").status).toBe(0);
    expect(existsSync(join(root, "scripts/gates/baseline-unwrap.txt"))).toBe(true);
    expect(existsSync(join(root, "scripts/gates/baseline-file-length.txt"))).toBe(true);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("frameworks/tauri/src/a.rs 2");
    expect(readFileSync(join(root, "scripts/gates/baseline-file-length.txt"), "utf8")).toContain(
      `src/big.ts ${LENGTH_LIMIT + 1}`,
    );
    expect(runGate().status).toBe(0);
  });

  /**
   * 재봉인 금지 — 이미 봉인된 지표는 `--init` 이 **값을 건드리지 않는다.**
   *
   * (한때 이 검사는 "하나라도 있으면 전부 거부"를 재고 있었다. 그 규칙은 새 지표를 세울 길까지
   * 막았다 — 보장은 "다시 봉인하지 않는다"이지 "지표를 늘리지 않는다"가 아니다. 새 지표
   * 부트스트랩은 "새 지표의 최초 봉인" 묶음이 잰다.)
   */
  it("--init 은 이미 있는 봉인의 값을 바꾸지 않는다", () => {
    expect(runGate("--init").status).toBe(0);
    const before = readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8");
    // 위반을 늘려 놓고 다시 --init — 재봉인되면 그 위반이 새 기준이 되어 조용히 사면된다.
    write("frameworks/tauri/src/a.rs", rustWithUnwraps(9));
    runGate("--init");
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toBe(before);
    expect(runGate().status).toBe(1);
  });


  /**
   * 선언된 뿌리가 실제로 없으면 **실패해야 한다.**
   *
   * 지금은 `walk` 가 `catch { return; }` 로 부재를 삼킨다. 그러면 이관·개명으로 뿌리가
   * 사라지는 순간 그 아래 전부가 스캔 밖으로 나가고, 게이트는 위반 0건으로 **통과를 위장한다**.
   * 실측: `frameworks/tauri/protocol/src` 가 두 지표의 뿌리에 있는데 그 디렉터리는 없다.
   */
  it("선언된 뿌리가 하나라도 없으면 실패한다", () => {
    runGate("--init");
    // 뿌리 하나를 통째로 지운다 — 이관으로 사라진 상황과 같다.
    rmSync(join(root, "frameworks/tauri/src"), { recursive: true, force: true });
    const r = runGate();
    expect(r.status, `부재를 삼켰다: ${r.out}`).not.toBe(0);
    expect(r.out).toMatch(/뿌리/);
  });

  /** 봉인이 존재하지 않는 경로를 가리키면 stale 과 다른 사유로 실패해야 한다. */
  it("없는 파일을 봉인하고 있으면 그렇게 말한다", () => {
    runGate("--init");
    const seal = join(root, "scripts/gates/baseline-unwrap.txt");
    writeFileSync(seal, `${readFileSync(seal, "utf8")}frameworks/tauri/src/ghost.rs 3\n`);
    const r = runGate();
    expect(r.status).not.toBe(0);
    expect(r.out, "stale 과 구분되지 않는다").toMatch(/없는 파일|존재하지 않/);
  });

  it("신규 위반 파일이 생기면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/b.rs", rustWithUnwraps(1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: frameworks/tauri/src/b.rs");
  });

  it("봉인 값을 초과하면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/a.rs", rustWithUnwraps(3));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: frameworks/tauri/src/a.rs");
  });

  it("unwrap 은 배포 코드만 계수한다 — 인라인 #[cfg(test)] 모듈 unwrap 은 제외(테스트 idiom)", () => {
    // 배포 2건 + 테스트 모듈 3건 = 전문 5건이지만, unwrap 봉인은 배포 2건만 본다.
    const shipTwoTestThree =
      "fn ship() { x.unwrap(); y.unwrap(); }\n#[cfg(test)]\nmod tests {\n    fn t() { a.unwrap(); b.unwrap(); c.unwrap(); }\n}\n";
    write("frameworks/tauri/src/a.rs", shipTwoTestThree);
    expect(runGate("--init").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain(
      "frameworks/tauri/src/a.rs 2",
    );
    expect(runGate().status).toBe(0);
    // 테스트 모듈 unwrap 을 더 넣어도 위반이 아니다(계수 밖).
    write(
      "frameworks/tauri/src/a.rs",
      "fn ship() { x.unwrap(); y.unwrap(); }\n#[cfg(test)]\nmod tests {\n    fn t() { a.unwrap(); b.unwrap(); c.unwrap(); d.unwrap(); e.unwrap(); }\n}\n",
    );
    expect(runGate().status).toBe(0);
    // 배포 코드 unwrap 이 늘면 여전히 잡힌다 — 신호는 살아 있다.
    write("frameworks/tauri/src/a.rs", "fn ship() { x.unwrap(); y.unwrap(); z.unwrap(); }\n");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: frameworks/tauri/src/a.rs");
  });

  it("상한 초과 파일이 새로 생기면 실패한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src/huge.ts", longFile(LENGTH_LIMIT + 1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 file-length: src/huge.ts");
  });

  it("stale 봉인은 실패하고 --prune 만이 축소를 반영한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/a.rs", rustWithUnwraps(1));
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("stale 봉인 unwrap: frameworks/tauri/src/a.rs");
    // stale 실패는 기준선을 바꾸지 않는다 — 자동 축소 금지.
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("frameworks/tauri/src/a.rs 2");
    expect(runGate("--prune").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toContain("frameworks/tauri/src/a.rs 1");
    expect(runGate().status).toBe(0);
  });

  it("위반이 소멸하면 --prune 이 항목을 삭제한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/a.rs", rustWithUnwraps(0));
    write("src/big.ts", longFile(10));
    expect(runGate().status).toBe(1);
    expect(runGate("--prune").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).not.toContain("frameworks/tauri/src/a.rs");
    expect(readFileSync(join(root, "scripts/gates/baseline-file-length.txt"), "utf8")).not.toContain("src/big.ts");
    expect(runGate().status).toBe(0);
  });

  it("--prune 이 재입법 사유를 보존한다", () => {
    // 이 봉인 파일의 값은 숫자가 아니라 **왜 그 숫자인가**다. 값을 올린 커밋이 남긴 사유를
    // prune 이 지우면, 다음 사람은 근거 없는 수만 보고 그 수를 다시 올린다.
    expect(runGate("--init").status).toBe(0);
    const p = join(root, "scripts/gates/baseline-unwrap.txt");
    const REASON = "# ── 2026-07-29 명시 재입법: 스캐너가 눈이 멀어 있었다 ──";
    writeFileSync(p, readFileSync(p, "utf8").replace(/\n(?=frameworks)/, `\n${REASON}\n`));

    write("frameworks/tauri/src/a.rs", rustWithUnwraps(1));
    expect(runGate("--prune").status).toBe(0);

    const after = readFileSync(p, "utf8");
    expect(after).toContain(REASON);
    expect(after).toContain("frameworks/tauri/src/a.rs 1");
  });

  it("--prune 은 신규 위반을 지우지 못한다", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/b.rs", rustWithUnwraps(1));
    const r = runGate("--prune");
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 unwrap: frameworks/tauri/src/b.rs");
    // prune 이 신규 위반을 기준선에 추가하지 않는다.
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).not.toContain("frameworks/tauri/src/b.rs");
  });

  it("SELF 제외 — scripts/gates 아래는 스캔하지 않는다", () => {
    expect(runGate("--init").status).toBe(0);
    write("scripts/gates/bait.mjs", longFile(LENGTH_LIMIT + 100));
    expect(runGate().status).toBe(0);
  });

  it("테스트 파일은 스캔하지 않는다", () => {
    expect(runGate("--init").status).toBe(0);
    write("src/huge.test.ts", longFile(LENGTH_LIMIT + 100));
    write("frameworks/tauri/src/b_test.rs", rustWithUnwraps(5));
    expect(runGate().status).toBe(0);
  });

  it("복수형 _tests.rs 도 테스트 파일이다 (#[path] mod tests 관례)", () => {
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/service_tests.rs", rustWithUnwraps(5));
    expect(runGate().status).toBe(0);
  });

  it("--init 과 --prune 동시 지정은 거부한다", () => {
    expect(runGate("--init", "--prune").status).toBe(1);
  });
});

describe("프레임워크 폴더의 몸", () => {
  /**
   * **프레임워크 폴더에는 동작 코어를 남기지 않는다 — 닿든 안 닿든, 예외 없다.**
   *
   * 접촉(`tauri::`)의 유무·밀도로는 이 법을 못 잰다. 671줄 중 22줄이 프레임워크를 부르는
   * 파일은 프레임워크 파일이 아니라 **프레임워크 폴더 안에 사는 코어**이고, 접촉을 세는 눈에는
   * 정상으로 보인다(실측 2026-07-30: frameworks/tauri/src 55파일 17,780줄, 같은 일을 하는
   * frameworks/electron 은 15파일 1,598줄 — 11배).
   *
   * 그래서 **몸**을 센다. 파일마다 코드 줄 수를 봉인하고, 봉인은 내려가기만 한다.
   * 프레임워크 폴더가 커지는 것은 명시 재입법으로만 — 그때 그 증가가 배선인지 코어인지 적는다.
   */
  it("framework-body 지표가 프레임워크 폴더의 몸을 센다", () => {
    write("frameworks/tauri/src/thick.rs", "fn a() {\n    let x = 1;\n}\n");
    expect(runGate("--init").status).toBe(0);
    const seal = readFileSync(join(root, "scripts/gates/baseline-framework-body.txt"), "utf8");
    expect(seal).toContain("frameworks/tauri/src/thick.rs");
    // 주석과 빈 줄은 몸이 아니다 — 사유를 적는 일에 벌을 주면 사유가 사라진다.
    write("frameworks/tauri/src/thick.rs", "// 사유를 길게\n// 여러 줄로 적는다\n\nfn a() {\n    let x = 1;\n}\n");
    expect(runGate().status).toBe(0);
  });

  it("프레임워크 폴더가 굵어지면 실패한다", () => {
    write("frameworks/tauri/src/thick.rs", "fn a() {}\n");
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/thick.rs", "fn a() {}\nfn b() {}\nfn c() {}\n");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("신규 위반 framework-body");
  });

  it("몸을 빼면 --prune 이 봉인을 내린다", () => {
    write("frameworks/tauri/src/thick.rs", "fn a() {}\nfn b() {}\nfn c() {}\n");
    expect(runGate("--init").status).toBe(0);
    write("frameworks/tauri/src/thick.rs", "fn a() {}\n");
    expect(runGate().status).toBe(1);
    expect(runGate("--prune").status).toBe(0);
    expect(readFileSync(join(root, "scripts/gates/baseline-framework-body.txt"), "utf8"))
      .toContain("frameworks/tauri/src/thick.rs 1");
  });
});

describe("새 지표의 최초 봉인", () => {
  /**
   * `--init` 은 **없는 봉인만** 세운다.
   *
   * 거부의 뜻은 "이미 봉인된 지표를 다시 봉인하지 마라"이지 "지표를 늘리지 마라"가 아니다.
   * 하나가 있다고 전부 거부하면 새 지표를 세울 길이 사라지고, 그러면 새 법은 게이트 밖에서
   * 산다 — 실측(2026-07-30): framework-body 지표를 더하고 나서 부트스트랩할 방법이 없었다.
   */
  it("있는 봉인은 건드리지 않고 없는 것만 세운다", () => {
    expect(runGate("--init").status).toBe(0);
    const before = readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8");
    rmSync(join(root, "scripts/gates/baseline-framework-body.txt"), { force: true });

    const r = runGate("--init");
    expect(r.status).toBe(0);
    expect(existsSync(join(root, "scripts/gates/baseline-framework-body.txt"))).toBe(true);
    // 이미 있던 봉인은 그대로다 — 재봉인은 여전히 금지다.
    expect(readFileSync(join(root, "scripts/gates/baseline-unwrap.txt"), "utf8")).toBe(before);
    expect(r.out).toMatch(/이미 존재|건너/);
  });

  /** 세울 것이 하나도 없으면 그렇게 말하고 실패한다 — 조용한 성공은 "했다"로 읽힌다. */
  it("전부 이미 있으면 실패로 말한다", () => {
    expect(runGate("--init").status).toBe(0);
    const r = runGate("--init");
    expect(r.status).toBe(1);
    expect(r.out).toContain("세울 것이 없다");
  });
});
