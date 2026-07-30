//! 서빙 표 — 이름·인자·반환을 선언하고, 실행은 soksak-core 로 위임한다.
//!
//! 표에 있는 이름은 앱이 `#[tauri::command]` 로 노출하는 이름 그대로다. 인자 표기도
//! 그대로다(Tauri 가 JS 로 넘길 때 쓰는 camelCase). 프레임워크가 이름이나 인자를 번역해야 한다면
//! 그 번역이 새 드리프트 면이 된다 — 같은 이름으로 물어 같은 답을 받는 것이 요점이다.
//!
//! 각 핸들러는 **코어 함수 호출 한 줄**이다. 판단을 여기 넣지 마라: 판단이 여기 있으면
//! 앱 경로와 cored 경로가 서로 다른 답을 낼 수 있고, 그 차이는 조용하다.
//!
//! 여기 없는 이름은 이름을 달고 실패한다. 프레임워크가 아직 소유한 것(창·웹뷰·엔진)을 cored 가
//! 아는 척하지 않는다 — 모르는 것을 모른다고 답하는 것이 이 표의 절반이다.

use std::process::Stdio;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use soksak_core::{
    artifact_integrity, fsx, identity, pathx, plugin_data, plugin_dir, probe, session, skillgen, themes,
    udp, unit_dev, unit_target,
};

use crate::ctx::Ctx;

/// 명령 하나의 결과. 인자 해석 실패와 로직 실패를 가른다 — 부르는 쪽이 "내가 잘못 물었나,
/// 물음은 맞는데 안 되나"를 코드로 구분할 수 있어야 한다.
pub enum Outcome {
    /// 앱의 `invoke` 가 돌려주는 값 **그대로**. 봉투는 호출자가 얹는다.
    Ok(Value),
    /// 인자를 이 명령의 모양으로 읽을 수 없다.
    InvalidParams(String),
    /// 인자는 맞고 로직이 거부했다. message 는 코어 로직의 사유 그대로다.
    Failed(String),
}

/// 인자 선언 — 물어서 알 수 있어야 한다(cored.commands).
pub struct Arg {
    pub name: &'static str,
    pub ty: &'static str,
    pub required: bool,
}

/// 명령 선언 + 실행.
pub struct Command {
    pub name: &'static str,
    pub args: &'static [Arg],
    /// 반환 값의 모양. 봉투가 아니라 `data` 에 실리는 값을 말한다.
    pub returns: &'static str,
    /// 실행 = 부팅 상태 + 호출자 인자. 둘을 섞지 않는 것이 이 표의 규율이다.
    pub run: fn(&Ctx, &Value) -> Outcome,
}

pub(crate) const REQ: bool = true;
pub(crate) const OPT: bool = false;

/// 명령 표 — 선언은 registry_table.rs 가 단일 진실이다(몸과 갈라 둔다).
pub use crate::registry_table::COMMANDS;


/// 옮기려다 막힌 것들 — 이름과 사유는 `unserved.rs` 가 단일 진실이다.
pub use crate::unserved::{Unserved, UNSERVED};


pub fn unserved(name: &str) -> Option<&'static Unserved> {
    UNSERVED.iter().find(|u| u.name == name)
}

pub fn find(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

/// 표 자체를 값으로 — 코드를 읽어야 아는 것이 아니라 물어서 아는 것이다(R7).
pub fn declaration() -> Value {
    let commands: Vec<Value> = COMMANDS
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "args": c.args.iter().map(|a| json!({
                    "name": a.name,
                    "type": a.ty,
                    "required": a.required,
                })).collect::<Vec<_>>(),
                "returns": c.returns,
            })
        })
        .collect();
    // 못 하는 것도 같은 자리에서 답한다 — 모르는 것을 모른다고 말하는 것이 이 표의 절반이다.
    let unserved: Vec<Value> = UNSERVED
        .iter()
        .map(|u| json!({ "name": u.name, "blockedBy": u.blocked_by }))
        .collect();
    json!({ "commands": commands, "unserved": unserved })
}

// ── 인자 해석 ────────────────────────────────────────────────────────────────

// Tauri 가 JS 로 넘기는 이름 그대로(camelCase) 읽는다. 생략과 명시적 null 을 같게 받는다 —
// 프론트가 `?? null` 로 보내는 자리가 있다(catalogNetwork.ts).
fn args<T: DeserializeOwned>(params: &Value) -> Result<T, String> {
    let v = if params.is_null() { Value::Object(Default::default()) } else { params.clone() };
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// 인자 해석 → 실행 → 직렬화. 세 단계 각각의 실패가 서로 다른 사유로 드러난다.
pub(crate) fn dispatch<T, R>(params: &Value, work: impl FnOnce(T) -> Result<R, String>) -> Outcome
where
    T: DeserializeOwned,
    R: serde::Serialize,
{
    let parsed: T = match args(params) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e),
    };
    match work(parsed) {
        Err(e) => Outcome::Failed(e),
        Ok(value) => match serde_json::to_value(value) {
            Ok(v) => Outcome::Ok(v),
            // 직렬화 실패는 로직 실패가 아니라 이 배선의 결함이다 — 조용히 삼키지 않는다.
            Err(e) => Outcome::Failed(format!("응답 직렬화 실패: {e}")),
        },
    }
}

// ── 핸들러 — 전부 코어 호출 한 줄 ──────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UdpSend {
    host: String,
    port: u16,
    data: Vec<u8>,
    #[serde(default)]
    broadcast: Option<bool>,
}

