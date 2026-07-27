// PTY 세션 관리 — daemon-first 라우터 + ACK 플로우 컨트롤.
//
// 세션 백엔드는 둘이다(app.pty 시그니처·명령명은 불변 — R7 seam):
//   Daemon  soksak-ptyd(코어 workspace 독립 바이너리)가 셸을 소유한다. 앱 종료·
//           재시작에도 셸과 자식이 같은 pid 로 생존하고, 같은 pane 재스폰은
//           createOrAttach 로 재부착되어 detach 동안의 출력(링)을 재생받는다.
//           플로우 컨트롤 워터마크는 데몬 쪽이 소유한다(ack 을 릴레이).
//   Local   기존 in-process 코드 그대로 — 데몬 확보 실패 시의 폴백 실체다.
//           폴백 진입은 activity 로 고지한다(무음 금지).
//
// 죽음 감지는 소켓 에러 이벤트다(폴링 0): 데몬이 죽으면 세션 stream 이 EOF/에러로
// 끊기고, control ping 한 번으로 "셸 정상 종료"와 "데몬 사망"을 가른 뒤 재스폰을
// 시도하고 고지한다.
//
// 플로우 컨트롤 워터마크는 soksak-spec-pty 가 단일진실이다(두 백엔드 공용):
//   - 미확인(unacked) 바이트가 HIGH 이상이면 reader 일시정지
//   - 프론트가 보낸 ack 로 unacked 가 LOW 이하로 떨어지면 재개
// 프론트는 xterm.write 콜백(파싱 완료)에서 5k 바이트마다 ack 를 보낸다.
// 값의 근거(윈도우=ack 루프 RTT 커버)는 proto 상수의 주석에 있다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use soksak_spec_pty::{HIGH_WATERMARK, LOW_WATERMARK};

use crate::identity::Identity;
use crate::pty_delivery::spawn_delivery;


struct FlowState {
    unacked: usize,
    paused: bool,
}

// in-process 백엔드(로컬 폴백 실체) — 데몬 이전의 원 구현 그대로.
struct LocalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    flow: Arc<(Mutex<FlowState>, Condvar)>,
}

enum Backend {
    Local(LocalSession),
    #[cfg(unix)]
    Daemon {
        // soksak-ptyd 세션 id — write/resize/ack/kill 은 control 소켓으로 릴레이된다.
        session: u64,
    },
}

pub struct PtySession {
    backend: Backend,
    // [R2] 관찰 substrate 타깃 키 — pty_pane_pid 가 이 키로 master 의 foreground pgid 를 찾는다.
    pane_id: Option<String>,
    // 창 폐기 reap 키(kill_by_window) — 사용자의 개별 창 닫기(B1 폐기 의미론)가 그 창의
    // 세션만 거둬 데몬에 유령 셸이 남지 않게 한다.
    window_label: Option<String>,
}

pub struct PtyManager {
    // 이 매니저가 겨누는 정체성. 데몬 control/stream 소켓·토큰·스테이징 바이너리·봉인
    // 체크포인트가 전부 이 홈에서 파생되므로, 정체성은 매니저의 **존재 조건**이지 호출
    // 인자가 아니다. 인자로 받으면 두 홈의 세션이 한 세션 맵에 섞일 수 있고, 그 조합은
    // 어느 identity 에도 없다(identity.rs 가 홈과 identifier 를 함께 나르는 것과 같은 이유).
    // 이 홈에서 파생되는 경로는 전부 데몬 레그의 것이고 그 레그는 unix 전용이라, 다른
    // 플랫폼에는 아직 읽는 자리가 없다.
    #[cfg_attr(not(unix), allow(dead_code))]
    identity: Identity,
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
    #[cfg(unix)]
    link: daemon::Link,
}

// spawn_terminal 결과. 화면 복원 판정은 코어를 떠났다(방출) — 소비자(플러그인)가 사이드카
// 복원 요청/봉인-블롭으로 스스로 그리고 스스로 안다. 코어는 세션 id 만 돌려준다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOutcome {
    pub id: u32,
}

// 화면 복원 제어(배관, 내용 불가지) — spawn 의 replay 파라미터. 코어는 페인트를 만들지도
// 해석하지도 않는다. 셋 중 하나:
//   부재(None): 데몬 미러 재생 + cold 체크포인트 주입(코어 소유, 기존 동작).
//   "none"(Mode): 소비자가 화면을 그렸다 — 코어는 복원하지 않고, 신선 세션의 재생을 버려
//     소비자가 그린 화면을 덮지 않는다(죽은 세션 cold 소비 경로).
//   {fromSeq}(FromSeq): 라이브 세션에 raw 링을 그 seq 부터 부착(레이스-프리 warm 핸드오프 —
//     소비자가 이미 그 seq 까지 그렸다). 데몬 미러 재생·cold 주입 없음.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum ReplayControl {
    Mode(String),
    FromSeq {
        #[serde(rename = "fromSeq")]
        from_seq: u64,
    },
}

// 봉인-블롭을 개봉한 평문(pty_read_sealed_screen 반환). 코어는 바이트를 해석하지 않는다 —
// paintB64 는 불투명 바이트고, 화면 의미(alt-screen 등)는 소비자가 해석한다(터미널 도메인).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedScreen {
    pub paint_b64: String,
}

impl PtyManager {
    /// 정체성 하나로 매니저를 세운다 — 링크도 같은 정체성으로 태어난다(한 생성자에서만
    /// 정해지므로 두 값이 어긋날 자리가 없다).
    pub(crate) fn new(identity: Identity) -> Self {
        PtyManager {
            #[cfg(unix)]
            link: daemon::Link::new(identity.clone()),
            identity,
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
        }
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn identity(&self) -> &Identity {
        &self.identity
    }

    // 앱 종료 시 호출(B1: 종료=보존): Daemon 세션은 detach 만 한다 — 셸과 자식은
    // soksak-ptyd 에서 계속 살고, 다음 부팅의 같은 pane 스폰이 재부착한다. Local
    // 세션(폴백)은 앱 프로세스가 소유하므로 kill 해 좀비를 막는다. Procfile 데몬·
    // process kill_all 은 이 함수 밖(불변 — 창 결속 계약).
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                match session.backend {
                    Backend::Local(mut s) => {
                        let (lock, cvar) = &*s.flow;
                        if let Ok(mut st) = lock.lock() {
                            st.paused = false;
                            cvar.notify_all();
                        }
                        let _ = s.child.kill();
                    }
                    #[cfg(unix)]
                    Backend::Daemon { session } => {
                        // 명시 detach(예의) — 앱 소켓이 곧 닫히므로 데몬은 어차피 EOF 로
                        // 부착을 해제한다. 실패해도 생존에는 영향 없다.
                        let _ = self
                            .link
                            .request(&soksak_spec_pty::Request::Detach { session }, false);
                    }
                }
            }
        }
    }

    // 사용자의 개별 창 닫기(폐기) — 그 창이 소유한 세션만 거둔다. 데몬 셸을 여기서
    // 죽이지 않으면 창은 사라졌는데 셸만 데몬에 남는 유령이 된다.
    pub fn kill_by_window(&self, label: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let victims: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| s.window_label.as_deref() == Some(label))
                .map(|(id, _)| *id)
                .collect();
            for id in victims {
                if let Some(session) = sessions.remove(&id) {
                    match session.backend {
                        Backend::Local(mut s) => {
                            let (lock, cvar) = &*s.flow;
                            if let Ok(mut st) = lock.lock() {
                                st.paused = false;
                                cvar.notify_all();
                            }
                            let _ = s.child.kill();
                        }
                        #[cfg(unix)]
                        Backend::Daemon { .. } => {} // 아래 KillByWindow 일괄이 처리
                    }
                }
            }
        }
        // 데몬 쪽은 라벨로 일괄 reap — 이 앱이 부착하지 않았던(예: 이전 실행이 남긴)
        // 세션까지 같은 키로 거둔다.
        #[cfg(unix)]
        {
            let _ = self.link.request(
                &soksak_spec_pty::Request::KillByWindow {
                    window_label: label.to_string(),
                },
                false,
            );
        }
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// 셸 통합 스크립트를 바이너리에 임베드.
const ZSH_INTEGRATION: &str = include_str!("../scripts/shell-integration.zsh");

// zsh 일 때 OSC 133/7 셸 통합을 주입한다. 임시 ZDOTDIR 에 .zshenv/.zshrc 를 써서
// 사용자 원본 설정을 먼저 source 한 뒤 통합 스크립트를 로드한다(사용자 설정 보존).
// 실패해도 통합만 빠질 뿐 셸은 정상 동작하므로 빈 목록을 돌려준다(에러 비전파).
// env 쌍을 돌려주는 순수한 형태 — Local(CommandBuilder)과 Daemon(env 목록 전송)이
// 같은 소스를 쓴다(단일 진실).
fn zsh_integration_env(shell: &str) -> Vec<(String, String)> {
    let is_zsh = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "zsh")
        .unwrap_or(false);
    if !is_zsh {
        return Vec::new();
    }

    let dir = std::env::temp_dir().join("vsterm-zdotdir");
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let integ = dir.join("shell-integration.zsh");
    if std::fs::write(&integ, ZSH_INTEGRATION).is_err() {
        return Vec::new();
    }

    let orig = std::env::var("ZDOTDIR")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();

    let zshenv = "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshenv\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshenv\"\n";
    let zshrc = format!(
        "[[ -f \"$VSTERM_ORIG_ZDOTDIR/.zshrc\" ]] && \
         source \"$VSTERM_ORIG_ZDOTDIR/.zshrc\"\n\
         ZDOTDIR=\"$VSTERM_ORIG_ZDOTDIR\"\n\
         source {:?}\n",
        integ.to_string_lossy()
    );
    if std::fs::write(dir.join(".zshenv"), zshenv).is_err()
        || std::fs::write(dir.join(".zshrc"), zshrc).is_err()
    {
        return Vec::new();
    }

    vec![
        ("VSTERM_ORIG_ZDOTDIR".to_string(), orig),
        ("ZDOTDIR".to_string(), dir.to_string_lossy().to_string()),
    ]
}

