// 범용 서브프로세스 capability — 임의 외부 프로그램을 raw stdio 로 띄우고 양방향 통신한다.
// PTY(pty.rs)와 달리 line discipline·echo·signal 가공이 없는 순수 파이프 → JSON-RPC(LSP/MCP/ACP)·
// 임의 CLI 통합 플러그인이 쓰는 범용 인터페이스다(특정 도구 락인 0). 플러그인 권한 "process" 게이트.
//
// 출력은 stdout/stderr 를 각각 별도 reader 스레드로 읽어 출구(StreamSink)로 스트리밍한다.
// 종료 코드는 stdout EOF 시점에 child.wait() 로 reaping 해 종료 출구(ExitSink)로 보낸다(폴링 없음 —
// pty.rs 와 동형으로 reader EOF 가 종료 신호). kill 은 공유 child 핸들을 잠가 보낸다(평시 reader 는
// out.read() 에서 블록 중이라 child 잠금이 비어 있어 즉시 가능).
//
// 스폰 본체(spawn_child)는 프레임워크 타입을 하나도 받지 않는다: 홈은 정체성(Identity)으로, 출구는
// 계약(StreamSink·ExitSink)으로, 창은 라벨 문자열로 온다. `#[tauri::command]` 는 State·Window·
// Channel 을 벗겨 그 값들로 옮기는 번역층이다.

use crate::stream_sink::{ChannelSink, ExitChannelSink};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::identity::Identity;
use crate::secrets::{self, SecretsState};
use crate::stream_sink::{Delivered, ExitSink, StreamSink};

// AI 세션 컨텍스트 env 정본 — 이걸 상속한 자식(claude 등)은 자기를 "에이전트 안의 에이전트"로
// 인식해 세션 식별이 비정상이 된다(트랜스크립트·중첩 가드). PTY(pty.rs)와 서브프로세스
// (scrub_ai_env)가 같은 목록을 쓴다 — 목록 추가는 여기 한 곳.
pub const AI_SESSION_ENV: [&str; 8] = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_EXECPATH",
    "CODEX_COMPANION_SESSION_ID",
    "AI_AGENT",
];

// 자식에 정당히 전달하는 SOKSAK_* 인터페이스(tmux $TMUX_PANE 계열 — 자식이 앱과 대화하는 핸들).
// 이 목록 밖의 SOKSAK_* 는 전부 내부 전용(볼트 마스터키·시크릿 페이로드·격리 볼트 경로·테스트 훅)
// 으로 간주해 상속 env 에서 벗긴다. 새 내부 SOKSAK_* 가 늘어도 기본 차단(fail-closed).
const SOKSAK_CHILD_ALLOW: [&str; 7] = [
    "SOKSAK_HOME",
    "SOKSAK_SOCKET",
    "SOKSAK_CALLER_TAB",
    "SOKSAK_PANE", // 이행 구간의 옛 이름 — 제거 조건: 모든 세션 교체
    "SOKSAK_WINDOW",
    "SOKSAK_PARENT",
    "SOKSAK_CLI_DIR",
];

// 부모 env 키 중 자식에서 제거할 내부 전용 SOKSAK_* 를 고른다. 순수 함수 — 실제 env 에 무관해
// 단위 테스트가 결정적이다. process 자식은 임의 비대화형 프로그램(LSP/MCP/ACP/CLI)이라 셸처럼
// 프로파일을 재소싱하지 않는다 — 그래서 전체 화이트리스트는 정당한 도구 env(프록시·언어 홈 등)를
// 깨뜨릴 위험이 크고, 표준은 승계하되 내부 SOKSAK_* 만 확실히 벗기는 denylist 를 쓴다.
fn internal_soksak_keys(keys: impl Iterator<Item = String>) -> Vec<String> {
    keys.filter(|k| k.starts_with("SOKSAK_") && !SOKSAK_CHILD_ALLOW.contains(&k.as_str()))
        .collect()
}

struct ProcessSession {
    child: Arc<Mutex<Child>>, // kill(세션) + EOF 후 wait(reader) 공유
    stdin: Option<ChildStdin>,
    // 신규 프로세스 그룹으로 스폰됨(group 옵션) — kill 이 그룹 전체(-pgid)를 겨눈다.
    group: bool,
    // detach(setsid)로 스폰됨 — 앱 종료를 넘어 산다. kill_all(앱 종료 회수)에서 제외된다.
    detached: bool,
    // 스폰한 창 label — 창 파괴 시 그 창의 자식을 회수하는 키(kill_by_window). 창이 죽으면
    // 파이프 소유자(그 창의 플러그인 런타임)가 사라지는데 파이프 자체는 앱이 계속 쥐고 있어
    // 자식에 EOF 가 가지 않는다 — 창 단위 회수가 없으면 침묵 좀비다.
    window: String,
    // 무엇을 돌리는가(해석된 실행 파일 + args). 목록 표면이 없으면 앱이 낳은 자식은 밖에서
    // 보이지 않는다 — 고아가 생겨도 아무도 모른다. 그래서 세션이 제 신원을 들고 있는다.
    cmd: String,
    // OS pid. 핸들 id(작은 카운터)와 다르다 — 둘을 혼동하면 "그 프로세스 살아있나" 를 물을 수 없다.
    pid: u32,
}

#[derive(Default)]
pub struct ProcessManager {
    sessions: Mutex<HashMap<u32, ProcessSession>>,
    next_id: Mutex<u32>,
}