pub(crate) fn run_net_udp_send(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: UdpSend| {
        udp::net_udp_send(a.host, a.port, a.data, a.broadcast)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UdpRequest {
    host: String,
    port: u16,
    data: Vec<u8>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_packets: Option<usize>,
}

pub(crate) fn run_net_udp_request(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: UdpRequest| {
        udp::net_udp_request(a.host, a.port, a.data, a.timeout_ms, a.max_packets)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryIntegrity {
    bin_path: String,
    lib_path: String,
}

pub(crate) fn run_binary_integrity(_ctx: &Ctx, params: &Value) -> Outcome {
    // 이 관찰은 실패하지 않는다(부재도 답이다) — Ok 로 감싸 dispatch 의 한 경로를 쓴다.
    dispatch(params, |a: BinaryIntegrity| {
        Ok(artifact_integrity::binary_integrity(a.bin_path, a.lib_path))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupStale {
    path: String,
    allowed_roots: Vec<String>,
}

pub(crate) fn run_cleanup_stale(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: CleanupStale| {
        artifact_integrity::cleanup_stale(a.path, a.allowed_roots)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyAndLink {
    src: String,
    dest: String,
    sha256: String,
}

pub(crate) fn run_verify_and_link(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: VerifyAndLink| {
        artifact_integrity::verify_and_link(a.src, a.dest, a.sha256)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadVerify {
    url: String,
    dest: String,
    sha256: String,
}

pub(crate) fn run_download_verify(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: DownloadVerify| {
        let body = soksak_net::transport::honest_get_bytes(&a.url)?;
        artifact_integrity::verify_and_write(&body, &a.sha256, std::path::Path::new(&a.dest))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionDetect {
    command_line: String,
}

pub(crate) fn run_ai_session_detect(_ctx: &Ctx, params: &Value) -> Outcome {
    // 종류 이름은 AgentKind::as_str 이 소유한다 — 여기서 문자열을 새로 짓지 않는다.
    dispatch(params, |a: AiSessionDetect| {
        Ok(session::detect_agent(&a.command_line).map(|k| k.as_str().to_string()))
    })
}

/// 인자를 받지 않는 명령 — 앱의 같은 명령도 받지 않는다. `{}`·`null` 둘 다 허용하고
/// 낯선 키가 실려 와도 거부하지 않는다(프레임워크가 봉투에 무엇을 더 얹든 이 명령의 답은 같다).
#[derive(serde::Deserialize)]
struct NoArgs {}

pub(crate) fn run_themes_scan(ctx: &Ctx, params: &Value) -> Outcome {
    // 홈은 부팅 상태에서 온다. 앱은 `identity::ambient().themes_dir()` 로 같은 곳을 본다.
    dispatch(params, |_: NoArgs| {
        themes::scan(&ctx.identity().themes_dir())
    })
}

#[derive(serde::Deserialize)]
struct ThemeInstallArgs {
    path: String,
}

pub(crate) fn run_theme_install(ctx: &Ctx, params: &Value) -> Outcome {
    // 쓰기 잠금(store_lock)을 걸지 않는다 — 그것은 app.data 의 쓰기 소유권이고, 테마는
    // 저장소가 아니라 홈 아래 파일이다(plugin_data_write 와 같은 자리). 목적지 디렉터리는
    // 코어가 만든다: 읽기는 만들지 않고 쓰기는 만든다는 규칙을 두 프로세스가 함께 진다.
    dispatch(params, |a: ThemeInstallArgs| {
        themes::install(&ctx.identity().themes_dir(), &a.path)
    })
}

#[derive(serde::Deserialize)]
struct WhichArgs {
    bin: String,
}

pub(crate) fn run_shell_which(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WhichArgs| {
        let Some(shell) = ctx.login_shell() else {
            return Err(
                "로그인 셸을 받지 못했다 — 띄운 쪽이 --login-shell 로 넘겨야 한다(자기 환경을 \
                 읽으면 띄운 쪽과 다른 답이 나온다)"
                    .to_string(),
            );
        };
        // 이름 검증에 걸리면 셸에 닿기 전에 false 다. 물어보지 못한 것과 없는 것을 같은 값으로
        // 답하는 셈이지만, 앱의 같은 명령이 그렇게 답해 왔고 호출자는 bool 하나만 본다.
        let Some((prog, args)) = soksak_core::shellq::which_argv(shell, &a.bin) else {
            return Ok(false);
        };
        Ok(std::process::Command::new(prog)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false))
    })
}

#[derive(serde::Serialize)]
struct NpmDirs {
    bin_dir: String,
    lib_dir: String,
}

pub(crate) fn run_npm_global_dirs(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        let Some(shell) = ctx.login_shell() else {
            return Err("로그인 셸을 받지 못했다 — 띄운 쪽이 --login-shell 로 넘겨야 한다".to_string());
        };
        let (prog, args) = soksak_core::shellq::npm_prefix_argv(shell);
        let out = std::process::Command::new(prog)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        let (bin_dir, lib_dir) =
            soksak_core::shellq::npm_dirs_from_prefix(&String::from_utf8_lossy(&out.stdout))?;
        Ok(NpmDirs { bin_dir, lib_dir })
    })
}

pub(crate) fn run_unit_dev_list(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        let core_build = ctx.identity().core_build();
        let p = unit_dev::list_accepted(ctx.home(), &core_build)?;
        // 갈라 낸 것은 버리지 않는다 — 왜 안 보이는지가 답의 일부다.
        for r in &p.rejected {
            eprintln!(
                "[unit-dev] dev 소스 거부(읽기 경계, identity={core_build}): {} {} — {}",
                r.kind, r.id, r.source
            );
        }
        Ok(p.accepted)
    })
}

#[derive(serde::Deserialize)]
struct SourceOnly {
    source: String,
}

pub(crate) fn run_unit_dev_validate_path(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SourceOnly| {
        unit_dev::validate_source_exists(std::path::Path::new(&a.source))?;
        Ok(a.source)
    })
}

#[derive(serde::Deserialize)]
struct RecentArgs {
    #[serde(default)]
    since: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) fn run_activity_recent(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: RecentArgs| {
        use soksak_core::activity as act;
        let conn = ctx.open_db()?;
        let mut q = conn.prepare(act::RECENT_SQL).map_err(|e| e.to_string())?;
        let rows = q
            .query_map(rusqlite::params![act::NS, act::COLL], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for row in rows {
            let doc = row.map_err(|e| e.to_string())?;
            // 못 읽는 줄은 건너뛰지 않는다 — 조용히 빠지면 커서가 어긋난 것을 아무도 모른다.
            entries.push(serde_json::from_str(&doc).map_err(|e| format!("원장 행 파싱 실패: {e}"))?);
        }
        // 앱의 기본 상한과 같다(200) — 다르면 같은 호출이 프로세스마다 다른 길이를 답한다.
        Ok(act::pick_recent(entries, a.since, a.limit.unwrap_or(200)))
    })
}

/// 이 프로세스가 낳은 자식들. 앱의 ProcessManager 와 같은 자리다.
static PROCS: std::sync::OnceLock<soksak_core::proc::ProcessManager> = std::sync::OnceLock::new();

fn procs() -> &'static soksak_core::proc::ProcessManager {
    PROCS.get_or_init(soksak_core::proc::ProcessManager::default)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnProc {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    env_remove: Option<Vec<String>>,
    #[serde(default)]
    scrub_ai_env: Option<bool>,
    #[serde(default)]
    group: Option<bool>,
    #[serde(default)]
    detached: Option<bool>,
    #[serde(default)]
    ns: Option<String>,
    #[serde(default)]
    secret_env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    window: Option<String>,
}

#[cfg(unix)]
pub(crate) fn run_process_spawn(ctx: &Ctx, params: &Value) -> Outcome {
    let stripped = soksak_core::stream::without_tokens(params);
    let a: SpawnProc = match serde_json::from_value(stripped) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e.to_string()),
    };
    // 세 출구는 각각 자기 토큰으로 간다 — 하나로 묶으면 소비자가 stdout·stderr·종료를 못 가른다.
    let mut by_arg: std::collections::HashMap<String, String> =
        soksak_core::stream::tokens(params).into_iter().collect();
    let mut want = |arg: &str| {
        by_arg
            .remove(arg)
            .ok_or_else(|| format!("{arg} 스트림 토큰이 없습니다"))
    };
    let (out, err, exit) = match (want("onStdout"), want("onStderr"), want("onExit")) {
        (Ok(o), Ok(e), Ok(x)) => (o, e, x),
        (a, b, c) => {
            let why = [a.err(), b.err(), c.err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; ");
            return Outcome::Failed(why);
        }
    };
    let r = soksak_core::proc::spawn_child(
        ctx.identity(),
        &std::env::vars().map(|(k, _)| k).collect::<Vec<_>>(),
        soksak_core::proc::SpawnRequest {
            cmd: a.cmd,
            args: a.args,
            cwd: a.cwd,
            env: a.env,
            env_remove: a.env_remove,
            scrub_ai_env: a.scrub_ai_env.unwrap_or(false),
            group: a.group.unwrap_or(false),
            detached: a.detached.unwrap_or(false),
            ns: a.ns,
            secret_env: a.secret_env,
            // 창은 부른 쪽이 스탬프한 회수 좌표다 — 이 프로세스에는 창이 없다.
            window: a.window.unwrap_or_default(),
        },
        procs(),
        // 이 프로세스에는 볼트가 없다 — **선언한다**. 빈 값을 주면 자식이 빈 토큰으로 붙고
        // 그 인증 실패가 "설정이 틀렸다"로 보고된다.
        &soksak_core::secret_env::NoSecrets,
        crate::pty::TokenSink::new(out),
        crate::pty::TokenSink::new(err),
        crate::pty::ExitTokenSink::new(exit),
    );
    match r {
        Ok(id) => Outcome::Ok(Value::from(id)),
        Err(e) => Outcome::Failed(e),
    }
}

#[derive(serde::Deserialize)]
struct WindowLabel {
    window: String,
}

pub(crate) fn run_process_reclaim_by_window(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WindowLabel| {
        Ok(Value::from(procs().reclaim_window(&a.window)))
    })
}

#[derive(serde::Deserialize)]
struct ProcWrite {
    id: u32,
    data: String,
}

pub(crate) fn run_process_write(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ProcWrite| {
        procs()
            .write_stdin(a.id, a.data.as_bytes())
            .map(|_| Value::Null)
    })
}

pub(crate) fn run_process_stdin_close(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermId| {
        procs().close_stdin(a.id).map(|_| Value::Null)
    })
}

pub(crate) fn run_process_list(_ctx: &Ctx, _params: &Value) -> Outcome {
    match serde_json::to_value(procs().list()) {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

pub(crate) fn run_process_kill(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermId| {
        procs().kill(a.id);
        Ok(Value::Null)
    })
}

#[derive(serde::Deserialize)]
struct DataDefine {
    ns: String,
    coll: String,
    indexes: Vec<String>,
    fts: Vec<String>,
}

pub(crate) fn run_data_define(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: DataDefine| {
        soksak_core::kv::validate_ns(&a.ns)?;
        let conn = ctx.open_db()?;
        soksak_store::store::define(&conn, &a.ns, &a.coll, &a.indexes, &a.fts).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrateNs {
    from_ns: String,
    to_ns: String,
}

pub(crate) fn run_data_migrate_ns(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: MigrateNs| {
        soksak_core::kv::validate_ns(&a.from_ns)?;
        soksak_core::kv::validate_ns(&a.to_ns)?;
        if a.from_ns == a.to_ns {
            // 같은 ns 는 이행이 아니다 — 성공으로 답하되 사유를 값에 실어 부른 쪽이 가른다.
            return Ok(json!({ "migrated": false, "reason": "same-ns" }));
        }
        let conn = ctx.open_db()?;
        let out = soksak_store::store::migrate_ns(&conn, &a.from_ns, &a.to_ns)?;
        serde_json::to_value(out).map_err(|e| e.to_string())
    })
}

#[derive(serde::Deserialize)]
struct DataQuery {
    ns: String,
    coll: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    filter: Option<Value>,
    #[serde(default)]
    order: Option<String>,
    #[serde(default)]
    desc: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

pub(crate) fn run_data_query(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: DataQuery| {
        soksak_core::kv::validate_ns(&a.ns)?;
        let conn = ctx.open_db()?;
        // 봉인된 필드는 이 프로세스가 못 연다(볼트 없음) — 열쇠 해소자는 **없음**을 답한다.
        // 지어낸 열쇠로 열려 들면 쓰레기를 평문으로 답하게 된다.
        let rows = soksak_store::store::query(
            &conn,
            &a.ns,
            &a.coll,
            a.scope.as_deref(),
            a.filter.as_ref(),
            a.order.as_deref(),
            a.desc.unwrap_or(true),
            a.limit,
            a.offset,
            // 봉인 필드를 열 열쇠가 없다는 것을 **선언한다**. 지어낸 해소자를 주면 쓰레기를
            // 평문으로 답하고, 그 오답은 오류로 보이지 않는다.
            None,
        )?;
        Ok(Value::Array(rows))
    })
}

/// 이 프로세스의 워처. 규칙은 크레이트가 소유하고(soksak-watch), 뿌리는 자리만 여기서 준다.
///
/// 첫 감시에서 세운다 — 부팅에서 세우면 감시를 한 번도 안 쓰는 프로세스까지 OS 핸들을 연다.
static WATCHER: std::sync::OnceLock<soksak_watch::FsWatcher> = std::sync::OnceLock::new();

fn watcher() -> &'static soksak_watch::FsWatcher {
    WATCHER.get_or_init(|| {
        let w = soksak_watch::FsWatcher::default();
        // 변경된 디렉터리를 창 전부에 뿌린다 — 앱의 emit("fs-change") 과 **같은 이름**이다.
        // 이름이 다르면 프론트가 프레임워크를 가려야 한다.
        w.init_with(|dir| {
            crate::control::broadcast("fs-change", Value::String(dir));
        });
        w
    })
}

#[derive(serde::Deserialize)]
struct WatchPath {
    path: String,
}

pub(crate) fn run_watch_dir(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WatchPath| {
        watcher().watch(&a.path).map(|n| Value::from(n as u64))
    })
}

pub(crate) fn run_unwatch_dir(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WatchPath| {
        watcher().unwatch(&a.path).map(|n| Value::from(n as u64))
    })
}

#[cfg(unix)]
pub(crate) fn run_spawn_terminal(ctx: &Ctx, params: &Value) -> Outcome {
    // 토큰은 인자에서 읽고 명령의 몸에는 넘기지 않는다 — 몸이 토큰을 알면 명령마다
    // "이 인자는 무시하라"를 따로 알아야 한다.
    let stripped = soksak_core::stream::without_tokens(params);
    let a: crate::pty::SpawnArgs = match serde_json::from_value(stripped) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e.to_string()),
    };
    match crate::pty::spawn(ctx, params, a) {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e),
    }
}