// env_clear 후 부모 env 에서 자식 셸로 승계할 표준 화이트리스트. 이 목록 밖(내부 시크릿
// SOKSAK_VAULT_KEY·SOKSAK_SECRET_*·격리 볼트 경로, 그 밖의 임의 비밀)은 원천 차단된다. 대화형
// 셸은 프로파일(.zshrc 등)을 재소싱하므로 최소 승계로도 정상 동작한다 — 그래서 프로파일이 세팅하지
// 않는 런타임 핸들(SSH 에이전트·X/Wayland 세션)만 골라 담는다. SOKSAK_* 인터페이스와 TERM/COLORTERM
// 은 build_session_env 가 명시 주입한다(여기 중복 불필요).
const SHELL_ENV_ALLOW: &[&str] = &[
    // 셸·계정 기본
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    // 터미널·로케일(TERM/COLORTERM 은 build_session_env 가 덮어씀)
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "COLORTERM",
    "TERMINFO",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    // 에디터·페이저
    "EDITOR",
    "VISUAL",
    "PAGER",
    // SSH 사용 케이스 — 프로파일이 세팅하지 않는 에이전트·연결 핸들(SSH 세션에서 필수)
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "SSH_TTY",
    // Linux 세션/디스플레이 — 프로파일이 세팅하지 않는 런타임 핸들
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "GPG_TTY",
];

// 승계 대상 판정 — LC_* 로케일 카테고리는 접두 매칭, 나머지는 정확 일치.
fn is_shell_safe_env_key(k: &str) -> bool {
    SHELL_ENV_ALLOW.contains(&k) || k.starts_with("LC_")
}

// 부모 env 에서 대화형 셸에 정당한 표준 변수만 골라낸다. 순수 함수 — 실제 env 에 무관해 단위
// 테스트가 결정적이다. 이것이 화이트리스트의 단일 진실(Local·Daemon 백엔드가 같은 목록을 쓴다).
fn shell_safe_base_env<I: Iterator<Item = (String, String)>>(vars: I) -> Vec<(String, String)> {
    vars.filter(|(k, _)| is_shell_safe_env_key(k)).collect()
}

// 세션 env 조립 — 두 백엔드의 단일 소스. 터미널은 신선한 셸 컨텍스트여야 한다:
// soksak 을 claude(Claude Code) 세션 안에서 띄우면 claude 가 주입한 세션 env 가
// PTY 로 새어 터미널의 claude 가 자기를 중첩 자식 세션으로 오인한다 — AI 세션
// 컨텍스트 env 를 제거해 항상 최상위 세션으로 시작하게 한다(목록 정본은
// process.rs AI_SESSION_ENV). SOKSAK_* 주입은 AI 명령 인터페이스 컨텍스트
// 로, 자식이 자기가 붙은 pane 을 이름으로 알게 한다.
fn build_session_env(
    shell: &str,
    pane_id: &Option<String>,
    window_label: &Option<String>,
) -> (Vec<(String, String)>, Vec<String>) {
    // env_clear 후 이 목록만 자식 셸에 주입된다(양 백엔드 공통). 부모 env 에서 표준 화이트리스트만
    // 승계 — 내부 시크릿(SOKSAK_VAULT_KEY 등)은 목록 밖이라 자식으로 새지 않는다. TERM/COLORTERM 은
    // 승계값을 무시하고 아래에서 고정 주입한다.
    let mut env: Vec<(String, String)> = shell_safe_base_env(std::env::vars());
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    if let Some(pane) = pane_id {
        // 호출자 문맥 축 — "터미널 안 내 위치"다. 옛 이름 SOKSAK_PANE 은 뜻이 뒤집힌
        // 세대(pane=탭 인스턴스)의 잔재라 SOKSAK_CALLER_TAB 으로 개명한다(IDENTITY §3).
        // 이행 구간: 둘 다 주입한다 — PTY 는 spawn 시점 env 가 고정이라 기존 셸이 옛
        // 이름을 들고 있고, 외부 스크립트도 옛 이름을 읽을 수 있다.
        // 제거 조건: 모든 세션 교체(옛 이름을 읽는 세션 소멸).
        env.push(("SOKSAK_CALLER_TAB".into(), pane.clone()));
        env.push(("SOKSAK_PANE".into(), pane.clone()));
    }
    // 멀티윈도우: 내 창 label 주입(PANE 과 대칭) — 빈 문자열은 미주입.
    if let Some(w) = window_label.as_deref().filter(|w| !w.is_empty()) {
        env.push(("SOKSAK_WINDOW".into(), w.to_string()));
    }
    if let Some(sock) = crate::ipc::socket_path() {
        env.push(("SOKSAK_SOCKET".into(), sock.to_string()));
    }
    env.extend(zsh_integration_env(shell));
    let env_remove: Vec<String> = crate::process::AI_SESSION_ENV
        .iter()
        .map(|k| k.to_string())
        .collect();
    (env, env_remove)
}

// 세션 등록 단일 진실 — id 발급 + 세션 맵 삽입. 데몬/로컬 백엔드가 같은 경로를 쓴다.
// lock 오염은 패닉 전파 대신 복구한다: 한 세션 스레드의 패닉이 매니저를 영구
// 잠그지 않게(카운터·맵은 오염돼도 유효한 값이다).
fn register_session(manager: &PtyManager, session: PtySession) -> u32 {
    let id = {
        let mut n = manager.next_id.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    };
    manager
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, session);
    id
}

#[tauri::command]
pub fn spawn_terminal(
    app: tauri::AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    pane_id: Option<String>,
    window_label: Option<String>,
    replay: Option<ReplayControl>,
    on_output: Channel<InvokeResponseBody>,
    manager: State<'_, PtyManager>,
) -> Result<SpawnOutcome, String> {
    let shell = shell.unwrap_or_else(default_shell);
    let (env, env_remove) = build_session_env(&shell, &pane_id, &window_label);

    // daemon-first: soksak-ptyd 가 셸을 소유하면 앱 재시작을 넘어 생존한다. 확보
    // 실패는 로컬 폴백으로 계속하되 activity 로 고지한다(무음 금지). pane 없는
    // 세션은 재부착 키가 없으므로 조용히 로컬이다(폴백 아님 — 고지 없음).
    #[cfg(unix)]
    if pane_id.is_some() {
        match daemon::spawn_via_daemon(
            &app,
            &manager.link,
            daemon::SpawnParams {
                pane_id: pane_id.clone(),
                window_label: window_label.clone(),
                cols,
                rows,
                cwd: cwd.clone(),
                shell: shell.clone(),
                env: env.clone(),
                env_remove: env_remove.clone(),
                replay: replay.clone(),
            },
            on_output.clone(),
        ) {
            Ok(session) => {
                let id = register_session(
                    manager.inner(),
                    PtySession {
                        backend: Backend::Daemon { session },
                        pane_id,
                        window_label,
                    },
                );
                return Ok(SpawnOutcome { id });
            }
            Err(e) => daemon::notify_fallback(&app, &manager.link, &e),
        }
    }
    #[cfg(not(unix))]
    let _ = &app;

    // ── 로컬 폴백(in-process) — 원 구현 그대로 ─────────────────────────────
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell.clone());
    // 부모 env 를 통째 비운 뒤 화이트리스트(build_session_env)만 주입한다 — 상속으로 새던 내부
    // 시크릿(SOKSAK_VAULT_KEY 등)을 원천 차단하는 fail-closed 순서. env_remove 는 뒤따르는
    // belt-and-suspenders(화이트리스트 밖이라 이미 부재).
    cmd.env_clear();
    for k in &env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave 핸들은 더 이상 필요 없다. 닫아야 자식 종료 시 master 가 EOF 를 받는다.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let flow = Arc::new((
        Mutex::new(FlowState {
            unacked: 0,
            paused: false,
        }),
        Condvar::new(),
    ));

    // reader 스레드: blocking read 루프. paused 면 condvar 에서 대기.
    {
        let flow = flow.clone();
        let on_output = on_output.clone();
        std::thread::spawn(move || {
            // 전달 단위는 read 단위가 아니다 — 크로싱은 배치가 소유한다(spawn_delivery).
            let (deliver, delivery) = spawn_delivery(on_output);
            let mut buf = vec![0u8; 8192];
            loop {
                // 일시정지 상태면 ack 로 깨어날 때까지 대기.
                {
                    let (lock, cvar) = &*flow;
                    let mut st = lock.lock().unwrap();
                    while st.paused {
                        st = cvar.wait(st).unwrap();
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF (셸 종료)
                    Ok(n) => {
                        if deliver.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                        // 플로우 회계는 읽은 바이트 기준 — 배치가 언제 나가든 창은 같다.
                        let (lock, _) = &*flow;
                        let mut st = lock.lock().unwrap();
                        st.unacked += n;
                        if st.unacked >= HIGH_WATERMARK {
                            st.paused = true;
                        }
                    }
                    Err(_) => break,
                }
            }
            drop(deliver); // 마지막 부분 배치를 내보내고 끝난다
            let _ = delivery.join();
        });
    }

    let id = register_session(
        manager.inner(),
        PtySession {
            backend: Backend::Local(LocalSession {
                writer,
                master: pair.master,
                child,
                flow,
            }),
            pane_id,
            window_label,
        },
    );
    Ok(SpawnOutcome { id })
}

// [R2] pane 의 foreground 프로세스 그룹 pid — 그 PTY 에서 지금 실행 중인 명령(claude/codex 등)의 pgid.
// command.started 직후 호출하면 막 시작한 명령의 pid 다(best-effort — exec 직전 레이스면 셸 pgid/None).
// AI 세션 추적의 sessionId 와 짝(command/pid/sessionId). 없으면 null.
#[tauri::command]
pub fn pty_pane_pid(pane_id: String, manager: State<'_, PtyManager>) -> Option<i32> {
    // 락을 쥔 채 데몬 요청을 보내지 않는다 — 백엔드 종류만 판별하고 락을 놓는다.
    let daemon_backed = {
        let sessions = manager.sessions.lock().ok()?;
        let mut daemon_backed = false;
        for s in sessions.values() {
            if s.pane_id.as_deref() == Some(pane_id.as_str()) {
                match &s.backend {
                    Backend::Local(l) => {
                        // process_group_leader 는 portable-pty 의 unix 전용 API. windows(ConPTY)엔
                        // 프로세스 그룹 리더 개념이 없어 None(호출부는 fg 프로세스 조회 실패로 취급).
                        #[cfg(unix)]
                        return l.master.process_group_leader();
                        #[cfg(not(unix))]
                        {
                            let _ = l;
                            return None;
                        }
                    }
                    #[cfg(unix)]
                    Backend::Daemon { .. } => {
                        daemon_backed = true;
                        break;
                    }
                }
            }
        }
        daemon_backed
    };
    #[cfg(unix)]
    if daemon_backed {
        let v = manager
            .link
            .request(&soksak_spec_pty::Request::PanePid { pane_id }, false)
            .ok()?;
        return v.get("pid").and_then(|p| p.as_i64()).map(|p| p as i32);
    }
    #[cfg(not(unix))]
    let _ = daemon_backed;
    None
}

