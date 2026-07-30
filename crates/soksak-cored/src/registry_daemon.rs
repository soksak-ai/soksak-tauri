//! 데몬 명령의 몸 — 표는 registry_table.rs 가, 몸은 soksak-daemon 이 진다.
//!
//! 데몬은 OS 프로세스다. 창도 웹뷰도 필요 없고, 이 프로세스가 살아 있는 동안 자식도 산다 —
//! 그래서 여기서 답하는 것이 프레임워크에서 답하는 것보다 **수명이 맞다**. 앱이 껍데기를 갈아도
//! 데몬은 안 죽는다.
//!
//! 사건은 이 프로세스의 브로드캐스트로 나간다. 붙어 있는 모든 연결이 같은 한 줄을 받는다 —
//! 데몬 상태는 창 하나의 것이 아니다.

use serde_json::Value;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

/// 이 프로세스가 띄운 데몬들. 프로세스 하나에 장부 하나 — 둘이면 같은 이름이 둘 생긴다.
fn manager() -> &'static soksak_daemon::DaemonManager {
    static MGR: std::sync::OnceLock<soksak_daemon::DaemonManager> = std::sync::OnceLock::new();
    MGR.get_or_init(soksak_daemon::DaemonManager::default)
}

/// 상태 변화가 가는 곳 — 붙어 있는 모두에게.
struct Broadcast;

impl soksak_daemon::DaemonEvents for Broadcast {
    fn emit(&self, payload: Value) {
        crate::control::broadcast("daemon", payload);
    }
}

/// 부팅에서 확정된 셸. 없으면 이름을 달고 거절한다 — 조용히 `/bin/sh` 로 돌면 사용자가 쓰는
/// 셸의 PATH 를 못 받아 자식이 명령을 못 찾는다(GUI PATH 함정과 같은 자리).
///
/// 이 확인은 **인자 검증 뒤**에 온다. 앞에 두면 인자가 비어도 셸 사유부터 답해서, 부른 쪽은
/// 무엇이 틀렸는지 못 가린다.
fn shell(ctx: &Ctx) -> Result<String, String> {
    ctx.login_shell().map(str::to_string).ok_or_else(|| {
        "이 프로세스는 로그인 셸을 모른다 — 띄운 쪽이 --login-shell 로 넘겨야 한다".to_string()
    })
}

#[derive(serde::Deserialize)]
struct Start {
    root: String,
    name: String,
    cmd: String,
    #[serde(default)]
    window: String,
    #[serde(default)]
    restart: Option<String>,
}

pub(crate) fn run_daemon_start(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, move |a: Start| {
        soksak_daemon::start(
            manager(),
            std::sync::Arc::new(Broadcast),
            shell(ctx)?,
            a.root,
            a.name,
            a.cmd,
            a.window,
            a.restart.as_deref() == Some("on-crash"),
        )
    })
}

#[derive(serde::Deserialize)]
struct Stop {
    root: String,
    #[serde(default)]
    name: Option<String>,
}

pub(crate) fn run_daemon_stop(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Stop| {
        soksak_daemon::stop(manager(), a.root, a.name)
    })
}

#[derive(serde::Deserialize)]
struct Status {
    #[serde(default)]
    root: Option<String>,
}

pub(crate) fn run_daemon_status(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Status| {
        Ok(soksak_daemon::status(manager(), a.root))
    })
}

#[derive(serde::Deserialize)]
struct Logs {
    root: String,
    name: String,
    #[serde(default)]
    lines: Option<usize>,
}

pub(crate) fn run_daemon_logs(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Logs| {
        soksak_daemon::logs(manager(), a.root, a.name, a.lines)
    })
}

#[derive(serde::Deserialize)]
struct Reap {
    entries: Vec<(u32, String)>,
}

pub(crate) fn run_daemon_reap(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Reap| Ok(soksak_daemon::reap(a.entries)))
}

#[derive(serde::Deserialize)]
struct RunOnce {
    root: String,
    cmd: String,
    #[serde(default, rename = "timeoutSecs")]
    timeout_secs: Option<u64>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
}

pub(crate) fn run_daemon_run_once(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, move |a: RunOnce| {
        soksak_daemon::run_once(shell(ctx)?, a.root, a.cmd, a.timeout_secs, a.env)
    })
}