#[derive(serde::Deserialize)]
struct TermWrite {
    id: u32,
    data: String,
}

#[cfg(unix)]
pub(crate) fn run_write_terminal(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermWrite| {
        crate::pty::write(ctx, a.id, &a.data).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
struct TermResize {
    id: u32,
    cols: u16,
    rows: u16,
}

#[cfg(unix)]
pub(crate) fn run_resize_terminal(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermResize| {
        crate::pty::resize(ctx, a.id, a.cols, a.rows).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
struct TermAck {
    id: u32,
    bytes: u64,
}

#[cfg(unix)]
pub(crate) fn run_ack_terminal(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermAck| {
        crate::pty::ack(ctx, a.id, a.bytes).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
struct TermId {
    id: u32,
}

#[cfg(unix)]
pub(crate) fn run_close_terminal(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TermId| {
        crate::pty::close(ctx, a.id).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneId {
    pane_id: String,
}

#[derive(serde::Deserialize)]
struct SidecarRequest {
    request: Value,
}

#[cfg(unix)]
pub(crate) fn run_pty_sidecar_request(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SidecarRequest| {
        soksak_core::ptyd::sidecar_service_relay(ctx.identity(), &a.request)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedScreenArgs {
    #[serde(default)]
    window_label: Option<String>,
    pane_id: String,
    #[serde(default)]
    legacy_pane_id: Option<String>,
}

#[cfg(unix)]
pub(crate) fn run_pty_read_sealed_screen(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SealedScreenArgs| {
        crate::pty::read_sealed_screen(
            ctx,
            a.window_label.as_deref(),
            &a.pane_id,
            a.legacy_pane_id.as_deref(),
        )
    })
}

#[cfg(unix)]
pub(crate) fn run_pty_pane_alive(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PaneId| {
        crate::pty::pane_alive(ctx, &a.pane_id).map(Value::Bool)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowFacts {
    live: Vec<String>,
    focused: String,
}

#[cfg(unix)]
pub(crate) fn run_control_host_attach(_ctx: &Ctx, params: &Value) -> Outcome {
    let a: WindowFacts = match serde_json::from_value(params.clone()) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e.to_string()),
    };
    // 연결 없이 온 등록은 성공시키지 않는다 — 성공을 답하고 배달하지 않으면 하니스는
    // "명령이 사라진다"만 보게 된다.
    let Some(w) = crate::wire::current_conn() else {
        return Outcome::Failed("이 연결로는 배달할 수 없습니다(연결 사본 실패)".into());
    };
    crate::control::attach_host(w, a.live, a.focused);
    Outcome::Ok(Value::Null)
}

#[cfg(not(unix))]
pub(crate) fn run_control_host_attach(_ctx: &Ctx, _params: &Value) -> Outcome {
    Outcome::Failed("배달 통로는 유닉스 소켓 위에서만 섭니다".into())
}

#[cfg(unix)]
pub(crate) fn run_control_bridge_attach(_ctx: &Ctx, _params: &Value) -> Outcome {
    crate::wire::mark_bridge();
    Outcome::Ok(Value::Null)
}

#[cfg(not(unix))]
pub(crate) fn run_control_bridge_attach(_ctx: &Ctx, _params: &Value) -> Outcome {
    Outcome::Failed("연결 역할 선언은 유닉스 소켓 위에서만 섭니다".into())
}

/// 창 사실 갱신 — **자기 창에 대해서만**이다. 그래서 화자를 연결로 안다: 한 프레임워크의
/// 보고가 다른 프레임워크의 창까지 갈아치우면 그쪽 창이 보고 한 번에 주소를 잃는다.
#[cfg(unix)]
pub(crate) fn run_control_windows(_ctx: &Ctx, params: &Value) -> Outcome {
    let a: WindowFacts = match serde_json::from_value(params.clone()) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e.to_string()),
    };
    let Some(c) = crate::wire::current_conn() else {
        return Outcome::Failed("연결 없이 온 창 보고는 어느 호스트의 것인지 알 수 없습니다".into());
    };
    Outcome::Ok(Value::Bool(crate::control::update_windows(
        c.id(),
        a.live,
        a.focused,
    )))
}

#[cfg(not(unix))]
pub(crate) fn run_control_windows(_ctx: &Ctx, _params: &Value) -> Outcome {
    Outcome::Failed("배달 통로는 유닉스 소켓 위에서만 섭니다".into())
}

#[derive(serde::Deserialize)]
struct CmdResult {
    id: u64,
    result: Value,
}

pub(crate) fn run_cmd_result(_ctx: &Ctx, params: &Value) -> Outcome {
    let a: CmdResult = match serde_json::from_value(params.clone()) {
        Ok(v) => v,
        Err(e) => return Outcome::InvalidParams(e.to_string()),
    };
    Outcome::Ok(Value::Bool(crate::control::deliver_result(a.id, a.result)))
}

pub(crate) fn run_plugin_scan(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        plugin_dir::scan(&ctx.identity().plugins_dir())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginId {
    id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginKey {
    id: String,
    key: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginValue {
    id: String,
    key: String,
    value: String,
}

pub(crate) fn run_plugin_data_list(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PluginId| {
        plugin_data::list(&ctx.identity().plugin_data_dir(), &a.id)
    })
}

pub(crate) fn run_plugin_data_read(ctx: &Ctx, params: &Value) -> Outcome {
    // 없는 key 는 null 이고 그것은 실패가 아니다 — 사유는 코어가 적는다.
    dispatch(params, |a: PluginKey| {
        plugin_data::read(&ctx.identity().plugin_data_dir(), &a.id, &a.key)
    })
}

pub(crate) fn run_plugin_data_write(ctx: &Ctx, params: &Value) -> Outcome {
    // 저장소 쓰기(data_kv_set)와 달리 잠금을 요구하지 않는다: store_lock 은 app.data 의
    // 쓰기 소유권이고 이것은 그 파일이 아니다. 없는 잠금을 요구하면 앱이 도는 홈에서
    // 이 명령만 영영 거절되는데, 그 거절은 이 파일을 아무도 지키지 않는다는 사실을 바꾸지
    // 않는다(write_text_file 과 같은 자리다). 앱의 plugin_data_write 도 () 를 돌려준다.
    dispatch(params, |a: PluginValue| {
        plugin_data::write(&ctx.identity().plugin_data_dir(), &a.id, &a.key, &a.value)
            .map(|_| Value::Null)
    })
}

pub(crate) fn run_plugin_remove(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PluginId| {
        // 설치본은 읽기전용으로 잠겨 있다 — 풀지 않으면 제거가 막힌다. 언제 푸는지는 코어가
        // 정하고, 여기서는 그 한 걸음(스폰)만 준다. best-effort 인 것도 앱과 같다.
        plugin_dir::remove(&ctx.identity().plugins_dir(), &a.id, |dir| {
            let _ = std::process::Command::new("chmod")
                .arg("-R")
                .arg("u+w")
                .arg(dir)
                .output();
        })
        .map(|_| Value::Null)
    })
}

pub(crate) fn run_app_is_release(ctx: &Ctx, params: &Value) -> Outcome {
    // 판정 규칙은 코어가 소유한다 — 여기서 문자열을 다시 가르지 않는다.
    dispatch(params, |_: NoArgs| Ok(ctx.identity().is_release()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvGetArg {
    ns: String,
    key: String,
}

/// KvRows 의 SQLite 구현 — 질의문과 연결은 구현자의 것이라는 계약대로.
struct SqliteRows {
    conn: rusqlite::Connection,
}

impl soksak_core::kv::KvRows for SqliteRows {
    fn value(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
        // 질의문은 코어가 소유한다 — 두 프로세스가 각자 SQL 을 적으면 언젠가 갈라진다.
        match self
            .conn
            .query_row(soksak_core::kv::SELECT_SQL, (ns, key), |r| {
                r.get::<_, String>(0)
            }) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub(crate) fn run_data_kv_get(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvGetArg| {
        // 읽기는 잠그지 않는다 — WAL 은 읽기 동시·쓰기 단일이고, 쓰기 소유권이 없어도
        // 관측은 되어야 한다(못 쓰는 것과 못 보는 것은 다른 사실이다).
        let conn = rusqlite::Connection::open_with_flags(
            ctx.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("저장소 열기 실패: {e}"))?;
        let rows = SqliteRows { conn };
        soksak_core::kv::get(&rows, &a.ns, &a.key)
    })
}

impl soksak_core::kv::KvWrite for SqliteRows {
    fn put(&self, ns: &str, key: &str, raw: &str, updated_ms: u64) -> Result<(), String> {
        self.conn
            .execute(soksak_core::kv::UPSERT_SQL, (ns, key, raw, updated_ms as i64))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl soksak_core::kv::KvDelete for SqliteRows {
    fn remove(&self, ns: &str, key: &str) -> Result<bool, String> {
        self.conn
            .execute(soksak_core::kv::DELETE_SQL, (ns, key))
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowTracesArg {
    label: String,
}

// 닫힌 창의 흔적 폐기 — **무엇을 지우는가는 코어가 정한다**(window_traces).
//
// 이 자리는 저장소를 여는 일만 한다. Tauri 는 자기 연결로 같은 규칙을 부르고(window.rs),
// Electron 은 이 명령으로 부른다 — 창을 부수는 쪽이 어디든 남는 것은 같아야 한다.
pub(crate) fn run_window_traces_prune(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WindowTracesArg| {
        if !ctx.owns_writes() {
            return Err(format!(
                "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 흔적 폐기는 그쪽이 한다",
                ctx.db_path().display()
            ));
        }
        let conn = ctx.open_db()?;
        let store = SqliteRows { conn };
        let ns = soksak_core::window_traces::NS;

        // ① 스냅샷. 없던 것을 지우는 것은 성공이다(멱등).
        let snapshot_removed =
            soksak_core::kv::delete(&store, ns, &soksak_core::window_traces::snapshot_key(&a.label))?;

        // ② manifest slot. 바뀐 게 없으면 저장하지 않는다 — 안 바뀐 값을 다시 쓰면 그 쓰기가
        // 다른 창의 동시 갱신을 되돌린다.
        let key = soksak_core::window_traces::MANIFEST_KEY;
        let mut slot_removed = false;
        if let Some(mut manifest) = soksak_core::kv::get(&store, ns, key)? {
            if soksak_core::window_traces::prune_slot(&mut manifest, &a.label) {
                soksak_core::kv::set(&store, ns, key, &manifest, crate::ledger::now_ms())?;
                slot_removed = true;
            }
        }
        Ok(serde_json::json!({ "snapshot": snapshot_removed, "slot": slot_removed }))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvSetArg {
    ns: String,
    key: String,
    value: Value,
}

// ── 저장소 표면의 배선 ────────────────────────────────────────────────────────
//
// 판정은 하나도 여기 없다 — 전부 soksak-store 를 부른다. 여기서 한 줄이라도 판정하면 앱 경로와
// 이 경로가 다르게 답할 수 있고, 그 차이는 오류가 아니라 **다른 데이터**로 나타난다.
//
// 쓰기는 소유권을 **열기 전에** 본다. 열고 나서 판단하면 그 사이가 곧 이중 쓰기 창이다.

fn deny_without_write_ownership(ctx: &Ctx) -> Result<(), String> {
    if ctx.owns_writes() {
        return Ok(());
    }
    Err(format!(
        "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 같은 홈에 앱이나 다른 cored 가 \
         살아 있다. 읽기는 계속 서빙한다",
        ctx.db_path().display()
    ))
}

#[derive(serde::Deserialize)]
struct NsArg {
    ns: String,
}

pub(crate) fn run_data_ns_remove(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: NsArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        let r = soksak_store::store::drop_ns(&conn, &a.ns)?;
        serde_json::to_value(r).map_err(|e| e.to_string())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportArg {
    ns: Option<String>,
    coll: Option<String>,
}

pub(crate) fn run_data_export(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ExportArg| {
        let conn = ctx.open_db()?;
        soksak_store::backup::export(&conn, a.ns.as_deref(), a.coll.as_deref()).map(Value::String)
    })
}

#[derive(serde::Deserialize)]
struct ImportArg {
    jsonl: String,
}

pub(crate) fn run_data_import(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ImportArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::backup::import(&conn, &a.jsonl).map(Value::from)
    })
}

#[derive(serde::Deserialize)]
struct BackupArg {
    path: Option<String>,
}

pub(crate) fn run_data_backup(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: BackupArg| {
        // 백업은 읽기지만 VACUUM INTO 라 저장소를 통째로 훑는다. 소유권을 안 보는 대신
        // **대상 경로는 호출자가 준다** — 여기서 기본 자리를 지어내면 앱이 쓰는 자리와
        // 갈리고, 그 차이는 "백업이 어디 갔지"로 나타난다.
        let dest = a
            .path
            .ok_or_else(|| "백업 대상 경로가 없다 — 이 프로세스는 자리를 지어내지 않는다".to_string())?;
        let conn = ctx.open_db()?;
        soksak_store::backup::backup(&conn, std::path::Path::new(&dest))?;
        Ok(Value::String(dest))
    })
}

#[derive(serde::Deserialize)]
struct RestorePathArg {
    path: String,
}

pub(crate) fn run_data_restore(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: RestorePathArg| {
        deny_without_write_ownership(ctx)?;
        let src = std::path::PathBuf::from(&a.path);
        // 검증이 먼저다 — 못 쓸 파일로 덮어쓰면 되돌릴 것이 없다.
        soksak_store::backup::validate(&src)?;
        soksak_store::backup::restore_into(&ctx.db_path(), &src)?;
        Ok(Value::Null)
    })
}

pub(crate) fn run_data_verify(ctx: &Ctx, _params: &Value) -> Outcome {
    match ctx.open_db().and_then(|c| soksak_store::integrity::check(&c)) {
        Ok(v) => Outcome::Ok(Value::Array(v.into_iter().map(Value::String).collect())),
        Err(e) => Outcome::Failed(e),
    }
}

pub(crate) fn run_data_repair(ctx: &Ctx, _params: &Value) -> Outcome {
    match ctx
        .open_db()
        .and_then(|c| soksak_store::integrity::repair(&c))
        .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
    {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e),
    }
}

pub(crate) fn run_data_canary(ctx: &Ctx, _params: &Value) -> Outcome {
    if let Err(e) = deny_without_write_ownership(ctx) {
        return Outcome::Failed(e);
    }
    match ctx
        .open_db()
        .and_then(|c| soksak_store::integrity::write_canary(&c))
    {
        Ok(()) => Outcome::Ok(Value::Null),
        Err(e) => Outcome::Failed(e),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReapArg {
    ns: String,
    coll: String,
    cutoff_ms: i64,
}

pub(crate) fn run_data_retention_reap(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ReapArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::retention_reap_ttl(&conn, &a.ns, &a.coll, a.cutoff_ms)
            .map(|n| Value::from(n as u64))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimArg {
    ns: String,
    coll: String,
    scope: String,
    cap: i64,
}

pub(crate) fn run_data_retention_trim(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TrimArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::retention_trim(&conn, &a.ns, &a.coll, &a.scope, a.cap)
            .map(|n| Value::from(n as u64))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertArg {
    ns: String,
    coll: String,
    scope: String,
}

pub(crate) fn run_data_encrypt_convert(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ConvertArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        // batch 상한은 앱과 같은 값을 쓴다 — 다르면 같은 이름이 프로세스마다 다른 양을 옮긴다.
        soksak_store::store::convert_pending(&conn, &a.ns, &a.coll, &a.scope, ENCRYPT_CONVERT_BATCH)
            .map(|n| Value::from(n as u64))
    })
}

/// 한 번에 변환하는 레코드 수 — 앱의 data_encrypt_convert 와 같은 값이라야 한다.
const ENCRYPT_CONVERT_BATCH: i64 = 200;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutArg {
    ns: String,
    coll: String,
    scope: Option<String>,
    id: Option<String>,
    doc: Value,
}

pub(crate) fn run_data_put(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PutArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::put(
            &conn,
            &a.ns,
            &a.coll,
            a.scope.as_deref().unwrap_or(""),
            a.id,
            &a.doc,
        )
        .map(Value::String)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetArg {
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
}

pub(crate) fn run_data_get(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: GetArg| {
        // 읽기는 소유권을 안 본다 — 못 쓰는 것과 못 보는 것은 다른 사실이다(WAL 은 읽기 동시).
        let conn = ctx.open_db()?;
        // 복호 해석자는 `None` 이다 — 이 프로세스는 볼트를 열지 않는다. 봉인된 레코드는
        // 봉인된 채로 답한다. 그것을 여는 것은 볼트를 가진 쪽의 일이고, 여기서 흉내내면
        // 열쇠 없이 연 척하는 답이 나간다.
        soksak_store::store::get(
            &conn,
            &a.ns,
            &a.coll,
            &a.id,
            a.scope.as_deref(),
            None,
        )
        .map(|v| v.unwrap_or(Value::Null))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArg {
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
}

pub(crate) fn run_data_delete(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: DeleteArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::delete(&conn, &a.ns, &a.coll, &a.id, a.scope.as_deref())
            .map(Value::Bool)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountArg {
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
}

pub(crate) fn run_data_count(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: CountArg| {
        let conn = ctx.open_db()?;
        soksak_store::store::count(&conn, &a.ns, &a.coll, a.scope.as_deref(), a.filter.as_ref())
            .map(Value::from)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArg {
    ns: String,
    coll: String,
    query: String,
    scope: Option<String>,
    limit: Option<i64>,
}

pub(crate) fn run_data_search(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SearchArg| {
        let conn = ctx.open_db()?;
        // get 과 같은 이유로 해석자는 None 이다.
        soksak_store::store::search(
            &conn,
            &a.ns,
            &a.coll,
            &a.query,
            a.scope.as_deref(),
            a.limit,
            None,
        )
        .map(Value::Array)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvDeleteArg {
    ns: String,
    key: String,
}

pub(crate) fn run_data_kv_delete(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvDeleteArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::kv_delete(&conn, &a.ns, &a.key)?;
        Ok(Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvKeysArg {
    ns: String,
    prefix: Option<String>,
}

pub(crate) fn run_data_kv_keys(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvKeysArg| {
        let conn = ctx.open_db()?;
        soksak_store::store::kv_keys(&conn, &a.ns, a.prefix.as_deref())
            .map(|ks| Value::Array(ks.into_iter().map(Value::String).collect()))
    })
}

pub(crate) fn run_data_kv_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvSetArg| {
        // 소유권 먼저 — 열기 전에 거절한다. 열고 나서 판단하면 그 사이가 곧 이중 쓰기 창이다.
        if !ctx.owns_writes() {
            return Err(format!(
                "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 같은 홈에 앱이나 다른                  cored 가 살아 있다. 읽기는 계속 서빙한다",
                ctx.db_path().display()
            ));
        }
        let conn = ctx.open_db()?;
        let store = SqliteRows { conn };
        soksak_core::kv::set(&store, &a.ns, &a.key, &a.value, crate::ledger::now_ms())?;
        // 앱의 data_kv_set 은 () 를 돌려준다 — 같은 모양이라야 프레임워크가 값을 다시 조립하지 않는다.
        Ok(Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityPublish {
    kind: String,
    source: String,
    payload: Value,
}

pub(crate) fn run_activity_publish(ctx: &Ctx, params: &Value) -> Outcome {
    // 적재만 한다 — 단조·도장 규칙은 코어가, 원장 자원은 ledger 가 소유한다.
    dispatch(params, |a: ActivityPublish| {
        crate::ledger::admit(
            &ctx.db_path().to_string_lossy(),
            &a.kind,
            &a.source,
            a.payload,
        )
    })
}

pub(crate) fn run_app_environment(ctx: &Ctx, params: &Value) -> Outcome {
    // 파생 규칙은 코어가 소유한다. 정체성·홈은 부팅 상태에서 온다 — 앱이 프레임워크 설정에서
    // 받는 것과 같은 자리다(추측이 아니라 받는 것).
    dispatch(params, |_: NoArgs| {
        let id = ctx.identity();
        let core_build = id.core_build();
        let home = id.home().to_string_lossy().to_string();
        // 개발 유닛 선언은 홈 아래 config 파일이다. 없으면 빈 목록이 정답(공식 설치본만
        // 쓰는 상태) — 파일 부재를 오류로 올리면 정상 상태가 실패로 보인다.
        let units = unit_dev::read_declared(id.home())?;
        let (accepted, rejected): (Vec<_>, Vec<_>) = units.into_iter().partition(|u| {
            identity::dev_source_accepted(std::path::Path::new(&u.source), id.home(), &core_build)
        });
        Ok(json!({
            "coreBuild": core_build,
            "identity": id.identifier(),
            "cli": id.cli_name(),
            "home": home,
            // cored 는 릴리즈 프로파일로 배급된다 — 자기 빌드를 말하는 것이 정직하다.
            "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "updaterEnabled": id.is_release(),
            "unitMode": if accepted.is_empty() { "official" } else { "mixed" },
            "developmentUnits": accepted,
            "rejectedDevelopmentUnits": rejected,
        }))
    })
}

// ── 파일 읽기·쓰기 ──────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadText {
    path: String,
    #[serde(default)]
    offset: Option<u64>,
}

pub(crate) fn run_read_text_file(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ReadText| {
        fsx::read_text_file(&a.path, a.offset, ctx.user_home())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathOnly {
    path: String,
}

pub(crate) fn run_read_file_base64(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PathOnly| fsx::read_file_base64(&a.path))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteText {
    path: String,
    content: String,
}

pub(crate) fn run_write_text_file(_ctx: &Ctx, params: &Value) -> Outcome {
    // 저장소 쓰기와 달리 잠금을 요구하지 않는다 — 사유는 코어(fsx::write_text_file)가 적는다.
    // 앱의 write_text_file 도 () 를 돌려준다.
    dispatch(params, |a: WriteText| {
        fsx::write_text_file(&a.path, &a.content).map(|_| Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListChildren {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    meta: Option<bool>,
}

pub(crate) fn run_list_children(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ListChildren| {
        fsx::list_children(a.path.as_deref(), a.meta, ctx.user_home())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureProjectDir {
    folder: String,
}

pub(crate) fn run_ensure_project_dir(ctx: &Ctx, params: &Value) -> Outcome {
    // 앱이 만든 폴더는 앱 관리 영역에 산다 — 여기만 정체성 홈을 본다.
    dispatch(params, |a: EnsureProjectDir| {
        fsx::ensure_project_dir(&a.folder, ctx.identity())
    })
}

pub(crate) fn run_validate_project_root(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PathOnly| {
        fsx::validate_project_root(&a.path, ctx.user_home())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use soksak_core::identity::Identity;

    /// 검증용 부팅 상태. 이 표의 검사들은 **인자 해석**을 보는 것이라 어느 홈이든 같다.
    fn ctx() -> Ctx {
        Ctx::new(Identity::new("/tmp/soksak-registry-test", "com.soksak.dev"))
    }


    /// 한 이름이 서빙과 미서빙 양쪽에 있으면 답이 둘이 된다.
    #[test]
    fn no_name_is_both_served_and_refused() {
        for u in UNSERVED {
            assert!(find(u.name).is_none(), "{} 이 양쪽에 있다", u.name);
        }
    }

    /// 이유 없는 금지는 우회 대상이 된다 — 표를 통과 도구로 쓰는 것을 막는다.
    #[test]
    fn the_audited_refusals_are_declared() {
        assert!(!UNSERVED.is_empty(), "감사 결과가 비었다");
        for u in UNSERVED {
            assert!(!u.name.is_empty(), "이름 없는 미서빙");
            assert!(u.blocked_by.len() > 40, "{} 의 사유가 너무 짧다", u.name);
        }
        let decl = declaration();
        let listed = decl["unserved"].as_array().expect("unserved 선언");
        assert_eq!(listed.len(), UNSERVED.len());
    }

    /// 이름은 두 표 **각각** 안에서도 유일하다.
    ///
    /// 서빙 표만 보던 검사라 거절 표의 중복이 통과했다(실측: 머지 재조립이 한 이름을 두 번
    /// 넣었다). 같은 이름에 사유가 둘이면 프레임워크 저자가 어느 것을 읽었는지에 따라 다른 이유를
    /// 믿게 되고, 그 둘이 갈리는 순간까지 조용하다.
    #[test]
    fn every_name_is_unique() {
        for (label, mut names) in [
            ("서빙", COMMANDS.iter().map(|c| c.name).collect::<Vec<_>>()),
            ("거절", UNSERVED.iter().map(|u| u.name).collect::<Vec<_>>()),
        ] {
            let before = names.len();
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), before, "{label} 표에 같은 이름이 둘 있다: {names:?}");
        }
    }

    // 선언이 비어 있으면 cored.commands 는 "아무것도 못 한다"를 성공으로 답한다.
    // 표가 살아 있음을 먼저 단언한다(0 의 두 얼굴).
    #[test]
    fn the_table_declares_name_args_and_returns() {
        assert!(COMMANDS.len() >= 6, "표가 비었다: {}", COMMANDS.len());
        for c in COMMANDS {
            assert!(!c.name.is_empty(), "이름 없는 명령");
            assert!(!c.returns.is_empty(), "{} 의 반환이 선언되지 않았다", c.name);
            for a in c.args {
                assert!(!a.name.is_empty(), "{} 에 이름 없는 인자", c.name);
                assert!(!a.ty.is_empty(), "{}.{} 의 타입이 선언되지 않았다", c.name, a.name);
            }
        }
    }

    // 선언된 필수 인자를 빼면 INVALID_PARAMS 여야 한다 — 선언과 실행이 같은 말을 하는지.
    // 선언만 있고 실행이 그 인자를 안 보면 이 검사가 RED 가 된다.
    #[test]
    fn a_missing_required_argument_is_invalid_params() {
        for c in COMMANDS {
            if c.args.iter().all(|a| !a.required) {
                continue;
            }
            let outcome = (c.run)(&ctx(), &json!({}));
            assert!(
                matches!(outcome, Outcome::InvalidParams(_)),
                "{} 이 빈 인자를 통과시켰다",
                c.name
            );
        }
    }

    #[test]
    fn an_unlisted_name_is_not_found() {
        assert!(find("webview_overlay_active").is_none());
        assert!(find("binary_integrity").is_some());
    }

    // 관찰 결과는 앱의 invoke 가 주는 값과 같은 모양이어야 한다 — 봉투는 밖에서 얹는다.
    #[test]
    fn binary_integrity_answers_the_raw_shape() {
        let outcome = (find("binary_integrity").unwrap().run)(&ctx(), &json!({
            "binPath": "/nonexistent-xyz/bin", "libPath": "/nonexistent-xyz/lib"
        }));
        let Outcome::Ok(v) = outcome else {
            panic!("부재도 답이다 — 실패가 아니다");
        };
        assert_eq!(v["present"], false);
        assert_eq!(v["partial"], false);
        assert_eq!(v["broken"], false);
    }

    #[test]
    fn a_refusal_carries_the_portable_reason() {
        let outcome = (find("cleanup_stale").unwrap().run)(&ctx(), &json!({
            "path": "/etc/passwd", "allowedRoots": ["/nowhere"]
        }));
        let Outcome::Failed(msg) = outcome else {
            panic!("화이트리스트 밖은 거부해야 한다");
        };
        assert!(msg.contains("/etc/passwd"), "사유가 경로를 말한다: {msg}");
    }

    // 생략과 명시적 null 을 같게 받는다 — 프론트가 `?? null` 로 보내는 자리가 있다
    // (catalogNetwork.ts). null 을 인자 오류로 보면 그 호출들이 통째로 막힌다.
    // 대기 없는 인자만 골라 확인한다(타임아웃은 이 검사의 대상이 아니다).
    #[test]
    fn an_explicit_null_optional_reads_as_absent() {
        let sent = (find("net_udp_send").unwrap().run)(&ctx(), &json!({
            "host": "127.0.0.1", "port": 9, "data": [1], "broadcast": null
        }));
        assert!(
            !matches!(sent, Outcome::InvalidParams(_)),
            "명시적 null 을 인자 오류로 보면 안 된다"
        );
        let asked = (find("net_udp_request").unwrap().run)(&ctx(), &json!({
            "host": "127.0.0.1", "port": 9, "data": [1],
            "timeoutMs": 1, "maxPackets": null
        }));
        assert!(
            !matches!(asked, Outcome::InvalidParams(_)),
            "명시적 null 을 인자 오류로 보면 안 된다"
        );
    }
}


// ── 조회·프로브 ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cwd {
    cwd: String,
}

pub(crate) fn run_ai_session_dir(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Cwd| {
        // 빈 cwd 는 홈을 해소하기 전에 거절한다 — 그 답은 어느 홈에서도 같다(앱과 같은 순서).
        if a.cwd.is_empty() {
            return Err("cwd 필요".to_string());
        }
        let dir = session::claude_session_dir(&ctx.require_user_home()?.to_string_lossy(), &a.cwd);
        Ok(dir.to_string_lossy().into_owned())
    })
}

pub(crate) fn run_ai_session_find(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Cwd| {
        session::find_newest_session(&ctx.require_user_home()?.to_string_lossy(), &a.cwd)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: String,
}

pub(crate) fn run_ai_session_inspect(_ctx: &Ctx, params: &Value) -> Outcome {
    // 경로 가드도 코어가 소유한다 — 두 벌이면 한쪽만 고쳐지고, 느슨한 쪽이 임의 파일
    // 읽기 프리미티브가 된다.
    dispatch(params, |a: PathArg| {
        session::inspect(std::path::Path::new(&a.path))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeArg {
    bin: String,
    args: Vec<String>,
}

pub(crate) fn run_probe_binary(_ctx: &Ctx, params: &Value) -> Outcome {
    // 못 돈 것도 답이다(ok=false) — 이 관찰 자체는 실패하지 않는다.
    //
    // 절대경로를 주면 두 프로세스가 같은 답을 낸다. **이름**을 주면 argv[0] 해소를 OS 가
    // 답하는 프로세스의 PATH 로 하므로 답이 갈릴 수 있다 — 호출자(state/plugins.ts)가 이름을
    // 쓰는 것은 npm prefix 를 못 구한 경우뿐이고, 그 경우는 shell_which·npm_global_dirs 가
    // 여기서 서빙되지 않는 것과 같은 사유(사용자 PATH)에 걸려 있다.
    dispatch(params, |a: ProbeArg| {
        Ok(probe::probe_binary(a.bin, a.args))
    })
}

pub(crate) fn run_host_unit_target(_ctx: &Ctx, params: &Value) -> Outcome {
    // 타깃은 인자다. 이 프로세스가 넣는 값은 **자기 빌드의 상수**이고, 그것이 앱과 같은
    // 답인 이유는 둘이 같은 호스트용으로 함께 빌드되기 때문이다.
    dispatch(params, |_: NoArgs| {
        let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
        unit_target::host_target(os, arch)
            .ok_or_else(|| format!("유닛 타깃이 정의되지 않은 호스트다: {os}-{arch}"))
    })
}

pub(crate) fn run_ipc_socket_path(ctx: &Ctx, params: &Value) -> Outcome {
    // **자리**를 답한다. 거기 붙는 것은 프레임워크의 일이고, 자리는 identity 가 정한다.
    dispatch(params, |_: NoArgs| {
        Ok(Some(
            ctx.identity().control_socket().to_string_lossy().into_owned(),
        ))
    })
}

pub(crate) fn run_ipc_cli_dir(_ctx: &Ctx, params: &Value) -> Outcome {
    // 짝 CLI 는 실행물 곁에 산다 — 걷는 규칙은 코어가, 시작점은 이 프로세스가 준다.
    // cored 는 앱 실행물과 같은 디렉터리에서 배급되므로 같은 걸음이 같은 곳에 닿는다.
    dispatch(params, |_: NoArgs| {
        let Ok(exe) = std::env::current_exe() else {
            return Ok(None);
        };
        let Some(dir) = exe.parent() else {
            return Ok(None);
        };
        Ok(pathx::find_dir_holding(dir, CLI_FILE, CLI_SEARCH_UP)
            .map(|d| d.to_string_lossy().into_owned()))
    })
}

/// 찾는 파일 이름과 올라갈 걸음 수 — 앱의 `ipc_cli_dir` 과 같은 값이라야 같은 곳에 닿는다.
const CLI_FILE: &str = "sok";
const CLI_SEARCH_UP: usize = 6;

// ── 로그인 셸을 통한 일회 실행 · 잔존 회수 ──────────────────────────────────────
//
// 조립과 판정은 코어(shellq)가 소유하고, 이 프로세스가 주는 것은 **스폰과 신호**다.
// 자르는 규칙(RING_CAP)·플래그 분기·대조 판정을 여기서 다시 적으면 같은 실행이 프로세스마다
// 다른 답을 낸다 — 그리고 그 차이는 오류가 아니라 다른 줄 수, 다른 회수 목록으로 나타난다.


pub(crate) fn run_skill_refresh_spawn(ctx: &Ctx, params: &Value) -> Outcome {
    // 저장소 쓰기(data_kv_set)와 달리 잠금을 요구하지 않는다: 이 방아쇠가 당기는 CLI 는 홈에
    // 쓰지만 그 쓰기는 app.data 밖이라 store_lock 이 지키는 파일이 아니다. 앱의 같은 명령도
    // 잠그지 않는다 — 여기서만 요구하면 앱이 도는 홈에서 이 명령만 영영 거절되는데, 그
    // 거절은 그 파일들을 아무도 지키지 않는다는 사실을 바꾸지 않는다(plugin_data_write 와 같은 자리).
    dispatch(params, |_: NoArgs| {
        let Some((cli, argv)) = skillgen::skill_refresh_argv(ctx.home())? else {
            return Ok(false); // 설치 전 — 재생성할 스킬이 없다(오류 아님).
        };
        // 분리 스폰이고 `Child` 는 즉시 버린다 — 원본의 계약이다. 기다리면 이 명령이 스킬
        // 재생성이 끝날 때까지 호출자를 붙잡는다(프론트는 디바운스 뒤 던져 놓고 잊는다).
        std::process::Command::new(cli)
            .args(argv)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("스킬 재생성 스폰 실패: {e}"))?;
        Ok(true)
    })
}
