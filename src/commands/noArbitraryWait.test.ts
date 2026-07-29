// 기다림은 사건으로 끝난다 — 숫자로 끝나지 않는다.
//
// (a) 이 게이트가 지키는 규칙
//     명령 핸들러(`src/commands/**`)와 코어 Rust(`frameworks/tauri/src/**`)에 **숫자 리터럴 타이머**를
//     두지 않는다. "200 안 되면 300 늘릴 건가" 가 성립하는 순간 그 수는 근거가 아니라 짐작이다.
//     대기는 종결 사건(mounted·mountFailed·tabClosed·hostGone …)으로 끝나야 하고, 코어가 자기
//     상한을 갖더라도 그것을 호출자에게 숫자로 떠넘기지 않고 명시 코드(MOUNT_ABANDONED 류)로
//     변환한다.
//     정당한 예외(폴링 주기·백오프·헬스체크)는 아래 ALLOWED 표에 **사건 이름과 함께** 등록된
//     것만 허용한다. 표는 지금 비어 있다 — 무엇이 정당한지는 아직 판정되지 않았고, 판정 전에
//     예외를 미리 열어 두면 게이트가 아무것도 세지 않는다.
//
// (b) RED 근거 (실측 2026-07-26, 이 저장소)
//     src/commands 15곳 + frameworks/tauri/src 53곳 = 68곳. 예외표가 비어 있으므로 68곳 전부 미등록이다.
//     src 쪽 대표: catalog.ts 의 `await sleep(250)`(테마 스캔 캡처 전 정착), `setTimeout(…, 30)`
//     (자기 파괴 명령이 답을 먼저 흘리는 자리) — 둘 다 "이만큼이면 되겠지" 가 판단 근거다.
//     rust 쪽 대표: webview.rs:1131 의 450ms(인스펙터 연결 대기), pty.rs:767/805 의 400ms
//     (구세대 데몬 종료 유예 넘기기).
//
// (c) 그 수를 만든 셸 질의 (그대로 재현 가능하다)
//     grep -rnE "setTimeout\(|sleep\(" src/commands | grep -E "[0-9]{2,}"          # 15
//     grep -rnE "from_millis\([0-9]|from_secs\([0-9]" frameworks/tauri/src | grep -v _tests  # 53
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

/** 사건 이름 없이는 예외가 아니다.
 *
 *  판정 완료(2026-07-26, 전 사이트 코드 확인). 세 부류만 정당하다:
 *  ① 사용자 파라미터 대기 — 시간 자체가 명령의 기능이다(debug.sleep 의 ms, 드래그의
 *     durationMs). "임의 상한"이 아니라 호출자가 발화한 값이다.
 *  ② 프로토콜·OS 경계 유예 — 상대가 사건을 주지 않는 지점(옛 데몬의 종료 유예 150ms 계약,
 *     WebKit inspector 의 비동기 show, SQLite busy_timeout). 제거 조건 = 상대가 신호를 주는 날.
 *  ③ 유한 안전망 — 사건이 주 경로이고 타이머는 사건 유실 시의 탈출구다(condvar
 *     wait_timeout, 죽은 사이드카 recv_timeout). 무한 대기 방지가 목적이지 페이싱이 아니다.
 *
 *  여기 없는 새 타이머는 게이트가 잡는다 — 이 표가 게이트의 존재 이유다. */