// 이 pane 에 라이브 데몬 세션이 있는가 — warm 복원 후보 판정. 데몬에 직접 물어(사이드카 무관,
// 즉답) 앱 세션 추적을 거치지 않는다: 재시작 복원은 소비자가 스폰하기 '전'에 판정해야 하는데
// 그 시점엔 앱이 아직 이 pane 세션을 안 잡았다(스폰이 잡는다). 데몬 미가동/세션 없음 = false
// (spawn_if_needed=false — 조회가 데몬을 새로 안 띄운다). 소비자는 이걸로 사이드카 복원 재개
// (부팅-레이스 유계 재시도)를 warm 후보에만 태운다 — 신선/cold 는 사이드카를 안 기다린다.
#[tauri::command]
pub fn pty_pane_alive(pane_id: String, manager: State<'_, PtyManager>) -> bool {
    #[cfg(unix)]
    {
        return manager
            .link
            .request(&soksak_spec_pty::Request::PanePid { pane_id }, false)
            .is_ok();
    }
    #[cfg(not(unix))]
    {
        let _ = (pane_id, manager);
        false
    }
}

// 서비스 사이드카(생존 미러) 서비스 소켓에 NDJSON 요청/응답 1왕복을 릴레이한다. 코어는
// request/응답 JSON 을 해석하지 않는다(내용 불가지 다리 — 웹뷰 JS 가 UDS 를 못 여는 것을
// 코어가 대신 연결). request 에 실린 window 는 소비자가 스탬프한 라우팅 좌표다(spawn 동형).
#[tauri::command]
pub fn pty_sidecar_request(
    request: serde_json::Value,
    manager: State<'_, PtyManager>,
) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        // 사이드카 소켓은 데몬과 같은 run 디렉토리에 있다 — 홈은 매니저의 정체성에서 온다.
        daemon::sidecar_service_relay(manager.identity(), &request)
    }
    #[cfg(not(unix))]
    {
        let _ = (&request, &manager);
        Err("service sidecar relay is unix-only".into())
    }
}

