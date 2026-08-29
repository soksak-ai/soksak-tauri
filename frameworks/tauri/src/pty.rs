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
use crate::stream_sink::ChannelSink;


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
    link: std::sync::Arc<daemon::Link>,
}

// spawn_terminal 결과. 화면 복원 판정은 코어를 떠났다(방출) — 소비자(플러그인)가 사이드카
// 복원 요청/봉인-블롭으로 스스로 그리고 스스로 안다. 코어는 세션 id 만 돌려준다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOutcome {
    pub id: u32,
}

// 재생 제어·봉인 화면은 ptyd 계약의 일부다 — 코어가 소유한다.
pub use soksak_core::ptyd::{ReplayControl, SealedScreen};

impl PtyManager {
    /// 정체성 하나로 매니저를 세운다 — 링크도 같은 정체성으로 태어난다(한 생성자에서만
    /// 정해지므로 두 값이 어긋날 자리가 없다).
    pub(crate) fn new(identity: Identity) -> Self {
        PtyManager {
            #[cfg(unix)]
            link: std::sync::Arc::new(daemon::Link::new(identity.clone(), ptyd_source())),
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

/// 이 프로세스가 아는 ptyd 실행 파일 — **후보를 만들어 넘긴다.**
///
/// 지목(SOKSAK_PTYD_BIN, 오픈 테스트 메커니즘 — SOKSAK_VAULT_PATH 와 동형) > 실행 파일 형제
/// soksak-ptyd(dev cargo 산출·번들 동봉 공통 규칙). 고르는 규칙은 코어의 것이고, 여기서는
/// 이 프로세스만 아는 두 사실(환경·자기 경로)을 읽어 준다.
#[cfg(unix)]
fn ptyd_source() -> Option<std::path::PathBuf> {
    let declared = std::env::var("SOKSAK_PTYD_BIN")
        .ok()
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from);
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("soksak-ptyd")));
    daemon::pick_source(declared.as_deref(), sibling.as_deref())
}

/// 이 앱의 봉인 열쇠 보관소. 상태를 꺼내는 문법이 흩어지면 한 곳만 고쳐도 다른 곳이 남는다.
fn vault_keys(app: &tauri::AppHandle) -> crate::seal_keys::VaultKeys<'_> {
    crate::seal_keys::VaultKeys(tauri::Manager::state::<crate::secrets::SecretsState>(app).inner())
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        crate::login_shell::ambient()
    }
}

// 셸 통합 스크립트를 바이너리에 임베드.

// 셸 env 규칙은 코어가 소유한다(soksak_core::shell_env) — 화이트리스트가 두 벌이면
// 시크릿 유출이 프로세스마다 다르고, 그 차이는 "그쪽 터미널에서만 새는" 조용한 구멍이다.
// 프로세스의 사실(부모 env·앱 소켓·끊을 AI 세션 키)만 여기서 읽어 넘긴다.
/// 사용자의 원래 ZDOTDIR — zsh 통합이 그 설정을 먼저 source 한다. 프로세스 환경의 사실이라
/// 여기서 읽어 넘긴다(코어가 읽으면 같은 코드가 프로세스마다 다른 설정을 붙인다).
fn orig_zdotdir() -> String {
    std::env::var("ZDOTDIR")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default()
}