const ALLOWED: { file: string; mark: string; event: string; why: string }[] = [
  // ── ① 사용자 파라미터 대기 ──
  { file: "src/commands/catalog.ts", mark: "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));", event: "caller-specified", why: "sleep 헬퍼 — 소비처는 전부 호출자 지정 ms" },
  { file: "src/commands/catalog.ts", mark: "await sleep(settleMs);", event: "caller-specified", why: "settleMs 파라미터 — 캡처 정착 시간을 호출자가 발화" },
  { file: "src/commands/catalog.ts", mark: "await sleep(applyAtMs);", event: "caller-specified", why: "applyAtMs 파라미터" },
  { file: "src/commands/catalog.ts", mark: "const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));", event: "caller-specified", why: "sleep 헬퍼(테마 스캔)" },
  { file: "src/commands/catalog.ts", mark: "await sleep(settleMs);", event: "caller-specified", why: "settleMs 파라미터" },
  { file: "src/commands/catalog.ts", mark: "await sleep(applyAtMs);", event: "caller-specified", why: "applyAtMs 파라미터" },
  { file: "src/commands/catalogDebug.ts", mark: "const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));", event: "caller-specified", why: "debug.sleep — 대기 자체가 명령의 기능" },
  { file: "src/commands/catalogDebug.ts", mark: "await sleep(ms);", event: "caller-specified", why: "debug.sleep 본체" },
  { file: "src/commands/catalogDom.ts", mark: "window.setTimeout(() => focusTraceStop?.(), ms)", event: "caller-specified", why: "focus trace 자동 종료 ms — 호출자 지정" },
  { file: "src/commands/catalogDom.ts", mark: "window.setTimeout(resolve, durationMs / steps)", event: "caller-specified", why: "드래그 durationMs/steps — 호출자 지정" },
  { file: "src/commands/catalogDom.ts", mark: "await new Promise<void>((done) => setTimeout(done, ms));", event: "caller-specified", why: "ui.input.observe 관측 창(ms) — 대기 자체가 명령의 기능이다(그 창 동안 도착한 입력을 센다). rAF 는 가려진 창에서 멈춰 명령이 안 끝난다" },
  { file: "src/commands/catalogDom.ts", mark: "else setTimeout(tick, 16);", event: "caller-specified", why: "ui.trace 표본 캐던스 — 호출자 지정 창(ms) 안의 계측 수집. rAF 는 가려진 창에서 멈춰 명령이 영영 안 끝난다(실측 TIMEOUT)" },
  { file: "src/commands/catalogRemote.ts", mark: "setTimeout(() => {", event: "caller-specified", why: "remote.confirm TTL(ttlSecs 파라미터) — 만료=Deny 가 계약(fail-closed)" },
  // ── ② 프로토콜·OS 경계 유예(TS) ──
  { file: "src/commands/catalogDom.ts", mark: "new Promise((r) => setTimeout(r, 50))", event: "dnd-frame-pacing", why: "합성 DragEvent 시퀀스의 프레임 간격 — 브라우저 DnD 상태기계가 같은 틱의 연속 이벤트를 접는다" },
  // ── ② 프로토콜·OS 경계 유예 ──
  { file: "src/commands/catalog.ts", mark: "setTimeout(() => window.location.reload(), 30);", event: "self-destruct-reply-flush", why: "자기 파괴 명령은 답을 먼저 흘린다 — 통로가 파괴로 함께 죽는다(window.reload)" },
  { file: "src/commands/catalog.ts", mark: "setTimeout(() => void invoke(\"window_close\", { label }), 30);", event: "self-destruct-reply-flush", why: "동일 계약(window.close 자기 창)" },
  { file: "src/commands/catalog.ts", mark: "await sleep(250);", event: "theme-css-cascade", why: "테마 클래스 전환 후 CSS 캐스케이드 반영 유예 — 브라우저가 완료 신호를 주지 않는다" },
  { file: "frameworks/tauri/src/clipboard.rs", mark: "SELF_WRITE_TTL: Duration = Duration::from_secs(2)", event: "self-write-ttl", why: "자기 쓰기 판별 시간창(TTL 상수) — 타이머가 아니라 판별 기준" },
  { file: "frameworks/tauri/src/data/commands.rs", mark: "WRITE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(60)", event: "sqlite-write-backoff", why: "SQLITE_BUSY 재시도 백오프" },
  { file: "crates/soksak-store/src/ring.rs", mark: "MIN_INTERVAL: Duration = Duration::from_secs(3600)", event: "ring-prune-min-interval", why: "링 정리 최소 간격(유휴 하한)" },
  { file: "crates/soksak-store/src/ring.rs", mark: "busy_timeout(Duration::from_secs(5))", event: "sqlite-busy-timeout", why: "SQLite busy_timeout — DB 계약" },
  { file: "crates/soksak-net/src/transport.rs", mark: "timeout(Duration::from_secs(60))", event: "http-client-timeout", why: "원격 HTTP 상한 — 네트워크는 사건을 보장하지 않는다" },
  { file: "frameworks/tauri/src/webview.rs", mark: ".recv_timeout(std::time::Duration::from_secs(2))", event: "engine-surface-stats-reply", why: "메인 스레드 서피스 판독 회신 대기의 유한 안전장치 — 회신 채널이 사건이고 상한은 관측 명령의 무한 대기 방지" },
  { file: "frameworks/tauri/src/pty.rs", mark: "from_millis(400)", event: "ptyd-shutdown-grace", why: "옛 데몬의 종료 유예(응답 후 150ms) 계약을 넘긴다 — 재기동 1회 한정" },
  { file: "frameworks/tauri/src/pty.rs", mark: "from_millis(400)", event: "ptyd-socket-rebind", why: "구 데몬 소켓 해제→신 데몬 bind 사이 — 소켓 계승 신호가 없다" },
  { file: "frameworks/tauri/src/webview.rs", mark: "from_millis(450)", event: "wk-inspector-async-show", why: "WebKit _inspector show 는 비동기이고 완료 콜백이 없다(SPI)" },
  { file: "frameworks/tauri/src/daemon.rs", mark: "from_millis(200)", event: "child-exit-poll", why: "child try_wait 유한 폴링(limit 상한·초과 시 kill) — waitpid 블로킹은 ring 수집과 양립 불가" },
  { file: "frameworks/tauri/src/daemon.rs", mark: "from_millis(300)", event: "child-exit-poll", why: "상주 데몬 종료 감시 — 동일 사유" },
  { file: "frameworks/tauri/src/schedule.rs", mark: "Duration::from_secs(3_600)", event: "scheduler-idle-cap", why: "다음 예약 없음 상태의 유휴 상한(스케줄 등록이 즉시 깨운다)" },
  { file: "crates/soksak-watch/src/lib.rs", mark: "from_millis(250)", event: "fs-debounce", why: "파일와처 디바운스 — 이벤트 병합 창" },
  // ── ③ 유한 안전망 ──
  { file: "frameworks/tauri/src/activity.rs", mark: "wait_timeout(q, Duration::from_secs(1))", event: "condvar-safety-net", why: "cv 사건이 주 경로 — 1s 는 closed 플래그 재확인 안전망" },
  { file: "frameworks/tauri/src/service.rs", mark: "wait_timeout(inner, Duration::from_millis(20))", event: "condvar-safety-net", why: "크래시 전이가 cv 를 울린다 — 20ms 는 유실 안전망" },
  { file: "frameworks/tauri/src/sidecar.rs", mark: "recv_timeout(std::time::Duration::from_secs(10))", event: "sidecar-reply-cap", why: "죽은 사이드카에 무한 대기 방지(10s)" },
  { file: "frameworks/tauri/src/sidecar.rs", mark: "recv_timeout(std::time::Duration::from_secs(2))", event: "sidecar-reply-cap", why: "동일(2s)" },
  { file: "frameworks/tauri/src/webview.rs", mark: "recv_timeout(Duration::from_secs(3))", event: "main-thread-dispatch-cap", why: "메인스레드 디스패치 응답 상한(3s)" },
  { file: "frameworks/tauri/src/webview.rs", mark: "recv_timeout(Duration::from_secs(15))", event: "main-thread-dispatch-cap", why: "동일(15s — 콜드 부트 포함)" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_millis(150)", event: "pty.stream.reattached", why: "데몬 인계 전이(구 데몬 exit → 신 데몬 소켓 bind) 대기 — 세션 확인·재부착 성공이 종결, 상한 20회" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_secs(2)", event: "ptyd-bootstrap-handshake", why: "스폰 직후 소켓 준비 유한 재시도(2s 상한) — 감시는 소켓 에러 사건이 담당" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_millis(50)", event: "ptyd-bootstrap-handshake", why: "동일 루프의 재시도 간격" },
  { file: "frameworks/tauri/src/webview.rs", mark: "tokio::time::sleep(Duration::from_millis(400))", event: "extraction-page-settle", why: "추출용 임시 webview 의 페이지 정착 유한 재시도(timeout 상한)" },
];

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

/** 예외표에 사건 이름과 함께 등록되지 않은 자리들.
 *  앵커는 행 번호가 아니라 **그 줄의 내용**이다 — 행 번호는 무관한 편집(윗줄 추가)에도
 *  깨진다(실측: pty.rs 에 7줄이 들어가자 아래 사이트 전부가 미등록으로 오탐됐다). */
function unregistered(sites: string[]): string[] {
  return sites.filter((s) => {
    const file = s.split(":")[0];
    const text = s.split(":").slice(2).join(":");
    return !ALLOWED.some((a) => a.file === file && text.includes(a.mark));
  });
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
  // 코어 크레이트도 센다. 규칙은 **코드를 따라간다** — 파일이 옮겨 갔다고 규칙에서 빠지면
  // 그 순간부터 그 자리의 기다림은 아무도 안 본다(실측: ptyd 클라이언트가 코어로 가면서
  // 등록돼 있던 세 자리가 통째로 스캔 밖으로 나갔다).
  const roots = [
    "frameworks/tauri/src",
    "crates/soksak-core/src",
    "crates/soksak-store/src",
    "crates/soksak-watch/src",
    "crates/soksak-net/src",
  ];
  for (const file of roots
    .flatMap((r) => walk(join(ROOT, r)))
    .filter((f) => f.endsWith(".rs") && !f.endsWith("_tests.rs"))) {
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
    const rs = walk(join(ROOT, "frameworks/tauri/src")).filter((f) => f.endsWith(".rs"));
    expect(ts.length).toBeGreaterThan(0);
    expect(rs.length).toBeGreaterThan(0);
  });

  it("명령 핸들러에 미등록 타이머가 없다 (src/commands)", () => {
    expect(unregistered(tsSites())).toEqual([]);
  });

  it("코어 Rust 에 미등록 타이머가 없다 (frameworks/tauri/src)", () => {
    expect(unregistered(rsSites())).toEqual([]);
  });
});

describe("예외는 사건 이름과 함께만 산다", () => {
  it("등록된 예외는 전부 종결 사건을 밝힌다 — 이름 없는 예외는 예외가 아니다", () => {
    const nameless = ALLOWED.filter((a) => !a.event.trim() || !a.why.trim()).map((a) => `${a.file} :: ${a.mark}`);
    expect(nameless).toEqual([]);
  });

  it("등록된 예외는 실재하는 자리를 가리킨다 — 사라진 자리를 표가 붙잡고 있지 않다", () => {
    const sites = [...tsSites(), ...rsSites()];
    const stale = ALLOWED.filter(
      (a) =>
        !sites.some(
          (s) => s.split(":")[0] === a.file && s.split(":").slice(2).join(":").includes(a.mark),
        ),
    ).map((a) => `${a.file} :: ${a.mark}`);
    expect(stale).toEqual([]);
  });
});
