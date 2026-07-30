// 데몬의 **프레임워크 몫** — 사건 통로와 커맨드 진입점뿐이다.
//
// 몸(스폰·출력 링·크래시 재시작·종료 사다리)은 soksak-daemon 이 진다. 데몬은 OS 프로세스이고,
// 이 몸이 프레임워크에서 쓰던 것은 사건 발행 한 자리뿐이었다.

use std::sync::Arc;

use std::collections::{HashMap, VecDeque};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use soksak_core::shellq::{ps_command_argv, reap_matches, ring_push, run_once_argv, RING_CAP};
use tauri::{AppHandle, Emitter, Manager, State};

pub use soksak_daemon::*;

/// 상태 변화가 가는 곳 — 이 프레임워크의 브로드캐스트.
struct AppDaemonEvents(AppHandle);

impl soksak_daemon::DaemonEvents for AppDaemonEvents {
    fn emit(&self, payload: Value) {
        let _ = self.0.emit("daemon", payload);
    }
}

/// 부팅 1회 — 사건 통로와 로그인 셸을 건넨다. 셸을 몸이 스스로 읽으면 재시작이 조용히 다른
/// 셸로 갈아탄다.
pub fn install(app: &AppHandle) {
    soksak_daemon::install_login_shell(crate::login_shell::ambient());
    let _ = app;
}

fn events(app: &AppHandle) -> Arc<dyn soksak_daemon::DaemonEvents> {
    Arc::new(AppDaemonEvents(app.clone()))
}

#[tauri::command]
pub fn daemon_start(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, DaemonManager>,
    root: String,
    name: String,
    cmd: String,
    restart: Option<String>,
) -> Result<u32, String> {
    soksak_daemon::start(
        state.inner(),
        events(&app),
        root,
        name,
        cmd,
        window.label().to_string(),
        restart.as_deref() == Some("on-crash"),
    )
}

#[tauri::command]
pub fn daemon_stop(
    state: State<'_, DaemonManager>,
    root: String,
    name: Option<String>,
) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let mut stopped = Vec::new();
    for e in map.values() {
        if e.root != root {
            continue;
        }
        if let Some(n) = &name {
            if &e.name != n {
                continue;
            }
        }
        if !e.running.lock().unwrap().0 {
            continue;
        }
        *e.stopping.lock().unwrap() = true;
        kill_group(&e.child, false);
        stopped.push(e.name.clone());
        // 유예 후 강제 — 관찰 스레드가 종료를 감지하면 즉시 반영되고, 이 에스컬레이션은 무해(멱등).
        let child = e.child.clone();
        let running = e.running.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(STOP_GRACE_SECS));
            if running.lock().unwrap().0 {
                kill_group(&child, true);
            }
        });
    }
    Ok(stopped)
}

#[tauri::command]
pub fn daemon_status(state: State<'_, DaemonManager>, root: Option<String>) -> Vec<DaemonStatus> {
    let map = state.inner.lock().unwrap();
    map.values()
        .filter(|e| root.as_deref().is_none_or(|r| e.root == r))
        .map(|e| {
            let (running, exit_code) = *e.running.lock().unwrap();
            DaemonStatus {
                root: e.root.clone(),
                name: e.name.clone(),
                pid: e.child.lock().unwrap().id(),
                running,
                exit_code,
                uptime_ms: e.started.elapsed().as_millis(),
                restarts: e.restarts,
            }
        })
        .collect()
}

#[tauri::command]
pub fn daemon_logs(
    state: State<'_, DaemonManager>,
    root: String,
    name: String,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let e = map
        .get(&key(&root, &name))
        .ok_or_else(|| format!("데몬 없음: {name}"))?;
    let ring = e.ring.lock().unwrap();
    let n = lines.unwrap_or(100).min(RING_CAP);
    Ok(ring.iter().rev().take(n).rev().cloned().collect())
}

/// 비정상 종료 뒤 잔존 회수 — 프런트가 로컬 DB 에 기록해 둔 (pid, cmd) 목록을 넘긴다.
/// pid 재사용으로 다른 프로세스를 잘못 종료하지 않도록, ps 명령줄이 선언 cmd 와 대조될 때만 그룹을 종료한다.
#[tauri::command]
pub fn daemon_reap(entries: Vec<(u32, String)>) -> Vec<u32> {
    let mut reaped = Vec::new();
    for (pid, cmd) in entries {
        #[cfg(unix)]
        {
            let (prog, argv) = ps_command_argv(pid);
            let out = Command::new(prog).args(argv).output();
            let alive_cmd = out
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            if !alive_cmd.is_empty() && reap_matches(&alive_cmd, &cmd) {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                reaped.push(pid);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = cmd;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
            reaped.push(pid);
        }
    }
    reaped
}

/// 일회 실행 — 분리 실행형 데몬의 종료 명령(docker compose down 등)을 돌리고 끝을 기다린다.

pub fn kill_all(app: &AppHandle) {
    app.state::<DaemonManager>().kill_all();
}

/// 일회 실행 진입점 — 몸은 soksak-daemon 이 진다.
#[tauri::command]
pub fn daemon_run_once(
    root: String,
    cmd: String,
    timeout_secs: Option<u64>,
    env: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    soksak_daemon::daemon_run_once(root, cmd, timeout_secs, env)
}
