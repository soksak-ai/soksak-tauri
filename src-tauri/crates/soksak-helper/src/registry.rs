//! 서빙 표 — 이름·인자·반환을 선언하고, 실행은 soksak-portable 로 위임한다.
//!
//! 표에 있는 이름은 앱이 `#[tauri::command]` 로 노출하는 이름 그대로다. 인자 표기도
//! 그대로다(Tauri 가 JS 로 넘길 때 쓰는 camelCase). 셸이 이름이나 인자를 번역해야 한다면
//! 그 번역이 새 드리프트 면이 된다 — 같은 이름으로 물어 같은 답을 받는 것이 요점이다.
//!
//! 각 핸들러는 **포터블 함수 호출 한 줄**이다. 판단을 여기 넣지 마라: 판단이 여기 있으면
//! 앱 경로와 헬퍼 경로가 서로 다른 답을 낼 수 있고, 그 차이는 조용하다.
//!
//! 여기 없는 이름은 이름을 달고 실패한다. 셸이 아직 소유한 것(창·웹뷰·엔진)을 헬퍼가
//! 아는 척하지 않는다 — 모르는 것을 모른다고 답하는 것이 이 표의 절반이다.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use soksak_portable::{identity, integrity, plugin_dir, session, themes, udp, unit_dev};

/// 명령 하나의 결과. 인자 해석 실패와 로직 실패를 가른다 — 부르는 쪽이 "내가 잘못 물었나,
/// 물음은 맞는데 안 되나"를 코드로 구분할 수 있어야 한다.
pub enum Outcome {
    /// 앱의 `invoke` 가 돌려주는 값 **그대로**. 봉투는 호출자가 얹는다.
    Ok(Value),
    /// 인자를 이 명령의 모양으로 읽을 수 없다.
    InvalidParams(String),
    /// 인자는 맞고 로직이 거부했다. message 는 포터블 로직의 사유 그대로다.
    Failed(String),
}

/// 인자 선언 — 물어서 알 수 있어야 한다(helper.commands).
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
    pub run: fn(&Value) -> Outcome,
}

const REQ: bool = true;
const OPT: bool = false;

/// 서빙 표. 지금 여기 있는 것은 **셸 없이도 같은 답이 나오는 것**뿐이다 —
/// soksak-portable 이 이미 소유한 로직.
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
    // 아래 셋은 홈·경로만 있으면 되는 것들이다. 앱은 그 홈을 자기 정체성에서 파생하지만
    // 헬퍼는 자기 정체성을 추측하지 않으므로 **인자로 받는다** — 헬퍼가 홈을 추측하면
    // 홈이 갈릴 때 조용히 다른 곳을 훑는다.
    Command {
        name: "themes_scan",
        args: &[Arg { name: "dir", ty: "string", required: REQ }],
        returns: "ThemeFile[] (파일명·이름)",
        run: run_themes_scan,
    },
    Command {
        name: "plugin_scan",
        args: &[Arg { name: "base", ty: "string", required: REQ }],
        returns: "PluginScanEntry[] (디렉터리 스캔 결과)",
        run: run_plugin_scan,
    },
    Command {
        name: "data_kv_get",
        args: &[
            Arg { name: "dbPath", ty: "string", required: REQ },
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "any | null (저장된 값)",
        run: run_data_kv_get,
    },
    Command {
        name: "app_environment",
        args: &[
            Arg { name: "identifier", ty: "string", required: REQ },
            Arg { name: "home", ty: "string", required: REQ },
        ],
        returns: "AppEnvironment (정체성·홈·CLI·빌드 프로파일·유닛 모드)",
        run: run_app_environment,
    },
    Command {
        name: "app_is_release",
        args: &[Arg { name: "identifier", ty: "string", required: REQ }],
        returns: "bool (release core 여부)",
        run: run_app_is_release,
    },
];

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
    json!({ "commands": commands })
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

// ── 핸들러 — 전부 포터블 호출 한 줄 ──────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UdpSend {
    host: String,
    port: u16,
    data: Vec<u8>,
    #[serde(default)]
    broadcast: Option<bool>,
}

