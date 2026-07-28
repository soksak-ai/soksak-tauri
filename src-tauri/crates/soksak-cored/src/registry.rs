//! 서빙 표 — 이름·인자·반환을 선언하고, 실행은 soksak-core 로 위임한다.
//!
//! 표에 있는 이름은 앱이 `#[tauri::command]` 로 노출하는 이름 그대로다. 인자 표기도
//! 그대로다(Tauri 가 JS 로 넘길 때 쓰는 camelCase). 셸이 이름이나 인자를 번역해야 한다면
//! 그 번역이 새 드리프트 면이 된다 — 같은 이름으로 물어 같은 답을 받는 것이 요점이다.
//!
//! 각 핸들러는 **코어 함수 호출 한 줄**이다. 판단을 여기 넣지 마라: 판단이 여기 있으면
//! 앱 경로와 cored 경로가 서로 다른 답을 낼 수 있고, 그 차이는 조용하다.
//!
//! 여기 없는 이름은 이름을 달고 실패한다. 셸이 아직 소유한 것(창·웹뷰·엔진)을 cored 가
//! 아는 척하지 않는다 — 모르는 것을 모른다고 답하는 것이 이 표의 절반이다.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use soksak_core::{identity, integrity, plugin_dir, session, themes, udp, unit_dev};

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

const REQ: bool = true;
const OPT: bool = false;

