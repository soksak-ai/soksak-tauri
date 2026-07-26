// 기다림은 사건으로 끝난다 — 숫자로 끝나지 않는다.
//
// (a) 이 게이트가 지키는 규칙
//     명령 핸들러(`src/commands/**`)와 코어 Rust(`src-tauri/src/**`)에 **숫자 리터럴 타이머**를
//     두지 않는다. "200 안 되면 300 늘릴 건가" 가 성립하는 순간 그 수는 근거가 아니라 짐작이다.
//     대기는 종결 사건(mounted·mountFailed·tabClosed·hostGone …)으로 끝나야 하고, 코어가 자기
//     상한을 갖더라도 그것을 호출자에게 숫자로 떠넘기지 않고 명시 코드(MOUNT_ABANDONED 류)로
//     변환한다.
//     정당한 예외(폴링 주기·백오프·헬스체크)는 아래 ALLOWED 표에 **사건 이름과 함께** 등록된
//     것만 허용한다. 표는 지금 비어 있다 — 무엇이 정당한지는 아직 판정되지 않았고, 판정 전에
//     예외를 미리 열어 두면 게이트가 아무것도 세지 않는다.
//
// (b) RED 근거 (실측 2026-07-26, 이 저장소)
//     src/commands 15곳 + src-tauri/src 53곳 = 68곳. 예외표가 비어 있으므로 68곳 전부 미등록이다.
//     src 쪽 대표: catalog.ts 의 `await sleep(250)`(테마 스캔 캡처 전 정착), `setTimeout(…, 30)`
//     (자기 파괴 명령이 답을 먼저 흘리는 자리) — 둘 다 "이만큼이면 되겠지" 가 판단 근거다.
//     rust 쪽 대표: webview.rs:1131 의 450ms(인스펙터 연결 대기), pty.rs:767/805 의 400ms
//     (구세대 데몬 종료 유예 넘기기).
//
// (c) 그 수를 만든 셸 질의 (그대로 재현 가능하다)
//     grep -rnE "setTimeout\(|sleep\(" src/commands | grep -E "[0-9]{2,}"          # 15
//     grep -rnE "from_millis\([0-9]|from_secs\([0-9]" src-tauri/src | grep -v _tests  # 53
//
//     아래 스캔은 저 두 파이프라인을 그대로 옮긴다. `[0-9]{2,}` 와 `_tests` 는 grep 출력 한 줄
//     전체(`경로:행:내용`)에 걸리므로 여기서도 그 문자열에 건다 — 다르게 걸면 수가 달라진다.
//     실측: 지금 `[0-9]{2,}` 는 한 건도 걸러내지 않는다(행 번호가 전부 두 자리 이상이라 필터가
//     무력하다). 그래도 질의를 임의로 "정리" 하지 않는다 — 정리하는 순간 §5 의 68 과 이 게이트의
//     수가 다른 것을 세게 된다.
//
//     한 가지만 뺀다: `*.test.ts`. 게이트가 자기 본문의 질의 문자열을 세면 영원히 GREEN 이 될 수
//     없다. 오늘 기준 이 제외로 빠지는 건수는 0 이다(15곳 중 테스트 파일은 없다).
//
// 앱 없이 소스를 읽는다(commandMessages.test 와 같은 방식) — 타이머는 실행이 아니라 코드에 있다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** 사건 이름 없이는 예외가 아니다. 지금은 비어 있다 — 정당성 판정 전에 문을 열지 않는다. */
const ALLOWED: { site: string; event: string; why: string }[] = [];

/** grep -r 과 같은 순회 — 숨김/빌드 산출물은 grep 도 안 읽는 곳만 건너뛴다. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "target" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** `경로:행:내용` — grep -rn 이 뱉는 그 한 줄. 뒤 필터가 이 문자열 전체에 걸린다. */
function grepLines(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of walk(join(ROOT, dir))) {
    if (file.endsWith(".test.ts")) continue; // 게이트가 자기 질의문을 세지 않는다
    const rel = relative(ROOT, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) out.push(`${rel}:${i + 1}:${line.trim()}`);
      });
  }
  return out;
}

