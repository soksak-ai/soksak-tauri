// 데몬의 **프레임워크 몫** — 사건 통로와 커맨드 진입점뿐이다.
//
// 몸(스폰·출력 링·크래시 재시작·종료 사다리)은 soksak-daemon 이 진다. 데몬은 OS 프로세스이고,
// 이 몸이 프레임워크에서 쓰던 것은 사건 발행 한 자리뿐이었다.

use std::sync::Arc;

use std::collections::HashMap;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub use soksak_daemon::*;

/// 상태 변화가 가는 곳 — 이 프레임워크의 브로드캐스트.
struct AppDaemonEvents(AppHandle);

impl soksak_daemon::DaemonEvents for AppDaemonEvents {
    fn emit(&self, payload: Value) {
        let _ = self.0.emit("daemon", payload);
    }
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
        crate::login_shell::ambient(),
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
    soksak_daemon::stop(state.inner(), root, name)
}

#[tauri::command]
pub fn daemon_status(state: State<'_, DaemonManager>, root: Option<String>) -> Vec<DaemonStatus> {
    soksak_daemon::status(state.inner(), root)
}

#[tauri::command]
pub fn daemon_logs(
    state: State<'_, DaemonManager>,
    root: String,
    name: String,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    soksak_daemon::logs(state.inner(), root, name, lines)
}

#[tauri::command]
pub fn daemon_reap(entries: Vec<(u32, String)>) -> Vec<u32> {
    soksak_daemon::reap(entries)
}

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
    soksak_daemon::run_once(crate::login_shell::ambient(), root, cmd, timeout_secs, env)
}
