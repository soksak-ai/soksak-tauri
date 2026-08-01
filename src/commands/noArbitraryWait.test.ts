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
  { file: "src/commands/catalogDom.ts", mark: "window.setTimeout(() => focusTrace.focusTraceStop?.(), ms)", event: "caller-specified", why: "focus trace 자동 종료 ms — 호출자 지정" },
  { file: "src/commands/catalogDom.ts", mark: "window.setTimeout(resolve, durationMs / steps)", event: "caller-specified", why: "드래그 durationMs/steps — 호출자 지정" },
  { file: "src/commands/catalogDom.ts", mark: "await new Promise<void>((done) => setTimeout(done, ms));", event: "caller-specified", why: "ui.input.observe 관측 창(ms) — 대기 자체가 명령의 기능이다(그 창 동안 도착한 입력을 센다). rAF 는 가려진 창에서 멈춰 명령이 안 끝난다" },
  { file: "src/commands/catalogDom.ts", mark: "else setTimeout(tick, 16);", event: "caller-specified", why: "ui.trace 표본 캐던스 — 호출자 지정 창(ms) 안의 계측 수집. rAF 는 가려진 창에서 멈춰 명령이 영영 안 끝난다(실측 TIMEOUT)" },
  { file: "src/commands/catalogRemote.ts", mark: "setTimeout(() => {", event: "caller-specified", why: "remote.confirm TTL(ttlSecs 파라미터) — 만료=Deny 가 계약(fail-closed)" },
  // ── ② 프로토콜·OS 경계 유예(TS) ──
  { file: "src/commands/catalogDom.ts", mark: "new Promise((r) => setTimeout(r, 50))", event: "dnd-frame-pacing", why: "합성 DragEvent 시퀀스의 프레임 간격 — 브라우저 DnD 상태기계가 같은 틱의 연속 이벤트를 접는다" },
  // ── ② 프로토콜·OS 경계 유예 ──
  { file: "src/commands/catalogWindow.ts", mark: "setTimeout(() => {", event: "self-destruct-reply-flush", why: "자기 파괴 명령은 답을 먼저 흘린다 — 통로가 파괴로 함께 죽는다(window.reload). 파괴 자체는 프레임워크가 하고 자국도 거기서 남는다" },
  { file: "src/commands/catalogWindow.ts", mark: "setTimeout(() => void invoke(\"window_close\", { label }), 30);", event: "self-destruct-reply-flush", why: "동일 계약(window.close 자기 창)" },
  { file: "src/commands/catalog.ts", mark: "await sleep(250);", event: "theme-css-cascade", why: "테마 클래스 전환 후 CSS 캐스케이드 반영 유예 — 브라우저가 완료 신호를 주지 않는다" },
  { file: "frameworks/tauri/src/clipboard.rs", mark: "SELF_WRITE_TTL: Duration = Duration::from_secs(2)", event: "self-write-ttl", why: "자기 쓰기 판별 시간창(TTL 상수) — 타이머가 아니라 판별 기준" },
  { file: "frameworks/tauri/src/window.rs", mark: "std::time::Duration::from_secs(5)", event: "reply-deadline", why: "다른 프로세스의 회신 상한 — 사건으로 끝날 수 없다(답 안 하는 상대가 이 부팅을 영원히 붙잡는다). 못 읽으면 복원을 건너뛴다" },
  { file: "crates/soksak-store/src/write_policy.rs", mark: "WRITE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(60)", event: "sqlite-write-backoff", why: "SQLITE_BUSY 재시도 백오프" },
  { file: "crates/soksak-store/src/ring.rs", mark: "MIN_INTERVAL: Duration = Duration::from_secs(3600)", event: "ring-prune-min-interval", why: "링 정리 최소 간격(유휴 하한)" },
  { file: "crates/soksak-store/src/ring.rs", mark: "busy_timeout(Duration::from_secs(5))", event: "sqlite-busy-timeout", why: "SQLite busy_timeout — DB 계약" },
  { file: "crates/soksak-net/src/transport.rs", mark: "timeout(Duration::from_secs(60))", event: "http-client-timeout", why: "원격 HTTP 상한 — 네트워크는 사건을 보장하지 않는다" },
  { file: "frameworks/tauri/src/webview.rs", mark: ".recv_timeout(std::time::Duration::from_secs(2))", event: "engine-surface-stats-reply", why: "메인 스레드 서피스 판독 회신 대기의 유한 안전장치 — 회신 채널이 사건이고 상한은 관측 명령의 무한 대기 방지" },
  { file: "frameworks/tauri/src/pty.rs", mark: "from_millis(400)", event: "ptyd-shutdown-grace", why: "옛 데몬의 종료 유예(응답 후 150ms) 계약을 넘긴다 — 재기동 1회 한정" },
  { file: "frameworks/tauri/src/pty.rs", mark: "from_millis(400)", event: "ptyd-socket-rebind", why: "구 데몬 소켓 해제→신 데몬 bind 사이 — 소켓 계승 신호가 없다" },
  { file: "frameworks/tauri/src/webview.rs", mark: "from_millis(450)", event: "wk-inspector-async-show", why: "WebKit _inspector show 는 비동기이고 완료 콜백이 없다(SPI)" },
  { file: "crates/soksak-daemon/src/lib.rs", mark: "from_millis(200)", event: "child-exit-poll", why: "일회 실행의 종료 대기 — child try_wait 유한 폴링(상한 초과 시 트리 종료). waitpid 블로킹은 출력 링 수집과 양립 불가" },
  { file: "crates/soksak-daemon/src/lib.rs", mark: "from_millis(300)", event: "child-exit-poll", why: "크래시 재시작 감시 — 동일 사유(몸)" },
  { file: "crates/soksak-schedule/src/lib.rs", mark: "Duration::from_secs(3_600)", event: "scheduler-idle-cap", why: "다음 예약 없음 상태의 유휴 상한(스케줄 등록이 즉시 깨운다)" },
  { file: "crates/soksak-watch/src/lib.rs", mark: "from_millis(250)", event: "fs-debounce", why: "파일와처 디바운스 — 이벤트 병합 창" },
  // ── 다른 프레임워크(Electron) — 규칙은 프레임워크를 가리지 않는다 ──
  { file: "frameworks/electron/backend.cjs", mark: "timer: setTimeout(() => pending.delete(id), timeoutMs),", event: "caller-specified", why: "선언의 답을 기다리는 자리 정리 — 상한은 호출자 지정 timeoutMs" },
  { file: "frameworks/electron/backend.cjs", mark: "const timer = setTimeout(() => {", event: "backend-answer", why: "백엔드 회신이 종결 사건이고 연결이 끊기면 그것이 끝낸다 — 이 상한은 둘 다 오지 않을 때 호출이 영영 안 끝나는 것을 막는다" },
  { file: "frameworks/electron/backend.cjs", mark: "const DEFAULT_TIMEOUT_MS = 30_000;", event: "backend-answer", why: "위 상한의 기본값 — 호출자가 timeoutMs 로 덮는다" },
  { file: "frameworks/electron/backend.cjs", mark: "const ENSURE_FLOOR_MS = 1000;", event: "store-owner-attached", why: "다시 붙는 것이 종결 사건이고 시도는 부를 일이 있을 때만 일어난다(폴링 아님) — 이 바닥은 주인이 안 서는 동안 호출 수만큼 스폰이 몰리는 것을 막는다. Tauri 쪽 REBUILD_FLOOR 와 같은 규칙" },
  { file: "frameworks/electron/cored.cjs", mark: "const DEFAULT_TIMEOUT_MS = 15_000;", event: "cored-ready-line", why: "cored 의 준비 완료 줄이 종결 사건이고 그 프로세스가 먼저 죽으면 종료가 끝낸다 — 둘 다 오지 않을 때 부팅이 영영 안 끝나는 것을 막는 안전망(Tauri 쪽 READY_LIMIT 과 같은 규칙)" },
  { file: "frameworks/electron/cored.cjs", mark: "const timer = setTimeout(", event: "cored-ready-line", why: "위 상한을 거는 자리 — 넘기면 우리가 띄운 프로세스를 거둔다(소켓 쥔 고아 방지)" },
  { file: "frameworks/electron/control.cjs", mark: "const RETRY_MS = 500;", event: "control-plane-attached", why: "다시 붙는 것이 종결 사건이고, 재접속을 부르는 것은 **끊김 사건**이다(폴링 아님) — 이 바닥은 cored 가 아직 안 섰을 때 붙기 시도가 몰리는 것을 막는다. 제거 조건 = cored 가 자기 기동을 알리는 사건을 주는 날" },
  { file: "frameworks/electron/control.cjs", mark: "retry = setTimeout(() => {", event: "control-plane-attached", why: "위 바닥을 거는 자리 — 끊김 사건이 부른다" },
  { file: "frameworks/electron/cored.cjs", mark: "const KILL_GRACE_MS = 2_000;", event: "child-exit", why: "SIGTERM 뒤 종료가 종결 사건 — 이 유예를 넘기면 SIGKILL. 유예가 없으면 정상 종료 경로를 못 밟는다" },
  { file: "frameworks/electron/cored.cjs", mark: "const hard = setTimeout(() => child.kill(\"SIGKILL\"), KILL_GRACE_MS);", event: "child-exit", why: "위 유예를 거는 자리" },
  // ── ③ 유한 안전망 ──
  { file: "frameworks/tauri/src/activity.rs", mark: "wait_timeout(q, Duration::from_secs(1))", event: "condvar-safety-net", why: "cv 사건이 주 경로 — 1s 는 closed 플래그 재확인 안전망" },
  { file: "crates/soksak-service/src/lib.rs", mark: "wait_timeout(inner, Duration::from_millis(20))", event: "condvar-safety-net", why: "크래시 전이가 cv 를 울린다 — 20ms 는 유실 안전망" },
  { file: "crates/soksak-sidecar-host/src/lib.rs", mark: "const INIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);", event: "engine-init-returned", why: "엔진 init 이 메인스레드에서 끝나는 것이 종결 사건이고, 이 상한은 그 사건이 영영 안 올 때 부팅이 멈춰 서지 않게 하는 안전망이다" },
  { file: "frameworks/tauri/src/sidecar.rs", mark: "recv_timeout(std::time::Duration::from_secs(2))", event: "native-surface-returned", why: "메인스레드에서 부모 표면을 재는 회신이 종결 사건 — 상한은 창이 답하지 않을 때 무한 대기 방지" },
  { file: "frameworks/tauri/src/webview.rs", mark: "recv_timeout(Duration::from_secs(3))", event: "main-thread-dispatch-cap", why: "메인스레드 디스패치 응답 상한(3s)" },
  { file: "frameworks/tauri/src/webview.rs", mark: "recv_timeout(Duration::from_secs(15))", event: "main-thread-dispatch-cap", why: "동일(15s — 콜드 부트 포함)" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_millis(150)", event: "pty.stream.reattached", why: "데몬 인계 전이(구 데몬 exit → 신 데몬 소켓 bind) 대기 — 세션 확인·재부착 성공이 종결, 상한 20회" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_secs(2)", event: "ptyd-bootstrap-handshake", why: "스폰 직후 소켓 준비 유한 재시도(2s 상한) — 감시는 소켓 에러 사건이 담당" },
  { file: "crates/soksak-core/src/ptyd.rs", mark: "from_millis(50)", event: "ptyd-bootstrap-handshake", why: "동일 루프의 재시도 간격" },
  { file: "frameworks/tauri/src/webview.rs", mark: "tokio::time::sleep(Duration::from_millis(400))", event: "extraction-page-settle", why: "추출용 임시 webview 의 페이지 정착 유한 재시도(timeout 상한)" },
  { file: "frameworks/tauri/src/cored_host.rs", mark: "const READY_LIMIT: Duration = Duration::from_secs(15);", event: "cored-ready-line", why: "cored 의 준비 완료 줄이 종결 사건이고(블로킹 read), 그 프로세스가 먼저 죽으면 EOF 가 끝낸다 — 이 상한은 둘 다 오지 않을 때 부팅이 영영 안 끝나는 것을 막는 안전망" },
  { file: "frameworks/tauri/src/cored_host.rs", mark: "const OWNER_ASK_LIMIT: Duration = Duration::from_secs(10);", event: "store-owner-answer", why: "주인의 회신이 종결 사건이고 연결이 끊기면 그것이 끝낸다 — 이 상한은 둘 다 오지 않을 때, 답하지 않는 주인 하나가 그 명령을 부른 창을 영영 붙잡는 것을 막는다" },
  { file: "frameworks/tauri/src/cored_host.rs", mark: "const REBUILD_FLOOR: Duration = Duration::from_secs(1);", event: "store-owner-attached", why: "다시 붙는 것이 종결 사건이고 시도는 **부를 일이 있을 때만** 일어난다(폴링 아님) — 이 바닥은 주인이 안 서는 동안 저장 요청 수만큼 스폰이 몰리는 것을 막는다. 제거 조건 = cored 가 자기 기동을 알리는 사건을 주는 날" },
];