// 이 pane 의 봉인-블롭을 앱 볼트로 개봉해 평문 페인트(base64)를 돌려준다.
// 잠금=명시 에러(fail-closed), 블롭 없음=None. 소비자(터미널 플러그인)가 죽은 세션 화면을
// 다시 그리는 cold 경로(사이드카 불요). 코어는 봉인만 열고 바이트를 해석하지 않는다.
#[tauri::command]
pub fn pty_read_sealed_screen(
    app: tauri::AppHandle,
    window_label: Option<String>,
    pane_id: String,
    // 이행 구간의 옛 키(엔티티 id 마이그레이션이 탭 레코드에 심은 legacyPaneId).
    // 신 키의 블롭이 없을 때만 이 키로 폴백한다 — 손실 0 계약(IDENTITY·P0-5)의 실행부.
    // 제거 조건: 그 블롭의 재봉인(adopt) 완료.
    legacy_pane_id: Option<String>,
    manager: State<'_, PtyManager>,
) -> Result<Option<SealedScreen>, String> {
    #[cfg(unix)]
    {
        let win = window_label.as_deref().unwrap_or("");
        let identity = manager.identity();
        match daemon::read_sealed_screen(&app, identity, win, &pane_id)? {
            Some(s) => Ok(Some(s)),
            None => match legacy_pane_id {
                Some(legacy) if !legacy.is_empty() => {
                    daemon::read_sealed_screen_adopting(&app, identity, win, &legacy, &pane_id)
                }
                _ => Ok(None),
            },
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (&app, &window_label, &pane_id, &legacy_pane_id, &manager);
        Ok(None)
    }
}

#[tauri::command]
pub fn write_terminal(id: u32, data: String, manager: State<'_, PtyManager>) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such terminal")?;
    match &mut session.backend {
        Backend::Local(s) => {
            s.writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            s.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        #[cfg(unix)]
        Backend::Daemon { session } => {
            use base64::Engine as _;
            let req = soksak_spec_pty::Request::Write {
                session: *session,
                data_b64: base64::engine::general_purpose::STANDARD.encode(data.as_bytes()),
            };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn resize_terminal(
    id: u32,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    match &session.backend {
        Backend::Local(s) => s
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string()),
        #[cfg(unix)]
        Backend::Daemon { session } => {
            let req = soksak_spec_pty::Request::Resize {
                session: *session,
                cols,
                rows,
            };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn ack_terminal(id: u32, bytes: usize, manager: State<'_, PtyManager>) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such terminal")?;
    match &session.backend {
        Backend::Local(s) => {
            let (lock, cvar) = &*s.flow;
            let mut st = lock.lock().unwrap();
            st.unacked = st.unacked.saturating_sub(bytes);
            if st.paused && st.unacked <= LOW_WATERMARK {
                st.paused = false;
                cvar.notify_all();
            }
            Ok(())
        }
        #[cfg(unix)]
        Backend::Daemon { session } => {
            let req = soksak_spec_pty::Request::Ack {
                session: *session,
                bytes: bytes as u64,
            };
            drop(sessions);
            manager.link.request(&req, false).map(|_| ())
        }
    }
}

#[tauri::command]
pub fn close_terminal(id: u32, manager: State<'_, PtyManager>) -> Result<(), String> {
    if let Some(session) = manager.sessions.lock().unwrap().remove(&id) {
        match session.backend {
            Backend::Local(mut s) => {
                // 일시정지된 reader 를 깨워 EOF 를 받고 종료하도록 한다.
                {
                    let (lock, cvar) = &*s.flow;
                    let mut st = lock.lock().unwrap();
                    st.paused = false;
                    cvar.notify_all();
                }
                let _ = s.child.kill();
                // session 드롭 → writer/master 닫힘 → reader EOF.
            }
            #[cfg(unix)]
            Backend::Daemon { session } => {
                // pane 닫기 = 폐기(B1) — 데몬 셸을 죽인다. 링크가 죽어 있으면 best-effort
                // (데몬도 함께 죽었다면 세션도 없다).
                let _ = manager
                    .link
                    .request(&soksak_spec_pty::Request::Kill { session }, false);
            }
        }
    }
    Ok(())
}

// ── PTY 세션 데몬 관측·재기동 — command registry(pty.daemon.*)의 실행기 ────────
// 관측(status)은 데몬을 새로 띄우지 않는다(spawn_if_needed=false — 조회가 데몬을
// 부풀리지 않는다). 재기동(restart)은 파괴적이다: 데몬 소유 셸과 그 자식 전부가
// 죽는다 — 카탈로그의 danger 게이트 뒤에만 노출된다.

#[tauri::command]
pub fn pty_daemon_status(manager: State<'_, PtyManager>) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use serde_json::json;
        let staged = soksak_spec_pty::staged_bin_path(manager.identity().home());
        let (running, pid, sessions, contract) =
            match manager.link.request(&soksak_spec_pty::Request::Ping, false) {
                Ok(v) => (
                    true,
                    v["pid"].as_u64(),
                    v["sessions"].as_u64(),
                    v["handoffContract"].as_u64(),
                ),
                Err(_) => (false, None, None, None),
            };
        Ok(json!({
            "running": running,
            "pid": pid,
            "sessions": sessions,
            "protocol": soksak_spec_pty::PTYD_PROTOCOL_VERSION,
            // 도는 데몬이 선언한 안전 인계 계약 수준(없음 = 계약 이전 판). 판올림 가능
            // 여부가 이 값 하나로 밖에서 읽힌다 — 시도해 보고 아는 것이 아니라.
            "handoffContract": contract,
            "handoffContractRequired": soksak_spec_pty::PTYD_HANDOFF_CONTRACT,
            "staged": staged.exists(),
            "stagedPath": staged.to_string_lossy(),
        }))
    }
    #[cfg(not(unix))]
    {
        let _ = manager;
        Ok(serde_json::json!({
            "running": false,
            "supported": false,
            "protocol": soksak_spec_pty::PTYD_PROTOCOL_VERSION,
        }))
    }
}

#[tauri::command]
pub fn pty_daemon_restart(manager: State<'_, PtyManager>) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use serde_json::json;
        // 살아 있으면 종료(전 세션 kill — 파괴적임을 카탈로그가 게이트한다).
        let killed = manager
            .link
            .request(&soksak_spec_pty::Request::Shutdown, false)
            .ok()
            .and_then(|v| v["killed"].as_u64())
            .unwrap_or(0);
        // 옛 데몬의 종료 유예(응답 후 150ms)를 넘겨 싱글턴 프로브 오인을 피한다 —
        // 재기동 1회 한정의 유한 대기(상시 감시 아님).
        std::thread::sleep(std::time::Duration::from_millis(400));
        let v = manager
            .link
            .request(&soksak_spec_pty::Request::Ping, true)?;
        Ok(json!({ "killed": killed, "pid": v["pid"] }))
    }
    #[cfg(not(unix))]
    {
        let _ = manager;
        Err("the PTY daemon is unix-only in this generation".to_string())
    }
}

// 데몬 무중단 업그레이드(HS1) — restart 와 달리 라이브 세션을 죽이지 않는다. 새 판(앱 형제
// soksak-ptyd)을 홈 bin/ 에 원자 스테이징한 뒤 PrepareUpgrade 로 현 데몬이 새 데몬을 fd
// 상속으로 스폰하게 한다. 셸은 SIGHUP 없이 새 데몬으로 넘어간다(ptyd do_handoff, HS2). updater
// 오케스트레이터가 앱 relaunch 전에 호출하거나, ptyd 판올림만 반영할 때 단독 호출한다.
#[tauri::command]
pub fn pty_daemon_upgrade(
    app: tauri::AppHandle,
    manager: State<'_, PtyManager>,
) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use serde_json::json;
        // 인계 계획은 **나가는** 데몬이 세운다. 그 판이 안전 인계 계약을 구현하지 않으면
        // 셸이 죽거나(대상 fd 충돌) 출력이 조용히 멎는다(링 좌표 유실). 못 지키는 상대에게
        // 시켜 놓고 결과를 사람이 감당하게 두지 않는다 — 시도 전에 묻고, 못 하면 거절한다.
        let before = manager
            .link
            .request(&soksak_spec_pty::Request::Ping, true)?;
        let before_pid = before["pid"].as_u64();
        if let Err(why) = daemon::handoff_precheck(&before) {
            crate::activity::publish(
                &app,
                "pty.daemon.upgrade.refused",
                "core",
                json!({ "reason": why, "pid": before_pid }),
            );
            return Err(why);
        }
        // 새 판을 홈 bin/ 에 원자 교체 — 새 데몬이 이 경로에서 실행된다(해시 동일이면 no-op).
        let staged = daemon::stage_binary(manager.identity().home())?;
        let staged_str = staged.to_string_lossy().to_string();
        // PrepareUpgrade — 데몬이 새 데몬을 fd 상속으로 스폰하고 exit(응답 없이 소켓 EOF).
        // 라이브 세션은 SIGHUP 없이 넘어간다.
        let _ = manager.link.request(
            &soksak_spec_pty::Request::PrepareUpgrade {
                new_bin: staged_str,
            },
            false,
        );
        // 이전 데몬이 exit 해 소켓을 놓고 새 데몬이 그 소켓을 bind 하도록 짧게 대기한 뒤,
        // Ping 으로 새 데몬의 pid 를 확인한다(link 가 재연결).
        std::thread::sleep(std::time::Duration::from_millis(400));
        let v = manager
            .link
            .request(&soksak_spec_pty::Request::Ping, true)?;
        // 같은 데몬이 대답하면 아무것도 넘어가지 않은 것이다 — "upgraded: true" 라고 말하지
        // 않는다(옛 판은 pid 를 대조하지 않아, 아무 일도 일어나지 않은 경우에도 성공이라 했다).
        let after_pid = v["pid"].as_u64();
        if after_pid.is_some() && after_pid == before_pid {
            return Err(format!(
                "the daemon did not change (still pid {}) — the live upgrade did not happen",
                after_pid.unwrap_or(0)
            ));
        }
        Ok(json!({ "upgraded": true, "pid": v["pid"], "sessions": v["sessions"] }))
    }
    #[cfg(not(unix))]
    {
        let _ = (app, manager);
        Err("the PTY daemon is unix-only in this generation".to_string())
    }
}

// 사용자 로그인 셸 PATH 기준 바이너리 존재 확인 — GUI 앱의 좁은 PATH 로는
// 사용자가 쓰는 CLI 를 못 찾는다(설치 판정의 단일 기준 = 사용자 셸).
// 플러그인 프로그램 ensure(§2.6)가 활성화 시점에 호출한다.
#[tauri::command]
pub fn shell_which(bin: String) -> bool {
    // 셸 한 줄에 끼워 넣으므로 바이너리 이름 문자만 허용(주입 차단).
    if bin.is_empty()
        || !bin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return false;
    }
    let shell = default_shell();
    if cfg!(windows) {
        std::process::Command::new(&shell)
            .args(["-Command", &format!("Get-Command {bin}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        // -l: 로그인 셸 — 사용자의 rc/profile 이 구성한 PATH 그대로.
        std::process::Command::new(&shell)
            .args(["-lc", &format!("command -v {bin}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// ── soksak-ptyd 클라이언트(전송) — 계약은 soksak-spec-pty 가 정본 ────────────
#[cfg(unix)]
mod daemon {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use soksak_spec_pty as proto;

    // 전달 단위 소유자는 하나 — 인프로세스 백엔드와 같은 모듈을 쓴다(사본 금지).
    use crate::pty_delivery::spawn_delivery;
    use crate::stream_sink::StreamSink;

    // control 연결 1본(요청-응답 직렬) — 명령 빈도가 낮아(입력·리사이즈·ack) 충분하다.
    struct Control {
        reader: BufReader<UnixStream>,
        writer: UnixStream,
    }

    impl Control {
        fn request(&mut self, req: &proto::Request) -> Result<Value, LinkError> {
            let line = serde_json::to_string(req).map_err(|e| LinkError::Io(e.to_string()))?;
            writeln!(self.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
            let mut reply = String::new();
            self.reader
                .read_line(&mut reply)
                .map_err(|e| LinkError::Io(e.to_string()))?;
            if reply.trim().is_empty() {
                return Err(LinkError::Io("daemon closed the control socket".into()));
            }
            let v: Value =
                serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
            if v["ok"] == true {
                Ok(v.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(LinkError::Remote {
                    code: v["code"].as_str().unwrap_or("ERROR").to_string(),
                    message: v["message"].as_str().unwrap_or_default().to_string(),
                })
            }
        }
    }

    enum LinkError {
        // 소켓/프레이밍 — 링크 자체가 죽었다(재연결 대상).
        Io(String),
        // 데몬의 논리 거절(NOT_FOUND 등) — 링크는 산다.
        Remote { code: String, message: String },
    }

    impl std::fmt::Display for LinkError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                LinkError::Io(e) => write!(f, "link: {e}"),
                LinkError::Remote { code, message } => write!(f, "{code}: {message}"),
            }
        }
    }

    pub struct Link {
        // 링크가 붙는 데몬은 홈 하나에 묶인다(control/stream 소켓·토큰이 거기서 나온다).
        // 캐시된 연결이 이미 그 홈의 것이므로 요청마다 홈을 받으면 캐시와 인자가 어긋난다.
        identity: crate::identity::Identity,
        control: Mutex<Option<Control>>,
        // 폴백 고지 1회 게이트(스폰 폭주 시 도배 방지) — 데몬 스폰 성공이 리셋한다.
        fallback_notified: AtomicBool,
        // 데몬 사망 고지 1회 게이트 — 재확보 성공이 리셋한다.
        lost_notified: AtomicBool,
    }

    impl Link {
        pub(crate) fn new(identity: crate::identity::Identity) -> Self {
            Link {
                identity,
                control: Mutex::new(None),
                fallback_notified: AtomicBool::new(false),
                lost_notified: AtomicBool::new(false),
            }
        }

        pub(crate) fn identity(&self) -> &crate::identity::Identity {
            &self.identity
        }

        // 요청 실행. spawn_if_needed=true 면 미연결 시 스테이징+데몬 스폰까지 시도한다
        // (false 면 살아있는 데몬에 연결만 — pane pid 조회 같은 관찰 경로가 데몬을
        // 부풀리지 않게). Io 에러는 링크를 버리고 1회 재확보 후 재시도한다 — 이
        // "소켓 에러 → 재확보" 가 죽음 감지다(폴링 0).
        pub fn request(
            &self,
            req: &proto::Request,
            spawn_if_needed: bool,
        ) -> Result<Value, String> {
            let home = self.identity.home();
            let mut guard = self.control.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(if spawn_if_needed {
                    ensure_daemon(home).map_err(|e| e.to_string())?
                } else {
                    connect(home).map_err(|e| e.to_string())?
                });
            }
            let conn = match guard.as_mut() {
                Some(c) => c,
                // 바로 위에서 Some 을 넣었으므로 도달 불가 — 패닉 대신 명시 에러.
                None => return Err("pty link: control missing after connect".to_string()),
            };
            match conn.request(req) {
                Ok(v) => Ok(v),
                Err(LinkError::Remote { code, message }) => Err(format!("{code}: {message}")),
                Err(LinkError::Io(_)) => {
                    // 링크 사망 — 재확보 1회 후 재시도. 실패는 호출자에게(폴백 판단).
                    *guard = None;
                    let mut fresh = if spawn_if_needed {
                        ensure_daemon(home).map_err(|e| e.to_string())?
                    } else {
                        connect(home).map_err(|e| e.to_string())?
                    };
                    let out = fresh.request(req).map_err(|e| e.to_string());
                    *guard = Some(fresh);
                    out
                }
            }
        }
    }

    pub struct SpawnParams {
        pub pane_id: Option<String>,
        pub window_label: Option<String>,
        pub cols: u16,
        pub rows: u16,
        pub cwd: Option<String>,
        pub shell: String,
        pub env: Vec<(String, String)>,
        pub env_remove: Vec<String>,
        // 화면 복원 제어(배관) — super::ReplayControl 참조. spawn_via_daemon 이 세 모드로 분기.
        pub replay: Option<super::ReplayControl>,
    }

    // ── 봉인 체크포인트 수신 키(restore 사다리 3단, docs/RESTORE.md) ─────────
    // 봉인은 공개키만 필요하다 — P 는 평문 캐시(<home>/pty/seal.pub, 공개값),
    // S 는 vault 에만(put_data_key). 캐시가 없고 vault 도 잠겨 있으면 None — 데몬은
    // 체크포인트를 쓰지 않는다(fail closed: 화면 바이트 평문 저장 경로는 존재하지 않는다).
    // 동시 스폰 경쟁은 (a) 프로세스 내 뮤텍스 직렬화 (b) keyId 에 랜덤을 넣고 rename
    // 승자의 파일을 재독해 채택 — S/P 짝이 항상 파일이 가리키는 쌍으로 정렬된다.
    static CKPT_KEY_GATE: Mutex<()> = Mutex::new(());

    pub(crate) fn checkpoint_recipient(
        app: &tauri::AppHandle,
        identity: &crate::identity::Identity,
    ) -> (Option<String>, Option<String>) {
        let path = proto::checkpoint_pubkey_path(identity.home());
        let read = |p: &Path| -> Option<(String, String)> {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
            Some((
                v["publicKey"].as_str()?.to_string(),
                v["keyId"].as_str()?.to_string(),
            ))
        };
        let _gate = CKPT_KEY_GATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((pk, key_id)) = read(&path) {
            return (Some(pk), Some(key_id));
        }
        let secrets = tauri::Manager::state::<crate::secrets::SecretsState>(app);
        if !secrets.is_unlocked() {
            return (None, None); // 잠김 + 캐시 없음 — 이번 세션은 체크포인트 없이
        }
        let (s, p) = crate::secrets::gen_asym_keypair();
        let key_id = format!("ptyk-{}", uuid::Uuid::new_v4());
        if let Err(e) = secrets.put_data_key(&key_id, &s) {
            eprintln!("[pty] seal key store failed: {e}");
            return (None, None);
        }
        let pk_b64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(p)
        };
        let doc = json!({ "keyId": key_id, "publicKey": pk_b64 });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
            let tmp = dir.join(format!(".ckpt-pub-{}", std::process::id()));
            if std::fs::write(&tmp, doc.to_string()).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        // rename 승자의 쌍을 채택(교차 프로세스 경쟁 정렬) — 내 쌍이 졌으면 파일 쌍으로.
        match read(&path) {
            Some((pk, key_id)) => (Some(pk), Some(key_id)),
            None => (Some(pk_b64), Some(key_id)),
        }
    }

    // 데몬 경유 스폰: createOrAttach → stream 부착 → reader 스레드(라이브 → Channel). 반환 =
    // 데몬 세션 id. 화면 복원은 코어를 떠났다(방출) — 소비자(플러그인)가 사이드카 복원 요청/
    // 봉인-블롭으로 스스로 그린다. 코어는 소비자의 replay 제어 두 갈래만 존중한다:
    //   plugin_owns("none" | 부재): 소비자가 화면을 그렸다 — 신선 세션 프롬프트만 개행으로
    //     아래에 다시 그린다(코어 재생 없음). 부재(undefined)는 방어적으로 "none" 동치다
    //     (legacy 코어-소유 재생은 방출됨 — 소비자가 항상 명시한다).
    //   from_seq({fromSeq}): warm 핸드오프 — raw 링을 그 seq 부터 부착한다(소비자가 uptoSeq
    //     까지 이미 그렸고, 그 뒤 꼬리가 라이브 연속분이다).
    pub(crate) fn spawn_via_daemon<S: StreamSink>(
        app: &tauri::AppHandle,
        link: &Link,
        p: SpawnParams,
        on_output: S,
    ) -> Result<u64, String> {
        // pane 없는 세션은 재부착 키가 없다 — 데몬에 실을 이유가 없어 로컬로 보낸다.
        let pane_id = p.pane_id.clone().ok_or("no pane id: local session")?;
        // 정체성은 링크가 쥔 것을 그대로 쓴다 — 스폰이 붙는 데몬과 경로가 갈리면 안 된다.
        let identity = link.identity();
        let home = identity.home().to_path_buf();
        let window = p.window_label.clone().unwrap_or_default();
        let replay = p.replay.clone();
        // 소비자 소유("none" | 부재): 코어는 화면을 복원하지 않는다. from_seq: warm 핸드오프 좌표.
        let plugin_owns = match &replay {
            None => true,
            Some(super::ReplayControl::Mode(m)) => m == "none",
            Some(super::ReplayControl::FromSeq { .. }) => false,
        };
        let from_seq = match &replay {
            Some(super::ReplayControl::FromSeq { from_seq }) => Some(*from_seq),
            _ => None,
        };
        // 봉인-블롭 수신 키를 세션에 실어 StoreBlob 이 봉인할 수 있게 한다(사이드카 체크포인트).
        let (checkpoint_pk, checkpoint_key_id) = checkpoint_recipient(app, identity);
        let data = link.request(
            &proto::Request::CreateOrAttach {
                pane_id: pane_id.clone(),
                cols: p.cols,
                rows: p.rows,
                cwd: p.cwd,
                shell: p.shell,
                env: p.env,
                env_remove: p.env_remove,
                window_label: p.window_label,
                checkpoint_pk,
                checkpoint_key_id,
            },
            true,
        )?;
        let session = data["session"]
            .as_u64()
            .ok_or("daemon reply missing session id")?;

        // 부착: from_seq 있으면 raw 링을 그 seq 부터 재생(warm 핸드오프), 없으면 재생 없이 라이브.
        let (mut stream, gap, attach_seq) = attach_stream(&home, session, from_seq)?;
        if let Some((from, to)) = gap {
            // warm 핸드오프에서 evict 로 seq 구간 [from,to) 가 사라졌다 — 무음 유실 금지(loud 고지).
            crate::activity::publish(
                app,
                "pty.warm.gap",
                "core",
                json!({
                    "window": window,
                    "pane": pane_id,
                    "fromSeq": from,
                    "toSeq": to,
                    "note": "the raw ring evicted this range before the warm handoff attached; restore fidelity degraded",
                }),
            );
        }
        // 소비자가 화면을 그린 경우(plugin_owns) 신선 세션 프롬프트를 개행 하나로 페인트 아래에
        // 다시 그린다. from_seq(warm)는 재생 꼬리가 곧 라이브 연속분이라 손대지 않는다.
        if plugin_owns {
            use base64::Engine as _;
            let _ = link.request(
                &proto::Request::Write {
                    session,
                    data_b64: base64::engine::general_purpose::STANDARD.encode("\n"),
                },
                false,
            );
        }

        // 세션 stream reader — 소켓 EOF/에러가 곧 이벤트다: 셸 종료(데몬이 닫음)거나
        // 데몬 사망. control ping 한 번으로 갈라 후자만 고지+재확보한다.
        {
            let app = app.clone();
            let home_for_stream = home.clone();
            let mut cursor = attach_seq;
            std::thread::spawn(move || {
                // 데몬 레그도 같은 크로싱으로 끝난다 — 전달 단위 소유자는 하나다.
                let (deliver, delivery) = spawn_delivery(on_output);
                let mut buf = vec![0u8; 8192];
                'attached: loop {
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if let Some(c) = cursor.as_mut() {
                                    *c += n as u64;
                                }
                                if deliver.send(buf[..n].to_vec()).is_err() {
                                    break 'attached; // 프론트 사라짐(창 리로드 등) — 데몬은 계속 산다
                                }
                            }
                        }
                    }
                    // 부착 스트림의 끝은 생명주기 사건이다 — 원장에 올린다. 관측면이 없으면
                    // "왜 화면이 멈췄는가"를 밖에서 알 길이 없다(실측: 판올림 뒤 화면이 얼었는데
                    // 어떤 채널에도 흔적이 없어 원인을 소스 추론으로만 좁혀야 했다).
                    crate::activity::publish(
                        &app,
                        "pty.stream.ended",
                        "core",
                        json!({ "session": session, "cursor": cursor }),
                    );
                    // 스트림의 끝은 "이 스트림이 끝났다"일 뿐 셸의 끝이 아니다. 무중단 판올림은
                    // 정확히 이 모양이다: 물러나는 데몬이 모든 부착을 EOF 로 놓는다. 셸의 생사는
                    // 데몬에게 묻고, 살아 있으면 마지막 좌표에서 이어 붙는다.
                    match reattach_live_session(&app, &home_for_stream, session, cursor) {
                        Some((s, c)) => {
                            stream = s;
                            cursor = c;
                            continue 'attached;
                        }
                        None => break 'attached,
                    }
                }
                // 스트림 종료를 고지하기 전에 마지막 배치를 내보낸다 — 순서가 뒤집히면 꼬리가 잘린다.
                drop(deliver);
                let _ = delivery.join();
                on_stream_end(&app);
            });
        }

        // 데몬 경로 성공 — 이후 폴백이 다시 일어나면 새 사건으로 고지한다.
        link.fallback_notified.store(false, Ordering::SeqCst);
        Ok(session)
    }

    /// 스트림이 끝났는데 세션은 살아 있는가 — 살아 있으면 마지막 좌표에서 다시 붙는다.
    ///
    /// ping 만으로는 "셸이 끝났다"와 "데몬이 물러났다"를 가를 수 없다(둘 다 데몬은 응답한다).
    /// 가르는 것은 세션의 존재다 — 권위에게 묻는다. 옛 판은 ping 성공을 곧 셸 종료로 읽어
    /// 아무것도 하지 않았고, 그래서 판올림 뒤 셸은 살아 입력도 받는데 화면만 영영 멈췄다
    /// (실측 2026-07-27, scripts/e2e/pty-handoff.mjs).
    ///
    /// 재시도는 폴링이 아니라 **경계 하나를 넘는 대기**다: 물러난 데몬이 소켓을 놓고 새 데몬이
    /// 그 자리를 잡는 그 전이 구간만 기다린다. 상한 20회·150ms(총 3초)이며, 그 안에 세션이
    /// 확인되지 않으면 포기하고 기존 경로(on_stream_end)로 넘긴다.
    fn reattach_live_session(
        app: &tauri::AppHandle,
        home: &Path,
        session: u64,
        cursor: Option<u64>,
    ) -> Option<(UnixStream, Option<u64>)> {
        let manager = tauri::Manager::state::<crate::pty::PtyManager>(app);
        for attempt in 0..20 {
            match manager.link.request(&proto::Request::ListSessions, true) {
                Ok(v) => {
                    // SessionInfo 의 식별자 필드는 `session` 이다(`id` 가 아니다) — 이름을
                    // 잘못 짚으면 언제나 "없음"으로 읽혀 재부착이 조용히 사라진다(실측).
                    let alive = v["sessions"]
                        .as_array()
                        .map(|a| a.iter().any(|s| s["session"].as_u64() == Some(session)))
                        .unwrap_or(false);
                    if !alive {
                        // 셸이 정말 끝났다 — 기존 경로가 처리한다. 조용히 지나가지 않는다:
                        // "재부착 안 함"도 판정이고, 판정은 원장에 남아야 뒤에서 읽을 수 있다.
                        crate::activity::publish(
                            app,
                            "pty.session.gone",
                            "core",
                            json!({
                                "session": session,
                                "note": "the attach stream ended and the daemon no longer lists this session — the shell exited",
                            }),
                        );
                        return None;
                    }
                    match attach_stream(home, session, cursor) {
                        Ok((s, gap, seq)) => {
                            crate::activity::publish(
                                app,
                                "pty.stream.reattached",
                                "core",
                                json!({
                                    "session": session,
                                    "fromSeq": cursor,
                                    "cursorKnown": cursor.is_some(),
                                    "gap": gap.map(|(f, t)| json!({ "fromSeq": f, "toSeq": t })),
                                    "attempts": attempt + 1,
                                    "note": "the attach stream ended while the session lived (daemon handoff) — reattached at the last coordinate",
                                }),
                            );
                            return Some((s, seq));
                        }
                        Err(e) => {
                            // 새 데몬이 아직 스트림 소켓을 잡기 전일 수 있다 — 같은 전이 구간.
                            if attempt == 19 {
                                crate::activity::publish(
                                    app,
                                    "pty.stream.reattach.failed",
                                    "core",
                                    json!({ "session": session, "error": e }),
                                );
                                return None;
                            }
                        }
                    }
                }
                Err(_) => {
                    // 링크 자체가 전이 중 — 아래에서 잠깐 기다렸다 다시 묻는다.
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        None
    }

    // stream 종료의 원인 판별: control ping 이 살아 있으면 셸의 정상 종료다(프론트는
    // Channel 종료로 이미 안다). ping 까지 죽었으면 데몬 사망 — 고지하고 재확보를
    // 시도한다(성공 시 다음 스폰부터 데몬 경로 복귀. 죽은 데몬의 세션은 소실 —
    // 골격의 한계로 고지에 싣는다).
    fn on_stream_end(app: &tauri::AppHandle) {
        let manager = tauri::Manager::state::<crate::pty::PtyManager>(app);
        let link = &manager.link;
        if link.request(&proto::Request::Ping, false).is_ok() {
            return; // 셸 정상 종료
        }
        // 재확보 대상은 이 링크가 겨누던 그 데몬이다 — 홈은 링크가 쥔 정체성에서 온다.
        let respawned = ensure_daemon(link.identity().home()).is_ok();
        if respawned {
            link.lost_notified.store(false, Ordering::SeqCst);
        }
        if !link.lost_notified.swap(true, Ordering::SeqCst) || respawned {
            crate::activity::publish(
                app,
                "pty.daemon.lost",
                "core",
                json!({
                    "respawned": respawned,
                    "note": "live daemon sessions are lost; new terminals reattach to the respawned daemon",
                }),
            );
        }
    }

    // 폴백 고지(무음 금지) — 스폰 폭주 도배 방지로 1회 게이트.
    // 이 함수가 app 을 쓰던 곳은 발행 한 줄뿐이었다 — 계약만 받는다(ipc.rs record_route_outcome 선례).
    pub(crate) fn notify_fallback(
        ledger: &dyn crate::activity_sink::ActivitySink,
        link: &Link,
        error: &str,
    ) {
        if link.fallback_notified.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[pty] daemon unavailable, in-process fallback: {error}");
        ledger.publish(
            "pty.daemon.fallback",
            "core",
            json!({
                "error": error,
                "note": "terminals run in-process and will not survive an app restart",
            }),
        );
    }

    // ── 확보: 연결 → (실패 시) 스테이징 + 스폰 + 재연결 ─────────────────────

    fn connect(home: &Path) -> Result<Control, LinkError> {
        let token = std::fs::read_to_string(proto::token_path(home))
            .map_err(|e| LinkError::Io(format!("token: {e}")))?
            .trim()
            .to_string();
        let conn = UnixStream::connect(proto::control_socket_path(home))
            .map_err(|e| LinkError::Io(format!("connect: {e}")))?;
        let reader = BufReader::new(conn.try_clone().map_err(|e| LinkError::Io(e.to_string()))?);
        let mut c = Control {
            reader,
            writer: conn,
        };
        let hello = proto::Hello {
            version: Some(proto::PTYD_PROTOCOL_VERSION),
            token,
            client_id: format!("app-{}", std::process::id()),
            session: None,
            from_seq: None,
            subscribe: false,
        };
        let line = serde_json::to_string(&hello).map_err(|e| LinkError::Io(e.to_string()))?;
        writeln!(c.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
        let mut reply = String::new();
        c.reader
            .read_line(&mut reply)
            .map_err(|e| LinkError::Io(e.to_string()))?;
        let v: Value =
            serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
        if v["ok"] != true {
            return Err(LinkError::Remote {
                code: v["code"].as_str().unwrap_or("ERROR").to_string(),
                message: v["message"].as_str().unwrap_or_default().to_string(),
            });
        }
        Ok(c)
    }

    fn ensure_daemon(home: &Path) -> Result<Control, LinkError> {
        if let Ok(c) = connect(home) {
            return Ok(c);
        }
        let staged = stage_binary(home).map_err(LinkError::Io)?;
        // run/ 은 데몬도 부트에 만들지만, 로그 파일은 스폰 전에 앱이 먼저 연다 — 앱이 보장한다.
        std::fs::create_dir_all(proto::run_dir(home))
            .map_err(|e| LinkError::Io(format!("run dir: {e}")))?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(proto::log_path(home))
            .map_err(|e| LinkError::Io(format!("log: {e}")))?;
        let log2 = log.try_clone().map_err(|e| LinkError::Io(e.to_string()))?;
        let mut cmd = std::process::Command::new(&staged);
        cmd.env("SOKSAK_HOME", home)
            .stdin(std::process::Stdio::null())
            .stdout(log)
            .stderr(log2);
        // detach: 새 세션 리더로 — 앱이 죽어도 데몬과 그 셸들이 살아남는다.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn()
            .map_err(|e| LinkError::Io(format!("spawn ptyd: {e}")))?;
        // 부트스트랩 핸드셰이크 대기 한정의 유한 재시도(성공/2s 상한 종료) — 상시
        // 감시가 아니다(감시는 소켓 에러 이벤트가 담당).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match connect(home) {
                Ok(c) => return Ok(c),
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(e);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }

    // 홈 bin/ 설치 계약: 데몬 실행물은 앱 번들 밖 identity 홈 bin/ 에 프로토콜-키
    // 이름으로 놓인다 — 번들은 업데이터의 원자 교체 단위라 번들 내 장수 프로세스는
    // 세션 수명을 번들 수명에 강결합시킨다(R7). 배치는 staging → rename 원자
    // (실행 중 mach-o in-place 덮어쓰기는 서명 무효화로 SIGKILL — stage.sh 선례).
    /// 판올림 전 판정 — 나가는 데몬이 안전 인계 계약을 구현하는가.
    ///
    /// 인계 계획(대상 fd 배치·링 좌표 승계)은 물러나는 쪽이 세운다. 그래서 새 바이너리를
    /// 스테이징해도, 그 인계를 실행하는 것은 **지금 도는 옛 데몬**이다. 계약 이전 판에
    /// 인계를 시키면 셸이 죽거나 화면이 조용히 멎는다 — 못 하는 일을 시도하지 않는다.
    /// 조치는 하나뿐이라 문구에 박아 둔다(선택지를 주지 않는다).
    pub(crate) fn handoff_precheck(ping: &serde_json::Value) -> Result<(), String> {
        let need = soksak_spec_pty::PTYD_HANDOFF_CONTRACT;
        match ping["handoffContract"].as_u64() {
            Some(v) if v >= need as u64 => Ok(()),
            Some(v) => Err(format!(
                "the running daemon implements handoff contract {v}, this build needs {need} — \
                 run pty.daemon.restart once to adopt the new generation"
            )),
            None => Err(format!(
                "the running daemon predates the safe-handoff contract (needs {need}); a live \
                 upgrade from it can lose a shell or silently freeze output — run \
                 pty.daemon.restart once to adopt the new generation"
            )),
        }
    }

    #[cfg(test)]
    mod handoff_precheck_tests {
        use super::handoff_precheck;
        use serde_json::json;

        #[test]
        fn current_contract_passes() {
            let need = soksak_spec_pty::PTYD_HANDOFF_CONTRACT;
            assert!(handoff_precheck(&json!({ "handoffContract": need })).is_ok());
            assert!(handoff_precheck(&json!({ "handoffContract": need + 1 })).is_ok());
        }

        #[test]
        fn a_daemon_without_the_field_is_refused_with_the_remedy() {
            let e = handoff_precheck(&json!({ "pid": 1, "sessions": 2 })).unwrap_err();
            assert!(e.contains("pty.daemon.restart"), "조치가 없는 거절은 거절이 아니다: {e}");
            assert!(e.contains("predates"), "{e}");
        }

        #[test]
        fn an_older_contract_is_refused() {
            let e = handoff_precheck(&json!({ "handoffContract": 1 })).unwrap_err();
            assert!(e.contains("pty.daemon.restart"), "{e}");
        }
    }

    pub(crate) fn stage_binary(home: &Path) -> Result<PathBuf, String> {
        let staged = proto::staged_bin_path(home);
        let source = resolve_source_binary();
        let Some(source) = source else {
            if staged.exists() {
                return Ok(staged); // 소스 부재 — 이전에 스테이징된 판으로 계속
            }
            return Err(
                "ptyd binary not found (SOKSAK_PTYD_BIN or a soksak-ptyd next to the app binary)"
                    .into(),
            );
        };
        if staged.exists() && same_content(&source, &staged) {
            return Ok(staged);
        }
        let bin_dir = staged.parent().ok_or("staged path has no parent")?;
        std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
        let tmp = bin_dir.join(format!(".ptyd-staging-{}", std::process::id()));
        std::fs::copy(&source, &tmp).map_err(|e| format!("stage copy: {e}"))?;
        #[allow(clippy::permissions_set_readonly_false)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &staged).map_err(|e| format!("stage rename: {e}"))?;
        Ok(staged)
    }

    // 소스 해석: SOKSAK_PTYD_BIN(오픈 테스트 메커니즘 — SOKSAK_VAULT_PATH 와 동형)
    // > 앱 실행 파일 형제 soksak-ptyd(dev cargo 산출·번들 동봉 공통 규칙).
    fn resolve_source_binary() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("SOKSAK_PTYD_BIN") {
            if !p.is_empty() {
                let p = PathBuf::from(p);
                if p.exists() {
                    return Some(p);
                }
            }
        }
        let exe = std::env::current_exe().ok()?;
        let sibling = exe.parent()?.join("soksak-ptyd");
        sibling.exists().then_some(sibling)
    }

    fn same_content(a: &Path, b: &Path) -> bool {
        use sha2::{Digest, Sha256};
        let hash = |p: &Path| -> Option<[u8; 32]> {
            let mut f = std::fs::File::open(p).ok()?;
            let mut h = Sha256::new();
            std::io::copy(&mut f, &mut h).ok()?;
            Some(h.finalize().into())
        };
        matches!((hash(a), hash(b)), (Some(x), Some(y)) if x == y)
    }

    // 디스크의 봉인-블롭 헤더 — cold restore 의 입력(개봉 전 메타). 봉투는 내용 불가지라
    // 터미널 메타(대체 화면 여부 등)를 담지 않는다 — 화면 의미는 개봉된 바이트 안에 있고 소비자가 푼다.
    pub struct ColdCheckpoint {
        // 봉인 블롭의 디스크 출처 경로 — provenance 로 보존(cold restore 판정은 개봉 바이트만 쓴다).
        pub path: PathBuf,
        pub key_id: String,
        pub sealed: soksak_seal::SealedBox,
    }

    fn read_checkpoint(home: &Path, window: &str, pane: &str) -> Option<ColdCheckpoint> {
        let path = proto::checkpoint_path(home, window, pane);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        if doc["v"] != 1 {
            return None; // 미래 판 — 이 세대는 열지 않는다(손대지 않고 남긴다)
        }
        Some(ColdCheckpoint {
            path,
            key_id: doc["keyId"].as_str()?.to_string(),
            sealed: serde_json::from_value(doc["sealed"].clone()).ok()?,
        })
    }

    // 개봉 — unlock 된 vault 의 개인키 + 정합 AAD 만 연다. 실패 사유는 고지에 실린다.
    fn open_cold_checkpoint(
        app: &tauri::AppHandle,
        ck: &ColdCheckpoint,
        window: &str,
        pane: &str,
    ) -> Result<Vec<u8>, String> {
        let secrets = tauri::Manager::state::<crate::secrets::SecretsState>(app);
        if !secrets.is_unlocked() {
            return Err("vault locked".into());
        }
        let sk = secrets
            .get_data_key(&ck.key_id)?
            .ok_or_else(|| format!("seal key {} not in vault", ck.key_id))?;
        let aad = proto::checkpoint_aad(window, pane, &ck.key_id);
        crate::secrets::open_sealed(&sk, &ck.sealed, &aad)
    }

    // stream 부착: hello 1줄 교환 후 raw 전환. hello 응답 줄만 바이트 단위로 소비해
    // 뒤따르는 재생/라이브 바이트를 잃지 않는다. from_seq 있으면 raw 링을 그 seq 부터
    // 재생하라고 데몬에 요청한다(warm 핸드오프), 없으면 재생 없이 라이브(미러 방출됨). 반환 =
    // (소켓, evict gap [from,to) — from_seq 재생에서 링이 잘렸을 때만).
    /// 부착 스트림 + evict gap + **부착 좌표**. 좌표는 "이 응답을 다 소비하면 당신이 서 있는
    /// 자리"다 — 스트림이 끊겼을 때 재부착에 쓸 절대 커서의 출발점이다. 구 데몬은 이 필드를
    /// 싣지 않으므로 None 이 올 수 있고, 그때는 재부착이 재생 없이 붙는다(유실은 고지한다).
    fn attach_stream(
        home: &Path,
        session: u64,
        from_seq: Option<u64>,
    ) -> Result<(UnixStream, Option<(u64, u64)>, Option<u64>), String> {
        let token = std::fs::read_to_string(proto::token_path(home))
            .map_err(|e| format!("token: {e}"))?
            .trim()
            .to_string();
        let conn = UnixStream::connect(proto::stream_socket_path(home))
            .map_err(|e| format!("stream connect: {e}"))?;
        let mut w = conn.try_clone().map_err(|e| e.to_string())?;
        let hello = proto::Hello {
            version: Some(proto::PTYD_PROTOCOL_VERSION),
            token,
            client_id: format!("app-{}", std::process::id()),
            session: Some(session),
            from_seq,
            subscribe: false,
        };
        let line = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
        writeln!(w, "{line}").map_err(|e| e.to_string())?;
        let mut r = conn.try_clone().map_err(|e| e.to_string())?;
        let mut reply = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            r.read_exact(&mut byte)
                .map_err(|e| format!("stream hello: {e}"))?;
            if byte[0] == b'\n' {
                break;
            }
            reply.push(byte[0]);
            if reply.len() > 64 * 1024 {
                return Err("stream hello reply too long".into());
            }
        }
        let v: Value = serde_json::from_slice(&reply).map_err(|e| e.to_string())?;
        if v["ok"] != true {
            return Err(format!(
                "{}: {}",
                v["code"].as_str().unwrap_or("ERROR"),
                v["message"].as_str().unwrap_or_default()
            ));
        }
        // from_seq 재생에서 링이 그 seq 이전을 evict 했으면 gap 을 실어 준다(무음 유실 금지).
        let gap = match (
            v["data"]["gap"]["fromSeq"].as_u64(),
            v["data"]["gap"]["toSeq"].as_u64(),
        ) {
            (Some(f), Some(t)) => Some((f, t)),
            _ => None,
        };
        let seq = v["data"]["seq"].as_u64();
        Ok((conn, gap, seq))
    }

    // ── 서비스 사이드카 릴레이(생존 미러 사이드카 — SIDECARS.md) ──────────────────
    // 웹뷰 JS 는 UDS 를 못 연다. 코어가 사이드카 서비스 소켓에 NDJSON 요청/응답 1왕복을
    // 대신 연결해 준다(데몬 바이트 다리 pty.rs 와 같은 층위). 코어는 요청/응답 JSON 을
    // 해석하지 않는다(내용 불가지 다리). 소켓은 데몬과 같은 run 디렉토리에 있고 identity-home
    // 토큰을 공유한다(사이드카가 데몬과 피어링하는 계약). 연결 실패는 명시 에러(사이드카 사망 loud).
    pub(crate) fn sidecar_service_relay(
        identity: &crate::identity::Identity,
        request: &Value,
    ) -> Result<Value, String> {
        let home = identity.home();
        let path = proto::run_dir(home).join(format!(
            "soksak-sidecar-terminal-p{}.sock",
            proto::PTYD_PROTOCOL_VERSION
        ));
        let token = std::fs::read_to_string(proto::token_path(home))
            .map_err(|e| format!("token: {e}"))?
            .trim()
            .to_string();
        let conn = UnixStream::connect(&path)
            .map_err(|e| format!("no terminal sidecar at {}: {e}", path.display()))?;
        let mut w = conn.try_clone().map_err(|e| e.to_string())?;
        let mut r = BufReader::new(conn);
        // hello{version, token} 1줄 → ok 1줄. 계약(SPEC §4)은 데몬 hello 와 동형이다.
        let hello = json!({ "version": proto::PTYD_PROTOCOL_VERSION, "token": token });
        writeln!(w, "{hello}").map_err(|e| e.to_string())?;
        let mut line = String::new();
        if r.read_line(&mut line)
            .map_err(|e| format!("hello reply: {e}"))?
            == 0
        {
            return Err("terminal sidecar closed before hello ack".into());
        }
        let ack: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        if ack["ok"] != true {
            return Err(format!(
                "{}: {}",
                ack["code"].as_str().unwrap_or("ERROR"),
                ack["message"].as_str().unwrap_or_default()
            ));
        }
        // 요청 릴레이 — 내용 불가지로 그대로 통과. 응답 1줄 파싱해 그대로 돌려준다.
        let mut req_line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
        req_line.push(b'\n');
        w.write_all(&req_line).map_err(|e| e.to_string())?;
        line.clear();
        if r.read_line(&mut line).map_err(|e| format!("reply: {e}"))? == 0 {
            return Err("terminal sidecar closed before reply".into());
        }
        serde_json::from_str(line.trim()).map_err(|e| format!("reply parse: {e}"))
    }

    // ── 봉인-블롭 읽기 관통(cold 소비 경로 — restore 사다리 3단) ──────────────────
    // 이 pane 의 봉인-블롭을 앱 볼트로 개봉해 평문 페인트(base64)를 돌려준다. 잠금이면 명시
    // 에러(fail-closed — 평문 우회 없음), 블롭 없으면 None. 소비자가 바이트를 그려 죽은 세션
    // 화면을 다시 그린다(사이드카 불요 경로). 코어는 바이트를 해석하지 않는다(봉인만 열고 넘긴다).
    pub(crate) fn read_sealed_screen(
        app: &tauri::AppHandle,
        identity: &crate::identity::Identity,
        window: &str,
        pane: &str,
    ) -> Result<Option<super::SealedScreen>, String> {
        let ck = match read_checkpoint(identity.home(), window, pane) {
            Some(c) => c,
            None => return Ok(None),
        };
        let paint = open_cold_checkpoint(app, &ck, window, pane)?;
        use base64::Engine as _;
        Ok(Some(super::SealedScreen {
            paint_b64: base64::engine::general_purpose::STANDARD.encode(&paint),
        }))
    }

    /// 옛 블롭의 승계 — 규칙은 세 갈래고 어느 갈래도 반쯤 상태를 남기지 않는다:
    ///   신 키 파일이 이미 있다 → 최신이 이긴다. 옛 파일만 걷는다.
    ///   재봉인 성공(새 AAD·tmp→rename 원자) → 신 키 파일 생성 후 옛 파일 제거.
    ///   재봉인 실패 → 옛 파일 보존. 다음 부팅이 다시 폴백으로 연다(손실 0 유지).
    /// rename 만으로는 안 된다 — 봉인 AAD 가 옛 키에 묶여 있어 신 키 개봉이 복호 실패한다.
    pub fn adopt_checkpoint(
        ck: &ColdCheckpoint,
        paint: &[u8],
        window: &str,
        pane: &str,
        new_path: &Path,
        pk_b64: Option<&str>,
    ) {
        if new_path.exists() {
            let _ = std::fs::remove_file(&ck.path);
            return;
        }
        use base64::Engine as _;
        let resealed = pk_b64
            .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
            .and_then(|pk| pk.try_into().ok())
            .and_then(|pk: [u8; 32]| {
                let aad = proto::checkpoint_aad(window, pane, &ck.key_id);
                soksak_seal::seal_to(&pk, paint, &aad).ok()
            })
            .and_then(|sealed| {
                let doc = serde_json::json!({
                    "v": 1,
                    "keyId": ck.key_id,
                    "window": window,
                    "pane": pane,
                    "sealed": sealed,
                });
                let tmp = new_path.with_extension("json.tmp");
                std::fs::write(&tmp, doc.to_string()).ok()?;
                std::fs::rename(&tmp, new_path).ok()
            });
        if resealed.is_some() {
            let _ = std::fs::remove_file(&ck.path);
        }
    }

    /// 옛 키(legacy)의 블롭을 열어 신 키(pane)로 승계한다 — 엔티티 id 이행의 손실 0 실행부.
    pub(crate) fn read_sealed_screen_adopting(
        app: &tauri::AppHandle,
        identity: &crate::identity::Identity,
        window: &str,
        legacy: &str,
        pane: &str,
    ) -> Result<Option<super::SealedScreen>, String> {
        let home = identity.home();
        let ck = match read_checkpoint(home, window, legacy) {
            Some(c) => c,
            None => return Ok(None),
        };
        let paint = open_cold_checkpoint(app, &ck, window, legacy)?;
        let pk = std::fs::read_to_string(identity.path("pty/seal.pub"))
            .ok()
            .map(|s| s.trim().to_string());
        adopt_checkpoint(&ck, &paint, window, pane, &proto::checkpoint_path(home, window, pane), pk.as_deref());
        use base64::Engine as _;
        Ok(Some(super::SealedScreen {
            paint_b64: base64::engine::general_purpose::STANDARD.encode(&paint),
        }))
    }
}

// ── 셸 결속 계약 ───────────────────────────────────────────────────────────
// 이 파일이 앱 프로세스에 묶여 있던 세 고리를 못박는다:
//   ① 홈이 앰비언트 전역에서 왔다 → 이제 Identity 값으로 온다.
//   ② 원장에 한 줄 남기는 함수가 AppHandle 을 받았다 → ActivitySink 하나만 받는다.
//   ③ 벤더 스트림 타입이 커맨드 아래까지 내려갔다 → 진입점에서 멈춘다.
#[cfg(test)]
mod seam_tests {
    use crate::activity_sink::ActivitySink;
    use crate::identity::Identity;
    use crate::stream_sink::{Delivered, StreamSink};
    use serde_json::{json, Value};

    #[derive(Default)]
    struct Recorder {
        entries: std::sync::Mutex<Vec<(String, Value)>>,
    }

    impl ActivitySink for Recorder {
        fn publish(&self, kind: &str, source: &str, payload: Value) -> Value {
            let mut e = self.entries.lock().unwrap();
            e.push((kind.to_string(), payload.clone()));
            json!({ "seq": e.len(), "kind": kind, "source": source })
        }
    }

    struct NullSink;

    impl StreamSink for NullSink {
        fn deliver(&self, _bytes: Vec<u8>) -> Delivered {
            Delivered::Ok
        }
    }

    /// 매니저는 자기 정체성을 들고 다닌다 — 데몬 소켓·토큰·스테이징 바이너리·체크포인트가
    /// 전부 그 홈에서 파생되므로, 호출마다 홈을 받으면 한 세션 맵에 두 데몬의 세션이 섞인다.
    #[test]
    fn a_manager_carries_its_identity_instead_of_reading_the_ambient_home() {
        let id = Identity::new("/tmp/soksak-pty-seam-dev", "com.soksak.dev");
        let manager = super::PtyManager::new(id.clone());
        assert_eq!(manager.identity(), &id);
        // 전역을 읽었다면 이 구분이 사라진다 — 두 홈이 하나로 접힌다.
        let ambient = crate::identity::ambient();
        assert_ne!(
            manager.identity().home(),
            ambient.home(),
            "매니저가 앰비언트 홈을 읽고 있다"
        );
        // 링크는 홈 하나에 붙는다(소켓·토큰이 거기서 나온다) — 매니저와 같은 정체성이어야 한다.
        #[cfg(unix)]
        assert_eq!(manager.link.identity(), &id);
    }

    /// 앰비언트 홈 읽기 0. 타입으로는 못 막는다 — 함수 하나가 다시 전역을 부르면 시그니처는
    /// 그대로인 채 그 함수만 조용히 앱 프로세스에 묶인다. 그래서 소스로 못박는다
    /// (ambient_gate.rs 와 같은 이유).
    #[test]
    fn this_module_never_reads_the_ambient_home() {
        let src = include_str!("pty.rs");
        // 바늘은 런타임에 조립한다 — 리터럴로 두면 이 테스트 줄 자신이 걸린다.
        let needle = ["crate::home::", "soksak_home"].concat();
        let hits: Vec<String> = src
            .lines()
            .enumerate()
            .filter(|(_, l)| l.contains(needle.as_str()))
            .map(|(i, l)| format!("  {}: {}", i + 1, l.trim()))
            .collect();
        assert!(
            hits.is_empty(),
            "앰비언트 홈 읽기가 남아 있다 — 홈은 Identity 로 흐른다:\n{}",
            hits.join("\n")
        );
    }

    /// 데몬 레그의 출구는 계약이다 — 벤더 채널 타입은 커맨드 진입점에서 멈춘다.
    /// 함수 포인터로 시그니처를 못박는다: 벤더 타입이 돌아오면 여기서 컴파일이 깨진다.
    #[cfg(unix)]
    #[test]
    fn the_daemon_leg_takes_a_sink_not_a_vendor_channel() {
        let _typed: fn(
            &tauri::AppHandle,
            &super::daemon::Link,
            super::daemon::SpawnParams,
            NullSink,
        ) -> Result<u64, String> = super::daemon::spawn_via_daemon::<NullSink>;
    }

    /// 폴백 고지는 원장 한 줄이다 — 앱 핸들 없이 발행되고, 도배 방지 1회 게이트가 산다.
    #[cfg(unix)]
    #[test]
    fn the_fallback_notice_needs_only_a_ledger() {
        let link = super::daemon::Link::new(Identity::new(
            "/tmp/soksak-pty-seam-dev",
            "com.soksak.dev",
        ));
        let ledger = Recorder::default();
        super::daemon::notify_fallback(&ledger, &link, "no daemon");
        // 1회 게이트 — 스폰 폭주가 원장을 도배하지 않는다.
        super::daemon::notify_fallback(&ledger, &link, "no daemon");
        let entries = ledger.entries.lock().unwrap();
        assert_eq!(entries.len(), 1, "폴백 고지가 도배됐다");
        assert_eq!(entries[0].0, "pty.daemon.fallback");
        assert_eq!(entries[0].1["error"], "no daemon");
    }
}

#[cfg(test)]
mod tests {
    use super::{shell_safe_base_env, ReplayControl};


    // 셸 env 화이트리스트 — (a) 내부 시크릿·임의 비밀은 0, (b) 필수 표준·SSH 핸들은 승계.
    // env_clear 후 자식 셸에 실제로 들어갈 목록을 순수 함수 수준에서 못박는다(Local·Daemon 공통).
    #[test]
    fn shell_safe_base_env_whitelists_standard_and_drops_secrets() {
        let parent = [
            // 필수 표준 — 승계돼야 함
            ("PATH", "/usr/bin"),
            ("HOME", "/home/x"),
            ("USER", "x"),
            ("SHELL", "/bin/zsh"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
            ("TZ", "UTC"),
            ("TMPDIR", "/tmp"),
            ("SSH_AUTH_SOCK", "/run/ssh-agent.sock"),
            // 내부/민감 — 반드시 탈락
            ("SOKSAK_VAULT_KEY", "MASTER-LEAK"),
            ("SOKSAK_SECRET_0", "sk-real-9z"),
            ("SOKSAK_VAULT_PATH", "/iso/secrets.vault"),
            ("CLAUDECODE", "1"),
            ("AWS_SECRET_ACCESS_KEY", "zzz"),
        ];
        let got: std::collections::HashMap<String, String> =
            shell_safe_base_env(parent.iter().map(|(k, v)| (k.to_string(), v.to_string())))
                .into_iter()
                .collect();

        // (b) 필수 표준·SSH 핸들은 승계된다.
        for k in [
            "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "SSH_AUTH_SOCK",
        ] {
            assert!(got.contains_key(k), "{k} 는 화이트리스트로 승계돼야 한다");
        }
        // (a) 내부/민감은 자식 env 에서 0.
        for k in [
            "SOKSAK_VAULT_KEY",
            "SOKSAK_SECRET_0",
            "SOKSAK_VAULT_PATH",
            "CLAUDECODE",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!got.contains_key(k), "{k} 는 화이트리스트에 탈락해야 한다");
        }
    }

    // spawn 의 replay 파라미터 와이어 계약(배관) — 부재/none/{fromSeq} 셋을 정확히 가른다.
    // 소비자 소유 판정과 warm 좌표가 여기서 갈리므로 세 형태의 역직렬화를 못박는다.
    #[derive(serde::Deserialize)]
    struct SpawnArg {
        replay: Option<ReplayControl>,
    }

    fn parse(json: &str) -> Option<ReplayControl> {
        serde_json::from_str::<SpawnArg>(json)
            .expect("valid spawn arg")
            .replay
    }

    #[test]
    fn absent_or_null_replay_is_core_owned() {
        assert!(matches!(parse(r#"{"replay":null}"#), None));
        assert!(matches!(parse(r#"{}"#), None));
    }

    #[test]
    fn none_mode_marks_consumer_owned() {
        match parse(r#"{"replay":"none"}"#) {
            Some(ReplayControl::Mode(m)) => assert_eq!(m, "none"),
            other => panic!("expected Mode(\"none\"), got {other:?}"),
        }
    }

    #[test]
    fn from_seq_carries_the_warm_handoff_coordinate_in_camel_case() {
        match parse(r#"{"replay":{"fromSeq":4096}}"#) {
            Some(ReplayControl::FromSeq { from_seq }) => assert_eq!(from_seq, 4096),
            other => panic!("expected FromSeq, got {other:?}"),
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod adopt_tests {
    // 옛 블롭 승계 규칙(엔티티 id 이행의 손실 0 실행부) — 세 갈래 어느 쪽도 반쯤 상태를
    // 남기지 않는다. RED 근거(실측 2026-07-26): 마이그레이션 직후 첫 부팅에서 옛 키(v4)
    // 블롭이 신 키로 열리지 않아 cold restore 화면이 비었다 — 폴백·승계가 그 구멍을 닫는다.
    use super::daemon::{adopt_checkpoint, ColdCheckpoint};
    use base64::Engine as _;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("soksak-adopt-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fixture(dir: &std::path::Path) -> (ColdCheckpoint, Vec<u8>, String) {
        let (sk, pk) = soksak_seal::gen_asym_keypair();
        let _ = sk;
        let paint = b"screen-bytes".to_vec();
        let old_aad = soksak_spec_pty::checkpoint_aad("w-t", "v4", "k1");
        let sealed = soksak_seal::seal_to(&pk, &paint, &old_aad).unwrap();
        let old_path = dir.join("ckpt-old.json");
        std::fs::write(&old_path, "{}").unwrap();
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(pk);
        (
            ColdCheckpoint { path: old_path, key_id: "k1".into(), sealed },
            paint,
            pk_b64,
        )
    }

    #[test]
    fn reseal_creates_the_new_file_and_removes_the_old() {
        let dir = scratch("reseal");
        let (ck, paint, pk) = fixture(&dir);
        let new_path = dir.join("ckpt-new.json");
        adopt_checkpoint(&ck, &paint, "w-t", "tab-aaaaaa", &new_path, Some(&pk));
        assert!(new_path.exists(), "재봉인 성공 = 신 키 파일 생성");
        assert!(!ck.path.exists(), "제거 조건 = 재봉인 완료");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&new_path).unwrap()).unwrap();
        assert_eq!(doc["pane"], "tab-aaaaaa", "새 문서는 신 키를 말한다");
    }

    #[test]
    fn a_newer_checkpoint_wins_and_the_relic_is_swept() {
        let dir = scratch("newer");
        let (ck, paint, pk) = fixture(&dir);
        let new_path = dir.join("ckpt-new.json");
        std::fs::write(&new_path, "newer").unwrap();
        adopt_checkpoint(&ck, &paint, "w-t", "tab-aaaaaa", &new_path, Some(&pk));
        assert_eq!(std::fs::read_to_string(&new_path).unwrap(), "newer", "최신이 이긴다");
        assert!(!ck.path.exists(), "잔존물은 걷는다");
    }

    #[test]
    fn a_failed_reseal_preserves_the_old_blob() {
        let dir = scratch("fail");
        let (ck, paint, _) = fixture(&dir);
        let new_path = dir.join("ckpt-new.json");
        adopt_checkpoint(&ck, &paint, "w-t", "tab-aaaaaa", &new_path, Some("not-base64!"));
        assert!(!new_path.exists(), "실패 시 신 키 파일을 만들지 않는다");
        assert!(ck.path.exists(), "옛 파일 보존 — 다음 부팅이 다시 폴백으로 연다(손실 0)");
    }
}