fn run_net_udp_send(params: &Value) -> Outcome {
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

fn run_net_udp_request(params: &Value) -> Outcome {
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

fn run_binary_integrity(params: &Value) -> Outcome {
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

fn run_cleanup_stale(params: &Value) -> Outcome {
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

fn run_verify_and_link(params: &Value) -> Outcome {
    dispatch(params, |a: VerifyAndLink| {
        integrity::verify_and_link(a.src, a.dest, a.sha256)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionDetect {
    command_line: String,
}

fn run_ai_session_detect(params: &Value) -> Outcome {
    // 종류 이름은 AgentKind::as_str 이 소유한다 — 여기서 문자열을 새로 짓지 않는다.
    dispatch(params, |a: AiSessionDetect| {
        Ok(session::detect_agent(&a.command_line).map(|k| k.as_str().to_string()))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirArg {
    dir: String,
}

fn run_themes_scan(params: &Value) -> Outcome {
    dispatch(params, |a: DirArg| themes::scan(std::path::Path::new(&a.dir)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseArg {
    base: String,
}

fn run_plugin_scan(params: &Value) -> Outcome {
    dispatch(params, |a: BaseArg| {
        plugin_dir::scan(std::path::Path::new(&a.base))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentifierArg {
    identifier: String,
}

fn run_app_is_release(params: &Value) -> Outcome {
    // 판정 규칙은 포터블이 소유한다 — 여기서 문자열을 다시 가르지 않는다.
    dispatch(params, |a: IdentifierArg| {
        Ok(identity::is_release_identifier(&a.identifier))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvGetArg {
    db_path: String,
    ns: String,
    key: String,
}

/// KvRows 의 SQLite 구현 — 질의문과 연결은 구현자의 것이라는 계약대로.
struct SqliteRows {
    conn: rusqlite::Connection,
}

impl soksak_portable::kv::KvRows for SqliteRows {
    fn value(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
        // 앱과 같은 질의문이다 — 다르면 두 경로가 다른 답을 낼 수 있고 그 차이는 조용하다.
        match self
            .conn
            .query_row("SELECT v FROM kv WHERE ns=?1 AND k=?2", (ns, key), |r| {
                r.get::<_, String>(0)
            }) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn run_data_kv_get(params: &Value) -> Outcome {
    dispatch(params, |a: KvGetArg| {
        // 읽기 전용으로 연다 — 헬퍼가 저장소를 고치지 않는다. 쓰기는 소유자가 하고,
        // 두 프로세스가 같은 파일에 쓰면 그 순간 단일 쓰기자 계약이 깨진다.
        let conn = rusqlite::Connection::open_with_flags(
            &a.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("저장소 열기 실패: {e}"))?;
        let rows = SqliteRows { conn };
        soksak_portable::kv::get(&rows, &a.ns, &a.key)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvArg {
    identifier: String,
    home: String,
}

fn run_app_environment(params: &Value) -> Outcome {
    // 파생 규칙은 포터블이 소유한다. 헬퍼는 정체성·홈을 인자로 받을 뿐 추측하지 않는다 —
    // 추측하면 홈이 갈릴 때 조용히 다른 identity 의 환경을 답한다.
    dispatch(params, |a: EnvArg| {
        let core_build = identity::core_build_for_identifier(&a.identifier);
        let cli = identity::cli_for_core_build(&core_build);
        // 개발 유닛 선언은 홈 아래 config 파일이다. 없으면 빈 목록이 정답(공식 설치본만
        // 쓰는 상태) — 파일 부재를 오류로 올리면 정상 상태가 실패로 보인다.
        let units = unit_dev::read_declared(std::path::Path::new(&a.home))?;
        let (accepted, rejected): (Vec<_>, Vec<_>) = units.into_iter().partition(|u| {
            identity::dev_source_accepted(
                std::path::Path::new(&u.source),
                std::path::Path::new(&a.home),
                &core_build,
            )
        });
        Ok(json!({
            "coreBuild": core_build,
            "identity": a.identifier,
            "cli": cli,
            "home": a.home,
            // 헬퍼는 릴리즈 프로파일로 배급된다 — 자기 빌드를 말하는 것이 정직하다.
            "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "updaterEnabled": core_build == "release",
            "unitMode": if accepted.is_empty() { "official" } else { "mixed" },
            "developmentUnits": accepted,
            "rejectedDevelopmentUnits": rejected,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_is_unique() {
        let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before, "표에 같은 이름이 둘 있다: {names:?}");
    }

    // 선언이 비어 있으면 helper.commands 는 "아무것도 못 한다"를 성공으로 답한다.
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
            let outcome = (c.run)(&json!({}));
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
        let outcome = (find("binary_integrity").unwrap().run)(&json!({
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
        let outcome = (find("cleanup_stale").unwrap().run)(&json!({
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
        let sent = (find("net_udp_send").unwrap().run)(&json!({
            "host": "127.0.0.1", "port": 9, "data": [1], "broadcast": null
        }));
        assert!(
            !matches!(sent, Outcome::InvalidParams(_)),
            "명시적 null 을 인자 오류로 보면 안 된다"
        );
        let asked = (find("net_udp_request").unwrap().run)(&json!({
            "host": "127.0.0.1", "port": 9, "data": [1],
            "timeoutMs": 1, "maxPackets": null
        }));
        assert!(
            !matches!(asked, Outcome::InvalidParams(_)),
            "명시적 null 을 인자 오류로 보면 안 된다"
        );
    }
}