impl ProcessManager {
    // 앱 종료 시: 모든 자식 kill(좀비 방지). 단 detached(생존 서비스 사이드카)는 제외 —
    // 앱보다 오래 사는 것이 그 존재 이유다(setsid 로 세션 분리됨, Child 핸들 드롭은 프로세스를
    // 죽이지 않는다). 나머지만 회수한다.
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, sess) in sessions.drain() {
                if !sess.detached {
                    kill_session(&sess);
                }
            }
        }
    }

    // 창 파괴 회수 — 그 창(플러그인 런타임)이 스폰한 자식을 거둔다(PTY kill_by_window 대칭).
    // detached(생존 서비스 사이드카)는 창 수명 밖이라 살리되, 소유 런타임이 사라져 핸들이
    // 도달 불가가 된 엔트리는 걷는다.
    pub fn kill_by_window(&self, label: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| s.window == label)
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                if let Some(sess) = sessions.remove(&id) {
                    if !sess.detached {
                        kill_session(&sess);
                    }
                }
            }
        }
    }
}

// 세션 종료 — group 스폰이면 그룹 전체(-pgid)를 먼저 겨눈다: 직계만 죽이면 손자(에이전트의
// Bash 자식 등)가 stdout 파이프를 물고 살아 EOF·exit 가 그들 수명만큼 지연된다(실측: stop 후
// CANCELLED 닫힘이 sleep 손자에 볼모). 직계 kill 은 폴백으로 항상 수행(멱등).
fn kill_session(sess: &ProcessSession) {
    #[cfg(unix)]
    if sess.group {
        if let Ok(c) = sess.child.lock() {
            unsafe {
                libc::killpg(c.id() as i32, libc::SIGKILL);
            }
        }
    }
    if let Ok(mut c) = sess.child.lock() {
        let _ = c.kill();
    }
}