/** grep -r 과 같은 순회 — 숨김/빌드 산출물은 grep 도 안 읽는 곳만 건너뛴다. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    // `build` 는 산출물이다 — 그 안에는 Electron 자신의 번들이 있어 내려가는 것만으로 수백
    // 메가를 읽는다(실측: 이 게이트가 5초 상한에 걸렸다). 걸러내기 전에 읽으면 이미 늦다.
    if (name === "node_modules" || name === "target" || name === "build" || name.startsWith("."))
      continue;
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

/** 질의1b — **다른 프레임워크의** 숫자 리터럴 타이머.
 *
 *  규칙은 프레임워크를 가리지 않는다. Tauri 만 보면 같은 기다림이 Electron 에서는 아무도 안
 *  보는 자리가 되고, 그 비대칭은 "저쪽은 되는데 이쪽은 안 된다"로만 나타난다. 두 프레임워크는
 *  동급이다 — 규칙도 동급으로 건다. */
function electronSites(): string[] {
  // 소스만 센다. 빌드 산출물(`build/`)에는 Electron 자신의 번들이 들어 있어, 그것까지 세면
  // 남의 코드 수백 줄이 우리 규칙 위반으로 보고된다 — 게이트가 자기 대상을 모르면 그 수는
  // 아무 뜻이 없다.
  return grepLines("frameworks/electron", /setTimeout\(|setInterval\(|_MS\s*=\s*[0-9]/)
    .filter((l) => /^frameworks\/electron\/[^:]*\.(c?js|mjs):/.test(l))
    .filter((l) => /[0-9]{2,}/.test(l));
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
    // 이관 목적지 — 여기가 뿌리에 없으면 프레임워크에서 옮긴 상한이 영영 안 세어진다.
    "crates/soksak-sidecar-host/src",
    "crates/soksak-service/src",
    "crates/soksak-schedule/src",
    "crates/soksak-daemon/src",
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

  it("다른 프레임워크에도 미등록 타이머가 없다 (frameworks/electron)", () => {
    expect(unregistered(electronSites())).toEqual([]);
  });
});

describe("예외는 사건 이름과 함께만 산다", () => {
  it("등록된 예외는 전부 종결 사건을 밝힌다 — 이름 없는 예외는 예외가 아니다", () => {
    const nameless = ALLOWED.filter((a) => !a.event.trim() || !a.why.trim()).map((a) => `${a.file} :: ${a.mark}`);
    expect(nameless).toEqual([]);
  });

  it("등록된 예외는 실재하는 자리를 가리킨다 — 사라진 자리를 표가 붙잡고 있지 않다", () => {
    // 세는 자리 **전부**를 본다. 하나라도 빠지면 그 프레임워크의 등록이 통째로 "사라진 자리"로
    // 보고되고, 표를 지우는 것이 GREEN 으로 보인다.
    const sites = [...tsSites(), ...rsSites(), ...electronSites()];
    const stale = ALLOWED.filter(
      (a) =>
        !sites.some(
          (s) => s.split(":")[0] === a.file && s.split(":").slice(2).join(":").includes(a.mark),
        ),
    ).map((a) => `${a.file} :: ${a.mark}`);
    expect(stale).toEqual([]);
  });
});