/// 서빙 표. 지금 여기 있는 것은 **셸 없이도 같은 답이 나오는 것**뿐이다 —
/// soksak-core 이 이미 소유한 로직.
pub const COMMANDS: &[Command] = &[
    Command {
        name: "net_udp_send",
        args: &[
            Arg { name: "host", ty: "string", required: REQ },
            Arg { name: "port", ty: "u16", required: REQ },
            Arg { name: "data", ty: "u8[]", required: REQ },
            Arg { name: "broadcast", ty: "bool?", required: OPT },
        ],
        returns: "number (보낸 바이트 수)",
        run: run_net_udp_send,
    },
    Command {
        name: "net_udp_request",
        args: &[
            Arg { name: "host", ty: "string", required: REQ },
            Arg { name: "port", ty: "u16", required: REQ },
            Arg { name: "data", ty: "u8[]", required: REQ },
            Arg { name: "timeoutMs", ty: "u64?", required: OPT },
            Arg { name: "maxPackets", ty: "usize?", required: OPT },
        ],
        returns: "{ address, port, data }[]",
        run: run_net_udp_request,
    },
    Command {
        name: "binary_integrity",
        args: &[
            Arg { name: "binPath", ty: "string", required: REQ },
            Arg { name: "libPath", ty: "string", required: REQ },
        ],
        returns: "{ present, partial, broken }",
        run: run_binary_integrity,
    },
    Command {
        name: "cleanup_stale",
        args: &[
            Arg { name: "path", ty: "string", required: REQ },
            Arg { name: "allowedRoots", ty: "string[]", required: REQ },
        ],
        returns: "bool (제거했는가)",
        run: run_cleanup_stale,
    },
    Command {
        name: "verify_and_link",
        args: &[
            Arg { name: "src", ty: "string", required: REQ },
            Arg { name: "dest", ty: "string", required: REQ },
            Arg { name: "sha256", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_verify_and_link,
    },
    Command {
        name: "ai_session_detect",
        args: &[Arg { name: "commandLine", ty: "string", required: REQ }],
        returns: "string | null (에이전트 종류)",
        run: run_ai_session_detect,
    },
    // 아래 다섯은 홈·정체성이 필요한 것들이다. 그 값은 **부팅 상태**(Ctx)에서 오지 인자로
    // 오지 않는다 — 앱의 같은 명령이 인자를 받지 않기 때문이다. cored 가 인자로 요구하면
    // UI 의 같은 호출이 앱에서는 되고 cored 에서는 INVALID_PARAMS 로 거절된다(실측 결함).
    Command {
        name: "themes_scan",
        args: &[],
        returns: "ThemeFile[] (파일명·이름)",
        run: run_themes_scan,
    },
    Command {
        name: "plugin_scan",
        args: &[],
        returns: "PluginScanEntry[] (디렉터리 스캔 결과)",
        run: run_plugin_scan,
    },
    Command {
        name: "data_kv_get",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "any | null (저장된 값)",
        run: run_data_kv_get,
    },
    // 활동 발행 — cored 는 **적재만** 한다. 부채질(창 emit)은 셸의 것이고, 영속(records 쓰기)은
    // 저장소 소유자의 것이다. 적재분을 답에 실어 보내면 창을 가진 셸이 그것을 뿌린다.
    // 저장소 경로는 인자가 아니라 부팅 상태다 — 앱의 activity_publish 도 받지 않는다.
    Command {
        name: "activity_publish",
        args: &[
            Arg { name: "kind", ty: "string", required: REQ },
            Arg { name: "source", ty: "string", required: REQ },
            Arg { name: "payload", ty: "any", required: REQ },
        ],
        returns: "ActivityEntry { seq, ts, kind, source, payload } — 적재분. 창 부채질은 셸, 영속은 저장소 소유자",
        run: run_activity_publish,
    },
    // 쓰기 — 쓰기 소유권을 잡은 프로세스만 선다. 잠금이 없으면 이름을 달고 거절한다:
    // 조용히 쓰면 두 프로세스가 같은 파일을 고치고, 그 손상은 오류로 안 나타난다.
    Command {
        name: "data_kv_set",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
            Arg { name: "value", ty: "any", required: REQ },
        ],
        returns: "null",
        run: run_data_kv_set,
    },
    Command {
        name: "app_environment",
        args: &[],
        returns: "AppEnvironment (정체성·홈·CLI·빌드 프로파일·유닛 모드)",
        run: run_app_environment,
    },
    Command {
        name: "app_is_release",
        args: &[],
        returns: "bool (release core 여부)",
        run: run_app_is_release,
    },
];

/// 감사했으나 서빙하지 않는 이름과 **무엇이 막는가**.
///
/// 표에 없다는 사실만으로는 "아직 안 옮겼다"와 "여기서는 못 한다"가 구분되지 않는다.
/// 셸 저자가 받는 것은 UNKNOWN_COMMAND 한 줄뿐이라, 사유가 없으면 막힌 것을 다시 조사하거나
/// 더 나쁘게는 조사 없이 흉내를 낸다. 이유 없는 금지는 우회 대상이 된다.
pub struct Unserved {
    pub name: &'static str,
    pub blocked_by: &'static str,
}

/// 옮기려다 막힌 것들. 여기 있는 이름이 표로 올라가려면 사유가 먼저 사라져야 한다.
pub const UNSERVED: &[Unserved] = &[
    Unserved {
        name: "project_owners",
        blocked_by: "점유 원장이 앱 프로세스 안의 가변 상태다. 살아 있는 창 라벨은 인자로 받을 수 \
                     있지만(부팅 상태가 홈을 받는 것처럼) 원장은 못 받는다 — 그것을 바꾸는 \
                     claim/release 가 같은 프로세스에 있다. cored 가 원장을 쥐면 원장의 수명이 cored 의 \
                     수명이 되어, 셸이 재기동한 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다.",
    },
    Unserved {
        name: "net_http_request",
        blocked_by: "전송기가 wreq 하나인데 wreq 는 tokio 를 끌고 온다(http2·wreq-proto·wreq-rt 경유). \
                     이 프로세스의 no_shell 게이트가 tokio 를 이름으로 막는다. 시크릿 치환은 앱이 연 \
                     볼트(SecretsState)를 읽으므로, 옮기려면 키체인 신원과 잠금 수명까지 함께 옮겨야 한다.",
    },
    Unserved {
        name: "process_reclaim_window",
        blocked_by: "회수 대상은 이 프로세스가 스폰한 자식의 Child 핸들이다. 창 라벨은 키일 뿐 회수할 \
                     것을 만들어 주지 않는다 — cored 에는 그 맵이 없어 언제나 0 을 돌려주는데, 그 0 은 \
                     '거둘 것이 없었다'와 구분되지 않는다.",
    },
];

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
fn dispatch<T, R>(params: &Value, work: impl FnOnce(T) -> Result<R, String>) -> Outcome
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

fn run_net_udp_send(_ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_net_udp_request(_ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_binary_integrity(_ctx: &Ctx, params: &Value) -> Outcome {
    // 이 관찰은 실패하지 않는다(부재도 답이다) — Ok 로 감싸 dispatch 의 한 경로를 쓴다.
    dispatch(params, |a: BinaryIntegrity| {
        Ok(integrity::binary_integrity(a.bin_path, a.lib_path))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupStale {
    path: String,
    allowed_roots: Vec<String>,
}

fn run_cleanup_stale(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: CleanupStale| {
        integrity::cleanup_stale(a.path, a.allowed_roots)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyAndLink {
    src: String,
    dest: String,
    sha256: String,
}

fn run_verify_and_link(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: VerifyAndLink| {
        integrity::verify_and_link(a.src, a.dest, a.sha256)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionDetect {
    command_line: String,
}

fn run_ai_session_detect(_ctx: &Ctx, params: &Value) -> Outcome {
    // 종류 이름은 AgentKind::as_str 이 소유한다 — 여기서 문자열을 새로 짓지 않는다.
    dispatch(params, |a: AiSessionDetect| {
        Ok(session::detect_agent(&a.command_line).map(|k| k.as_str().to_string()))
    })
}

/// 인자를 받지 않는 명령 — 앱의 같은 명령도 받지 않는다. `{}`·`null` 둘 다 허용하고
/// 낯선 키가 실려 와도 거부하지 않는다(셸이 봉투에 무엇을 더 얹든 이 명령의 답은 같다).
#[derive(serde::Deserialize)]
struct NoArgs {}

fn run_themes_scan(ctx: &Ctx, params: &Value) -> Outcome {
    // 홈은 부팅 상태에서 온다. 앱은 `identity::ambient().themes_dir()` 로 같은 곳을 본다.
    dispatch(params, |_: NoArgs| {
        themes::scan(&ctx.identity().themes_dir())
    })
}

fn run_plugin_scan(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |_: NoArgs| {
        plugin_dir::scan(&ctx.identity().plugins_dir())
    })
}

fn run_app_is_release(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_data_kv_get(ctx: &Ctx, params: &Value) -> Outcome {
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvSetArg {
    ns: String,
    key: String,
    value: Value,
}

fn run_data_kv_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvSetArg| {
        // 소유권 먼저 — 열기 전에 거절한다. 열고 나서 판단하면 그 사이가 곧 이중 쓰기 창이다.
        if !ctx.owns_writes() {
            return Err(format!(
                "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 같은 홈에 앱이나 다른                  cored 가 살아 있다. 읽기는 계속 서빙한다",
                ctx.db_path().display()
            ));
        }
        let conn = rusqlite::Connection::open(ctx.db_path())
            .map_err(|e| format!("저장소 열기 실패: {e}"))?;
        let store = SqliteRows { conn };
        soksak_core::kv::set(&store, &a.ns, &a.key, &a.value, crate::ledger::now_ms())?;
        // 앱의 data_kv_set 은 () 를 돌려준다 — 같은 모양이라야 셸이 값을 다시 조립하지 않는다.
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

fn run_activity_publish(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_app_environment(ctx: &Ctx, params: &Value) -> Outcome {
    // 파생 규칙은 코어가 소유한다. 정체성·홈은 부팅 상태에서 온다 — 앱이 셸 설정에서
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

    #[test]
    fn every_name_is_unique() {
        let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before, "표에 같은 이름이 둘 있다: {names:?}");
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