fn build_session_env(
    shell: &str,
    pane_id: &Option<String>,
    window_label: &Option<String>,
) -> (Vec<(String, String)>, Vec<String>) {
    soksak_core::shell_env::session_env(
        shell,
        pane_id,
        window_label,
        std::env::vars(),
        // **홈의 주소를 준다 — 이 프로세스의 것이 아니라.** 프레임워크는 껍데기라 셸이 그
        // 껍데기를 겨눌 이유가 없다. cored 소켓은 홈당 하나이고, 그리로 온 명령은 그 창을 든
        // 쪽으로 배달된다 — 어느 프레임워크가 떠 있든 같은 `sok` 이 같은 일을 한다.
        // 예전에는 자기 소켓을 줬고, 그래서 터미널 안의 모든 도구가 한 껍데기에 묶였다.
        Some(crate::identity::ambient().cored_socket().to_string_lossy().as_ref()),
        &crate::process::AI_SESSION_ENV,
        &std::env::temp_dir(),
        &orig_zdotdir(),
    )
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
            std::sync::Arc::new(crate::activity_sink::AppSink(app.clone())),
            &vault_keys(&app),
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
            ChannelSink(on_output.clone()),
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
            Err(e) => daemon::notify_fallback(&crate::activity_sink::AppSink(app.clone()), &manager.link, &e),
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
            let (deliver, delivery) = spawn_delivery(ChannelSink(on_output));
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
        match daemon::read_sealed_screen(&vault_keys(&app), identity, win, &pane_id)? {
            Some(s) => Ok(Some(s)),
            None => match legacy_pane_id {
                Some(legacy) if !legacy.is_empty() => {
                    daemon::read_sealed_screen_adopting(&vault_keys(&app), identity, win, &legacy, &pane_id)
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
    // 판정은 코어의 daemon_status 하나다 — cored 도 같은 함수를 부른다. 여기 사본을 두면 같은
    // 데몬을 두 모양으로 답하고, 그 차이는 "판올림할 수 있는가"를 밖에서 읽는 값이라 곧
    // 잘못된 결정이 된다.
    #[cfg(unix)]
    {
        Ok(soksak_core::ptyd::daemon_status(&manager.link))
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
        let staged = daemon::stage_binary(manager.identity().home(), ptyd_source().as_deref())?;
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
    // 이름 검증·argv 조립은 코어가 소유한다(soksak_core::shellq) — cored 도 같은 로직으로
    // 답해야 두 프로세스가 같은 질문에 같은 답을 낸다.
    let shell = default_shell();
    if cfg!(windows) {
        if !soksak_core::shellq::is_safe_binary_name(&bin) {
            return false;
        }
        return std::process::Command::new(&shell)
            .args(["-Command", &format!("Get-Command {bin}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    let Some((prog, args)) = soksak_core::shellq::which_argv(&shell, &bin) else {
        return false;
    };
    std::process::Command::new(prog)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ptyd 클라이언트는 코어가 소유한다 — 앱과 헬퍼가 같은 데몬에 같은 방식으로 붙는다.
#[cfg(unix)]
use soksak_core::ptyd as daemon;


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
        let id = Identity::new("<local-evidence>/soksak-pty-seam-dev", "com.soksak.dev");
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

    /// 데몬 레그의 출구·열쇠는 계약이다 — 벤더 타입은 커맨드 진입점에서 멈춘다.
    /// 함수 포인터로 시그니처를 못박는다: 벤더 타입이 돌아오면 여기서 컴파일이 깨진다.
    ///
    /// 봉인 열쇠도 계약으로 받는다(SealKeys). 볼트 상태를 프레임워크에서 꺼내던 한 줄 때문에
    /// "봉인된 화면을 읽는다"는 일 전체가 앱 프로세스에 묶여 있었다 — 열쇠가 필요한 것이지
    /// 프레임워크가 필요한 것이 아니다.
    #[cfg(unix)]
    #[test]
    fn the_daemon_leg_takes_contracts_not_vendor_types() {
        // 프레임워크 핸들이 **없다**. 하나라도 되돌아오면 이 자리에서 컴파일이 깨진다.
        let _typed: fn(
            std::sync::Arc<dyn crate::activity_sink::ActivitySink>,
            &dyn soksak_core::seal_keys::SealKeys,
            &std::sync::Arc<super::daemon::Link>,
            super::daemon::SpawnParams,
            NullSink,
        ) -> Result<u64, String> = super::daemon::spawn_via_daemon::<NullSink>;

        // 봉인 화면 읽기는 앱 핸들을 더 이상 요구하지 않는다.
        let _sealed: fn(
            &dyn soksak_core::seal_keys::SealKeys,
            &Identity,
            &str,
            &str,
        ) -> Result<Option<super::SealedScreen>, String> = super::daemon::read_sealed_screen;
    }

    /// 폴백 고지는 원장 한 줄이다 — 앱 핸들 없이 발행되고, 도배 방지 1회 게이트가 산다.
    #[cfg(unix)]
    #[test]
    fn the_fallback_notice_needs_only_a_ledger() {
        let link = super::daemon::Link::new(
            Identity::new("<local-evidence>/soksak-pty-seam-dev", "com.soksak.dev"),
            None,
        );
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
    use super::ReplayControl;



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