// service 사이드카 이름 해석 — cmd "sidecar:{name}" → <identity 홈>/sidecars/soksak-sidecar-{name}/
// dist/soksak-sidecar-{name}. engine 모델(sidecar.rs module_path)과 대칭: 해석 경로는 identity 홈
// 하나뿐(A17 — env 바이너리 주입 없음), 이름은 traversal-safe 검증. 미존재는 spawn 전 명시 에러.
// "sidecar:" 아닌 cmd 는 그대로(일반 프로세스).
//
// 홈은 인자로 받은 정체성에서 나온다 — 전역을 읽으면 이 함수가 "나는 앱 프로세스다"를 전제한다.
pub(crate) fn resolve_sidecar_cmd(identity: &Identity, cmd: &str) -> Result<String, String> {
    let Some(name) = cmd.strip_prefix("sidecar:") else {
        return Ok(cmd.to_string());
    };
    let valid = !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!(
            "sidecar 이름 불법({name:?}) — ^[a-z0-9][a-z0-9-]*$"
        ));
    }
    let path = identity.path(format!(
        "sidecars/soksak-sidecar-{name}/dist/soksak-sidecar-{name}"
    ));
    if !path.is_file() {
        return Err(format!(
            "sidecar 미설치: {} — identity 홈에 dist 스테이징 필요(stage.sh)",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

// detached danger 게이트 — detached(부모 사망을 넘어 생존하는 새 세션 리더)는 선언된
// 사이드카("sidecar:{name}")에만 허용한다. 임의 프로그램의 detach 스폰은 앱 종료 후
// 회수 불가 좀비의 문(kill_all 제외 대상이 되므로). 생존 프로세스는 곧 사이드카다
// (SIDECARS.md — 상주 생존 서비스=서비스 사이드카)라, identity 홈에서 해석되는 사이드카
// 대상만 detach 를 여는 것이 구조적 잠금이다(A17). 비-detached 는 무제한.
pub(crate) fn detached_gate(cmd: &str, detached: bool) -> Result<(), String> {
    if detached && !cmd.starts_with("sidecar:") {
        return Err(
            "detached spawn is limited to sidecar: targets — a survival service must be a declared sidecar (A17)"
                .into(),
        );
    }
    Ok(())
}

// secret_env(envVar→secretKey)를 평문(envVar→평문)으로 해소 — spawn 전 일괄. 비어있으면 빈 벡터.
// 비어있지 않으면 ns 필수. 하나라도 잠김/미존재면 Err(미해소 시크릿이 자식으로 새지 않는다).
// 호출자가 결과를 Command env 로만 흘린다(평문은 Rust+자식 프로세스에만 — JS 반환 0, R2).
fn resolve_secret_env(
    secrets_state: &SecretsState,
    ns: Option<&str>,
    secret_env: &Option<HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    match secret_env {
        Some(map) if !map.is_empty() => {
            let ns = ns.ok_or("secret_env 주입에는 ns 필수")?;
            let mut out = Vec::with_capacity(map.len());
            for (env_var, secret_key) in map {
                let plain = secrets::resolve(secrets_state, ns, secret_key)?;
                out.push((env_var.clone(), plain));
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

// pump 종료 사유 — EOF(자식이 stdout 닫음=종료 진행)와 출구 사라짐(뷰 unmount 등, 자식은 살아있을
// 수 있음)을 구분한다. 이 구분이 데드락 회피의 핵심(아래 reader 참조).
enum PumpEnd {
    Eof,
    Closed,
}

// stdout/stderr 한쪽을 raw 바이트로 출구에 흘리는 reader 루프. 종료 사유를 반환한다.
fn pump<R: Read, S: StreamSink>(src: &mut R, sink: &S) -> PumpEnd {
    // 64KB — macOS 파이프 용량과 동급이라 한 번 read 로 파이프를 통째 비운다. 8KB 였을 때 대용량
    // 스트림(OSR 프레임 4MB)이 프레임당 ~512개 메시지로 쪼개져 프론트 콜백이 폭주했다.
    // 64KB 면 프레임당 read 횟수·메시지 수가 8× 줄어 프론트 IPC 오버헤드가 크게 준다.
    //
    // 전달 단위를 여기서 정하는 것은 의도다 — pty 의 배치(pty_delivery)와 달리 이쪽 소비자는
    // 프레임 경계를 기대하는 사이드카라, 배치가 경계를 바꾸면 안 된다.
    let mut buf = vec![0u8; 65536];
    loop {
        match src.read(&mut buf) {
            Ok(0) => return PumpEnd::Eof, // 자식이 stdout 닫음 → 종료 진행
            Ok(n) => {
                if sink.deliver(buf[..n].to_vec()) == Delivered::Gone {
                    return PumpEnd::Closed; // 출구 사라짐(뷰 unmount) — 자식은 아직 살아있을 수 있다
                }
            }
            Err(_) => return PumpEnd::Eof, // read 에러 = 파이프 끊김 → EOF 취급
        }
    }
}

// 남은 출력을 버리며 EOF 까지 읽는다. Channel 이 죽어 더는 스트리밍하지 않을 때, 자식 파이프가 가득
// 차서 자식이 write 에서 막히는 것(OSR sidecar 는 UI 스레드가 막혀 kill 도 안 먹는 상태)을 방지한다.
// child mutex 를 절대 잡지 않으므로, 이 함수가 (자식이 살아있어) 블록해도 process_kill 은 자유롭게 kill
// 할 수 있다 — kill 되면 자식이 죽어 EOF 가 오고 여기서 반환한다. 이것이 데드락 회피의 요체다.
fn drain<R: Read>(src: &mut R) {
    let mut buf = vec![0u8; 8192];
    loop {
        match src.read(&mut buf) {
            Ok(0) => break,    // EOF(자식 종료)
            Ok(_) => continue, // 버림
            Err(_) => break,
        }
    }
}

/// 스폰 요청 — 입구가 받은 값을 그대로 나른다. 프레임워크 타입(State·Window·Channel)은 여기 없다.
pub(crate) struct SpawnRequest {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    /// 부모 env 에서 제거할 키(설정 아닌 제거). 예: ACP 자식 에이전트에서 호스트 중첩 가드
    /// (CLAUDECODE)를 떼어내 "에디터가 띄운 독립 에이전트"로 동작시킨다. 병합(env)으론 못 하는
    /// unset 전용 경로.
    pub env_remove: Option<Vec<String>>,
    /// AI 세션 컨텍스트 env 8종(AI_SESSION_ENV 정본, PTY 와 동일) 일괄 제거. 호출자가 목록을
    /// 복제하지 않게 하는 스위치 — env_remove 와 합산 적용.
    pub scrub_ai_env: bool,
    /// 신규 프로세스 그룹으로 스폰(Unix) — kill 이 자식 트리 전체를 회수한다.
    pub group: bool,
    /// detach(setsid — 새 세션 리더)로 스폰. 부모(앱) 사망·터미널 시그널에서 분리돼 앱 종료를
    /// 넘어 산다. danger 게이트: "sidecar:" 대상에만 허용(detached_gate).
    pub detached: bool,
    /// 시크릿 주입 — ns(보통 플러그인 id) + secret_env(envVar→secretKey). 평문은 Rust 경계에서만
    /// 해소돼 자식 env 로 들어간다(JS·셸 args·ps 미노출 R2). secret_env 가 있으면 ns 필수.
    pub ns: Option<String>,
    pub secret_env: Option<HashMap<String, String>>,
    /// 스폰 창 label — 세션에 기록해 창 파괴 회수(kill_by_window)의 키로 쓴다.
    pub window: String,
}

/// 스폰 본체 — 정체성·출구·창 라벨만 받는다. 앱 프로세스를 전제하지 않는 유일한 이유는
/// 이 세 값이 전부 인자로 오기 때문이다(홈은 Identity, 출구는 StreamSink·ExitSink, 창은 문자열).
pub(crate) fn spawn_child<O, E, X>(
    identity: &Identity,
    req: SpawnRequest,
    manager: &ProcessManager,
    secrets_state: &SecretsState,
    on_stdout: O,
    on_stderr: E,
    on_exit: X,
) -> Result<u32, String>
where
    O: StreamSink,
    E: StreamSink,
    X: ExitSink,
{
    let SpawnRequest {
        cmd,
        args,
        cwd,
        env,
        env_remove,
        scrub_ai_env,
        group,
        detached,
        ns,
        secret_env,
        window,
    } = req;

    // 시크릿 평문 해소 — spawn 전에 전부 해소(하나라도 잠김/미존재면 spawn 0). Rust 경계에서만 평문 보유.
    let resolved_secrets = resolve_secret_env(secrets_state, ns.as_deref(), &secret_env)?;

    // detached danger 게이트 — 원본 cmd(스킴 해석 전)로 판정. "sidecar:" 대상만 detach 허용.
    detached_gate(&cmd, detached)?;

    // service 사이드카 해석 — cmd "sidecar:{name}" 을 identity 홈의 dist 진입점으로 치환(engine 의
    // sidecar.rs 와 대칭: 경로 해석은 코어 단일진실 소유, 플러그인은 이름만 안다 — A17/SIDECARS.md).
    let cmd = resolve_sidecar_cmd(identity, &cmd)?;

    let mut c = Command::new(&cmd);
    c.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 내부 전용 SOKSAK_*(볼트 마스터키·시크릿 페이로드·격리 볼트 경로·테스트 훅)를 상속 env 에서
    // 제거 — 자식(LSP/MCP/ACP/임의 CLI)이 앱 내부 시크릿을 물려받지 못하게 한다. 인터페이스
    // SOKSAK_* 는 allowlist 로 보존. 아래 SOKSAK_HOME 명시 주입·secret_env 주입은 이 제거 뒤라 무영향.
    for k in internal_soksak_keys(std::env::vars().map(|(k, _)| k)) {
        c.env_remove(k);
    }
    // 앱 주입 컨텍스트(A17) — 플러그인 자식이 identity 홈을 파생할 유일한 상시 경로. PTY 의
    // SOKSAK_SOCKET 주입과 같은 계열(소스주입 env 아님 — 앱이 자기 단일진실을 자식에 전파).
    // 자식이 홈을 아는 것은 정당하다. 다만 그 값은 인자로 받은 정체성에서 나온다 — 여기서
    // 전역을 읽으면 스폰하는 프로세스가 갈릴 때 같은 코드가 조용히 다른 홈을 물려준다.
    c.env("SOKSAK_HOME", identity.home());
    if let Some(cwd) = cwd {
        c.current_dir(cwd);
    }
    if let Some(env) = env {
        for (k, v) in env {
            c.env(k, v);
        }
    }
    if let Some(keys) = env_remove {
        for k in keys {
            c.env_remove(k);
        }
    }
    if scrub_ai_env {
        for k in AI_SESSION_ENV {
            c.env_remove(k);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if detached {
            // setsid: 새 세션 리더 → 부모(앱) 사망·제어 터미널 시그널에서 분리. group 과
            // 배타(setsid 자체가 새 세션·그룹 리더를 만든다 — group 리더면 setsid 는 EPERM).
            unsafe {
                c.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        } else if group {
            c.process_group(0); // pgid = 자식 pid — kill_session 이 그룹 전체를 겨눌 수 있게
        }
    }
    // 시크릿 평문은 일반 env 뒤에 주입(같은 키면 시크릿 우선). 평문은 이 Command env 와 자식에만 존재.
    for (k, v) in &resolved_secrets {
        c.env(k, v);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_pid = child.id();
    let child = Arc::new(Mutex::new(child));

    // stderr reader — 스트리밍. 출구가 사라지면 drain 으로 계속 비운다(자식 stderr 파이프가 차서
    // 자식이 write 에서 막히는 것 방지). child mutex 미접근.
    if let Some(mut err) = stderr {
        std::thread::spawn(move || {
            if let PumpEnd::Closed = pump(&mut err, &on_stderr) {
                drain(&mut err);
            }
        });
    }
    // stdout reader — 스트리밍 + 종료 후 reaping 으로 exit code.
    if let Some(mut out) = stdout {
        let child = child.clone();
        std::thread::spawn(move || {
            // 출구가 사라져도(뷰 unmount) 자식은 살아있을 수 있다. 그때 child mutex 를 잡은 채 wait()
            // 로 블록하면 process_kill 이 같은 mutex 에서 영구 대기(데드락) → 좀비 자식(과거 32GB swap
            // 폭주의 원인). 그래서 출구 사라짐이면 mutex 없이 drain 으로 EOF(자식 종료)를 기다린 뒤에만
            // wait() 한다 — drain 중엔 lock 이 비어 process_kill 이 즉시 kill 하고, kill 되면 EOF 가 와서
            // drain 이 반환한다.
            if let PumpEnd::Closed = pump(&mut out, &on_stdout) {
                drain(&mut out);
            }
            // 여기 도달 = stdout EOF(자식 종료 진행) → wait() 는 즉시 반환(짧은 lock → kill 경합 없음).
            let code = child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code())
                .unwrap_or(-1);
            // 종료는 스트림의 마지막 사건이다 — 소비자가 이미 사라졌어도 멈출 생산이 남아 있지
            // 않다. 그래서 사라짐을 값으로 받되 여기서 끝낸다.
            let _ = on_exit.deliver(code);
        });
    }

    let id = {
        let mut n = manager.next_id.lock().unwrap();
        *n += 1;
        *n
    };
    manager.sessions.lock().unwrap().insert(
        id,
        ProcessSession {
            child,
            stdin,
            group,
            detached,
            window,
            cmd: if args.is_empty() {
                cmd.clone()
            } else {
                format!("{} {}", cmd, args.join(" "))
            },
            pid: child_pid,
        },
    );
    Ok(id)
}

/// 웹뷰 입구 — State·Window·Channel 을 벗겨 값으로 옮기는 번역층. 인자 이름은 JS 계약이라
/// 그대로 둔다(여기가 바뀌면 호출자가 보는 답이 달라진다).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn process_spawn(
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    env_remove: Option<Vec<String>>,
    scrub_ai_env: Option<bool>,
    group: Option<bool>,
    detached: Option<bool>,
    ns: Option<String>,
    secret_env: Option<HashMap<String, String>>,
    on_stdout: Channel<InvokeResponseBody>,
    on_stderr: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    window: tauri::Window,
    manager: State<'_, ProcessManager>,
    secrets_state: State<'_, SecretsState>,
) -> Result<u32, String> {
    spawn_child(
        // 앰비언트 전역은 여기서 한 번 값으로 꺼낸다 — 경계의 이쪽 끝(identity.rs).
        &crate::identity::ambient(),
        SpawnRequest {
            cmd,
            args,
            cwd,
            env,
            env_remove,
            scrub_ai_env: scrub_ai_env.unwrap_or(false),
            group: group.unwrap_or(false),
            detached: detached.unwrap_or(false),
            ns,
            secret_env,
            window: window.label().to_string(),
        },
        manager.inner(),
        secrets_state.inner(),
        ChannelSink(on_stdout),
        ChannelSink(on_stderr),
        ExitChannelSink(on_exit),
    )
}

#[tauri::command]
pub fn process_write(
    id: u32,
    data: String,
    manager: State<'_, ProcessManager>,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such process")?;
    let stdin = session.stdin.as_mut().ok_or("stdin closed")?;
    stdin
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn process_stdin_close(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // stdin 만 닫는다(자식은 계속) — take → drop → 파이프 닫힘 → 자식이 EOF 수신. stdin 을 read_to_end
    // 하는 자식(파이프 입력 CLI)은 이 호출 없이는 영원히 블록한다. 이미 닫혔으면 no-op(멱등).
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such process")?;
    drop(session.stdin.take());
    Ok(())
}

/// 이 창의 앞선 플러그인 런타임이 남긴 자식을 거둔다. 창 파괴 회수(kill_by_window)와 같은
/// 규칙·같은 예외(detached 사이드카는 살린다)를 쓰되, 트리거가 다르다: 창은 살아 있고 그 안의
/// 런타임만 새로 선 경우(웹뷰 리로드·HMR·크래시 복구)를 위한 자리다. 새 런타임은 아직 아무것도
/// 스폰하지 않았으므로 이 시점에 이 창 앞으로 남은 것은 전부 앞선 런타임의 고아다.
#[tauri::command]
pub fn process_reclaim_window(window: tauri::Window, manager: State<'_, ProcessManager>) -> u32 {
    reclaim_window(manager.inner(), window.label())
}

/// 회수 본체 — 창은 라벨 문자열로 온다(창 객체를 쥘 필요가 없다).
pub(crate) fn reclaim_window(manager: &ProcessManager, label: &str) -> u32 {
    let before = manager
        .sessions
        .lock()
        .map(|s| s.values().filter(|x| x.window == label).count())
        .unwrap_or(0) as u32;
    manager.kill_by_window(label);
    before
}

/// 앱이 낳은 자식 프로세스 한 줄.
#[derive(serde::Serialize)]
pub struct ProcessInfo {
    /// 플러그인이 쥔 핸들 id(작은 카운터). OS pid 가 아니다.
    pub id: u32,
    /// OS pid — 이걸로만 "살아있나" 를 물을 수 있다.
    pub pid: u32,
    /// 스폰한 창 label. 창이 죽으면 이 키로 회수된다(kill_by_window).
    pub window: String,
    pub cmd: String,
    pub group: bool,
    pub detached: bool,
    /// 아직 살아있는가. 죽었는데 세션에 남아 있으면 그것이 곧 고아다.
    pub alive: bool,
}

/// 앱이 낳은 자식 프로세스 전부. 코어는 플러그인 대신 프로세스를 쥐고 있으면서 그 목록을
/// 내놓지 않았다 — 그래서 회수에 실패한 자식(고아)이 밖에서는 보이지 않았다. 읽기 전용.
#[tauri::command]
pub fn process_list(manager: State<'_, ProcessManager>) -> Vec<ProcessInfo> {
    let mut out = Vec::new();
    if let Ok(sessions) = manager.sessions.lock() {
        for (id, sess) in sessions.iter() {
            // try_wait 은 이미 끝난 자식을 거두면서 살아있음 여부를 준다(블록하지 않는다).
            let alive = sess
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok())
                .map(|status| status.is_none())
                .unwrap_or(false);
            out.push(ProcessInfo {
                id: *id,
                pid: sess.pid,
                window: sess.window.clone(),
                cmd: sess.cmd.clone(),
                group: sess.group,
                detached: sess.detached,
                alive,
            });
        }
    }
    out.sort_by_key(|p| p.id);
    out
}

#[tauri::command]
pub fn process_kill(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // 세션 제거 + 자식 kill(group 스폰이면 트리 전체). stdin 드롭 → stdin 닫힘. kill → stdout
    // EOF → reader 가 on_exit 발신.
    if let Some(session) = manager.sessions.lock().unwrap().remove(&id) {
        kill_session(&session);
    }
    Ok(())
}

// ── 테스트(secret_env 주입 실증) ─────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Identity;
    use crate::secrets::{test_state_with_secret, SecretsState};
    use crate::stream_sink::Delivered;

    // 계약만 구현한 테스트 출구 — Tauri 없이 스폰 코어를 끝까지 돌린다. 이 세 구현이
    // 컴파일되고 실제로 바이트·종료코드를 받는다는 사실이 "출구는 벤더 타입이 아니다"의 증명이다.
    struct Collect(Arc<Mutex<Vec<u8>>>);
    impl StreamSink for Collect {
        fn deliver(&self, bytes: Vec<u8>) -> Delivered {
            self.0.lock().unwrap().extend_from_slice(&bytes);
            Delivered::Ok
        }
    }

    struct Departed;
    impl StreamSink for Departed {
        fn deliver(&self, _bytes: Vec<u8>) -> Delivered {
            Delivered::Gone
        }
    }

    struct ExitTo(std::sync::mpsc::Sender<i32>);
    impl ExitSink for ExitTo {
        fn deliver(&self, code: i32) -> Delivered {
            match self.0.send(code) {
                Ok(()) => Delivered::Ok,
                Err(_) => Delivered::Gone,
            }
        }
    }

    /// 스폰 코어를 실제로 돌린다 — 프레임워크 타입(State·Window·Channel) 없이. 자식의 stdout
    /// 바이트와 종료 코드를 돌려준다.
    #[cfg(unix)]
    fn run_probe(identity: &Identity, script: &str) -> (Vec<u8>, i32) {
        let out = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = std::sync::mpsc::channel();
        let manager = ProcessManager::default();
        let secrets_state = SecretsState::default();
        let id = spawn_child(
            identity,
            SpawnRequest {
                cmd: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
                cwd: None,
                env: None,
                env_remove: None,
                scrub_ai_env: false,
                group: false,
                detached: false,
                ns: None,
                secret_env: None,
                window: "w-test".into(),
            },
            &manager,
            &secrets_state,
            Collect(out.clone()),
            Collect(Arc::new(Mutex::new(Vec::new()))),
            ExitTo(tx),
        )
        .expect("spawn");
        assert_eq!(id, 1, "핸들 id 는 1부터");
        let code = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("종료 코드가 출구로 건너와야 한다");
        let bytes = out.lock().unwrap().clone();
        (bytes, code)
    }

    // 자식이 받는 홈은 **주어진 정체성**의 홈이다 — 앰비언트 전역이 아니다. 이 프로세스의
    // 홈과 다른 값을 넘겨 그 차이를 자식의 stdout 으로 확인한다(전역을 읽으면 여기서 갈린다).
    #[cfg(unix)]
    #[test]
    fn the_child_home_comes_from_the_given_identity() {
        let home = std::env::temp_dir().join(format!("soksak-proc-identity-{}", std::process::id()));
        let identity = Identity::new(&home, "com.soksak.dev");
        let (bytes, code) = run_probe(&identity, "printf %s \"$SOKSAK_HOME\"");
        assert_eq!(String::from_utf8_lossy(&bytes), home.to_string_lossy());
        assert_ne!(
            home.as_path(),
            crate::home::soksak_home(),
            "이 프로세스의 홈과 달라야 시험이 성립한다"
        );
        assert_eq!(code, 0);
    }

    // 종료 코드는 바이트가 아니라 정수 하나로 건너간다 — 출구 타입이 그 사실을 지킨다.
    #[cfg(unix)]
    #[test]
    fn the_exit_code_crosses_as_one_integer() {
        let identity = Identity::new(std::env::temp_dir().join("soksak-proc-exit"), "com.soksak.dev");
        let (bytes, code) = run_probe(&identity, "printf out; exit 7");
        assert_eq!(&bytes, b"out");
        assert_eq!(code, 7);
    }

    // 소비자가 사라진 사실은 값으로 돌아온다 — 조용히 버리면 리더가 영원히 읽는다.
    #[test]
    fn a_departed_consumer_ends_the_pump() {
        let mut src = std::io::Cursor::new(b"hello".to_vec());
        assert!(matches!(pump(&mut src, &Departed), PumpEnd::Closed));
    }

    fn tmp_vault_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-proc-secret-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("secrets.vault")
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // 내부 전용 SOKSAK_* denylist — 볼트 마스터키·시크릿·격리 경로·테스트 훅은 제거되고,
    // 인터페이스 SOKSAK_* 와 표준(PATH 등)은 보존됨을 순수 함수 수준에서 못박는다. 자식(LSP/MCP/
    // ACP)에 앱 마스터 시크릿이 새지 않는다는 계약의 실증(process_spawn 이 이 목록으로 env_remove).
    #[test]
    fn internal_soksak_keys_strips_secrets_keeps_interface_and_standard() {
        let parent = [
            // 표준
            "PATH",
            "HOME",
            "USER",
            // 인터페이스 SOKSAK_*(보존)
            "SOKSAK_HOME",
            "SOKSAK_SOCKET",
            "SOKSAK_PANE",
            "SOKSAK_WINDOW",
            "SOKSAK_PARENT",
            "SOKSAK_CLI_DIR",
            // 내부 전용 SOKSAK_*(제거)
            "SOKSAK_VAULT_KEY",
            "SOKSAK_VAULT_PATH",
            "SOKSAK_SECRET_0",
            "SOKSAK_PTYD_BIN",
            "SOKSAK_ENV",
        ];
        let strip: std::collections::HashSet<String> =
            internal_soksak_keys(parent.iter().map(|s| s.to_string()))
                .into_iter()
                .collect();

        // (a) 내부 전용은 전부 제거 대상이다.
        for k in [
            "SOKSAK_VAULT_KEY",
            "SOKSAK_VAULT_PATH",
            "SOKSAK_SECRET_0",
            "SOKSAK_PTYD_BIN",
            "SOKSAK_ENV",
        ] {
            assert!(strip.contains(k), "내부 전용 {k} 는 제거돼야 한다");
        }
        // (b) 인터페이스·표준은 보존(제거 목록에 없음).
        for k in [
            "PATH",
            "HOME",
            "USER",
            "SOKSAK_HOME",
            "SOKSAK_SOCKET",
            "SOKSAK_PANE",
            "SOKSAK_WINDOW",
            "SOKSAK_PARENT",
            "SOKSAK_CLI_DIR",
        ] {
            assert!(!strip.contains(k), "{k} 는 보존돼야 한다");
        }
    }

    // service 사이드카 스킴 — 비스킴 통과 / 불법 이름 거부 / 미설치 명시 에러(경로 형태 포함).
    // 해석 기준은 인자로 받은 정체성의 홈이다 — 그 홈이 에러 메시지에 그대로 나온다.
    #[test]
    fn sidecar_scheme_resolution() {
        let id = Identity::new("/tmp/soksak-sidecar-home", "com.soksak.dev");
        assert_eq!(resolve_sidecar_cmd(&id, "/bin/sh").unwrap(), "/bin/sh");
        assert_eq!(resolve_sidecar_cmd(&id, "claude").unwrap(), "claude");
        assert!(resolve_sidecar_cmd(&id, "sidecar:").is_err());
        assert!(resolve_sidecar_cmd(&id, "sidecar:../evil").is_err());
        assert!(resolve_sidecar_cmd(&id, "sidecar:UPPER").is_err());
        let e = resolve_sidecar_cmd(&id, "sidecar:definitely-not-installed-xyz").unwrap_err();
        assert!(
            e.contains(
                "/tmp/soksak-sidecar-home/sidecars/soksak-sidecar-definitely-not-installed-xyz/dist/"
            ),
            "{e}"
        );
    }

    // resolve_secret_env + 실제 spawn — secret_env{SOKSAK_SECRET_0:apiKey} 를 자식 env 로 주입하고
    // /bin/sh -c 'printf %s "$SOKSAK_SECRET_0"' 의 stdout 을 캡처해 평문 일치 확인(자식 env 실주입).
    #[test]
    fn secret_env_injected_into_child() {
        let path = tmp_vault_path("inject");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "sk-real-9z");

        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        let resolved = resolve_secret_env(&state, Some("plugin-a"), &secret_env).unwrap();

        // process_spawn 과 동일하게 Command env 로만 주입(평문은 여기서만).
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "printf %s \"$SOKSAK_SECRET_0\""]);
        for (k, v) in &resolved {
            c.env(k, v);
        }
        let out = c.output().expect("spawn sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "sk-real-9z");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 빈/None secret_env → 빈 벡터(주입 없음), ns 불요.
    #[test]
    fn no_secret_env_is_empty() {
        let state = SecretsState::default();
        assert!(resolve_secret_env(&state, None, &None).unwrap().is_empty());
        assert!(resolve_secret_env(&state, None, &Some(HashMap::new()))
            .unwrap()
            .is_empty());
    }

    // secret_env 있는데 ns 없음 → Err(주입 0).
    #[test]
    fn secret_env_without_ns_rejected() {
        let path = tmp_vault_path("no-ns");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&state, None, &secret_env).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 데드락 회귀 — 스스로 끝나지 않고 stdout 을 계속 쏟는 자식(OSR sidecar 와 동형)을 reader 가 drain
    // 하는 동안(= Channel 죽음 이후 경로) 다른 스레드에서 child mutex 를 잠그고 kill 이 즉시 되는지.
    // 과거 버그: reader 가 child mutex 를 잡은 채 wait() 로 영구 블록 → process_kill 이 같은 mutex 에서
    // 영구 대기 → 좀비(32GB swap). drain 은 mutex 미보유이므로 kill 이 즉시 되어야 한다.
    #[test]
    fn kill_not_blocked_by_draining_reader() {
        use std::time::{Duration, Instant};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "while true; do echo x; done"]) // 스스로 안 끝남
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = child.stdout.take().unwrap();
        let child = Arc::new(Mutex::new(child));

        // reader: Channel 죽음 이후처럼 drain 으로 EOF(자식 종료) 대기 — mutex 미보유.
        let reader_child = child.clone();
        let reader = std::thread::spawn(move || {
            drain(&mut out); // 자식이 죽어야 반환
            let _ = reader_child.lock().ok().and_then(|mut c| c.wait().ok());
        });

        std::thread::sleep(Duration::from_millis(50)); // reader 가 drain 에 진입

        // process_kill 과 동일 경로: child mutex 잠그고 kill. 데드락이면 여기서 영구 블록.
        let t0 = Instant::now();
        {
            let mut c = child.lock().unwrap();
            let _ = c.kill();
        }
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "kill 은 즉시 반환해야 한다(reader 가 drain 중 mutex 를 안 잡음)"
        );

        reader.join().unwrap();
    }

    // 잠긴 볼트 → Err(spawn 0). 미존재 key → Err.
    #[test]
    fn locked_or_missing_rejected() {
        // 잠김 — unlock 안 한 기본 상태.
        let locked = SecretsState::default();
        let se = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&locked, Some("plugin-a"), &se).is_err());

        // 미존재 key.
        let path = tmp_vault_path("missing");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let bad = Some(map(&[("SOKSAK_SECRET_0", "nope")]));
        assert!(resolve_secret_env(&state, Some("plugin-a"), &bad).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // detached danger 게이트 — detach 는 "sidecar:" 대상에만. 임의 프로그램 detach 거부.
    #[test]
    fn detached_gate_limits_detach_to_sidecar_targets() {
        // 비-detached 는 무제한.
        assert!(detached_gate("/bin/sh", false).is_ok());
        assert!(detached_gate("claude", false).is_ok());
        // detached 는 선언된 사이드카 대상만.
        assert!(detached_gate("sidecar:terminal-alacritty", true).is_ok());
        assert!(detached_gate("/bin/sh", true).is_err());
        assert!(detached_gate("claude", true).is_err());
    }

    // kill_all(앱 종료 회수)은 일반 자식은 죽이고 detached(생존 서비스 사이드카)는 살린다.
    // 판정은 try_wait: 실행 중=None, 종료(킬됨)=Some. kill -0 은 좀비도 살아있다 보고하므로
    // 킬-좀비와 실행을 못 가른다 — try_wait 가 그 구분을 준다.
    #[cfg(unix)]
    #[test]
    fn kill_all_reaps_normal_but_spares_detached() {
        use std::os::unix::process::CommandExt;
        // 일반 자식.
        let normal = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        // detached 자식(setsid — process_spawn 의 detached 경로와 동일 기법).
        let mut det = Command::new("sleep");
        det.arg("30");
        unsafe {
            det.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let detached = det.spawn().expect("spawn detached sleep");

        // 판정용 Arc 핸들 클론을 남긴다(try_wait 로 상태 확인 + 정리).
        let normal_child = Arc::new(Mutex::new(normal));
        let detached_child = Arc::new(Mutex::new(detached));
        let mgr = ProcessManager::default();
        mgr.sessions.lock().unwrap().insert(
            1,
            ProcessSession {
                child: normal_child.clone(),
                stdin: None,
                group: false,
                detached: false,
                window: "w-test".into(),
                cmd: "test".into(),
                pid: 0,
            },
        );
        mgr.sessions.lock().unwrap().insert(
            2,
            ProcessSession {
                child: detached_child.clone(),
                stdin: None,
                group: false,
                detached: true,
                window: "w-test".into(),
                cmd: "test".into(),
                pid: 0,
            },
        );

        mgr.kill_all();
        std::thread::sleep(std::time::Duration::from_millis(200));

        // 일반 자식: 킬돼 종료 → try_wait 가 Some.
        assert!(
            normal_child.lock().unwrap().try_wait().unwrap().is_some(),
            "일반 자식은 kill_all 이 회수한다"
        );
        // detached: 안 죽고 계속 실행 → try_wait 가 None.
        assert!(
            detached_child.lock().unwrap().try_wait().unwrap().is_none(),
            "detached 는 kill_all 이 살린다(생존 서비스)"
        );

        // 정리 — 살아남은 detached 를 명시 종료·회수.
        let _ = detached_child.lock().unwrap().kill();
        let _ = detached_child.lock().unwrap().wait();
    }

    // 창 파괴 회수 — 그 창이 스폰한 일반 자식만 죽이고, 타 창 자식과 detached(생존 서비스)는
    // 살린다. 스폰 창이 죽으면 파이프 소유자(플러그인 런타임)가 사라져 자식에 stdin EOF 조차
    // 가지 않으므로(파이프는 앱 프로세스가 계속 쥔다) 창 단위 회수가 없으면 침묵 좀비가 된다.
    #[cfg(unix)]
    #[test]
    fn kill_by_window_reaps_that_windows_children_only() {
        use std::os::unix::process::CommandExt;
        let mine = Command::new("sleep").arg("30").spawn().expect("spawn");
        let other = Command::new("sleep").arg("30").spawn().expect("spawn");
        let mut det = Command::new("sleep");
        det.arg("30");
        unsafe {
            det.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let survivor = det.spawn().expect("spawn detached");

        let mine_child = Arc::new(Mutex::new(mine));
        let other_child = Arc::new(Mutex::new(other));
        let survivor_child = Arc::new(Mutex::new(survivor));
        let mgr = ProcessManager::default();
        {
            let mut sessions = mgr.sessions.lock().unwrap();
            sessions.insert(
                1,
                ProcessSession {
                    child: mine_child.clone(),
                    stdin: None,
                    group: false,
                    detached: false,
                    window: "w-a".into(),
                    cmd: "test".into(),
                    pid: 0,
                },
            );
            sessions.insert(
                2,
                ProcessSession {
                    child: other_child.clone(),
                    stdin: None,
                    group: false,
                    detached: false,
                    window: "w-b".into(),
                    cmd: "test".into(),
                    pid: 0,
                },
            );
            sessions.insert(
                3,
                ProcessSession {
                    child: survivor_child.clone(),
                    stdin: None,
                    group: false,
                    detached: true,
                    window: "w-a".into(),
                    cmd: "test".into(),
                    pid: 0,
                },
            );
        }

        mgr.kill_by_window("w-a");
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert!(
            mine_child.lock().unwrap().try_wait().unwrap().is_some(),
            "그 창의 일반 자식은 창 파괴가 회수한다"
        );
        assert!(
            other_child.lock().unwrap().try_wait().unwrap().is_none(),
            "타 창 자식은 무관하다"
        );
        assert!(
            survivor_child.lock().unwrap().try_wait().unwrap().is_none(),
            "detached 는 창 파괴에도 생존한다"
        );
        // 회수된 창의 엔트리는 detached 포함 전부 걷힌다(소유 런타임 소멸 = 핸들 도달 불가).
        assert!(
            mgr.sessions.lock().unwrap().keys().all(|id| *id == 2),
            "w-a 엔트리는 전부 제거되고 w-b 만 남는다"
        );

        // 정리 — 남은 자식 명시 종료·회수(좀비 방지).
        for child in [&other_child, &survivor_child] {
            let _ = child.lock().unwrap().kill();
            let _ = child.lock().unwrap().wait();
        }
        let _ = mine_child.lock().unwrap().wait();
    }
}