const registered = new Set(ALLOWED.map((a) => a.site));

/** 예외표에 사건 이름과 함께 등록되지 않은 자리들. */
function unregistered(sites: string[]): string[] {
  return sites.map((s) => s.split(":").slice(0, 2).join(":")).filter((s) => !registered.has(s));
}

/** 질의1 — 명령 핸들러의 숫자 리터럴 타이머. */
function tsSites(): string[] {
  return grepLines("src/commands", /setTimeout\(|sleep\(/).filter((l) => /[0-9]{2,}/.test(l));
}

/** 질의2 — 코어 Rust 의 숫자 리터럴 타이머. 테스트 모듈 안은 세지 않는다.
 *
 *  `grep -v _tests` 는 파일 이름만 거른다 — schedule.rs 처럼 인라인 `#[cfg(test)] mod` 를 가진
 *  파일의 테스트 히트 32곳이 프로덕션으로 세어졌다(초판 53 = 프로덕션 21 + 테스트 32).
 *  그래서 파일별로 `#[cfg(test)]` 가 여는 mod 블록의 범위를 중괄호 짝으로 추적해 그 안을 뺀다. */
function rsSites(): string[] {
  const out: string[] = [];
  // 두 필터를 겹친다 — 파일 단위 테스트(`*_tests.rs`)와 인라인 `#[cfg(test)] mod`. 한쪽만
  // 쓰면 각각 13곳(service_tests.rs)·32곳(schedule.rs 류)이 프로덕션으로 오염된다(실측).
  for (const file of walk(join(ROOT, "src-tauri/src")).filter(
    (f) => f.endsWith(".rs") && !f.endsWith("_tests.rs"),
  )) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    let inTest = false;
    let depth = 0;
    let armed = false; // #[cfg(test)] 를 봤고 다음 mod 의 여는 중괄호를 기다린다
    lines.forEach((line, i) => {
      if (!inTest && /#\[cfg\(test\)\]/.test(line)) armed = true;
      if (armed && /\bmod\s+\w+/.test(line)) {
        inTest = true;
        armed = false;
        depth = 0;
      }
      if (inTest) {
        depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (depth <= 0 && /\}/.test(line)) inTest = false;
        return; // 테스트 모듈 안 — 세지 않는다
      }
      if (/from_millis\([0-9]|from_secs\([0-9]/.test(line)) out.push(`${rel}:${i + 1}:${line.trim()}`);
    });
  }
  return out;
}

describe("기다림은 사건으로 끝난다 — 숫자 리터럴 타이머 금지", () => {
  it("질의가 실제로 소스를 읽는다 — 빈 스캔이 통과로 위장하지 않는다", () => {
    const ts = walk(join(ROOT, "src/commands")).filter((f) => f.endsWith(".ts"));
    const rs = walk(join(ROOT, "src-tauri/src")).filter((f) => f.endsWith(".rs"));
    expect(ts.length).toBeGreaterThan(0);
    expect(rs.length).toBeGreaterThan(0);
  });

  it("명령 핸들러에 미등록 타이머가 없다 (src/commands)", () => {
    expect(unregistered(tsSites())).toEqual([]);
  });

  it("코어 Rust 에 미등록 타이머가 없다 (src-tauri/src)", () => {
    expect(unregistered(rsSites())).toEqual([]);
  });
});

describe("예외는 사건 이름과 함께만 산다", () => {
  it("등록된 예외는 전부 종결 사건을 밝힌다 — 이름 없는 예외는 예외가 아니다", () => {
    const nameless = ALLOWED.filter((a) => !a.event.trim() || !a.why.trim()).map((a) => a.site);
    expect(nameless).toEqual([]);
  });

  it("등록된 예외는 실재하는 자리를 가리킨다 — 사라진 자리를 표가 붙잡고 있지 않다", () => {
    const measured = new Set(
      [...tsSites(), ...rsSites()].map((s) => s.split(":").slice(0, 2).join(":")),
    );
    const stale = ALLOWED.map((a) => a.site).filter((s) => !measured.has(s));
    expect(stale).toEqual([]);
  });
});
