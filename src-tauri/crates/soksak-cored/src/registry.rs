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

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use soksak_core::{
    fsx, identity, integrity, pathx, plugin_dir, probe, session, themes, udp, unit_dev,
    unit_target,
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

const REQ: bool = true;
const OPT: bool = false;

/// 서빙 표. 지금 여기 있는 것은 **프레임워크 없이도 같은 답이 나오는 것**뿐이다 —
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
    // 로그인 셸을 **값으로** 받아 서는 둘. 셸을 못 받았으면 추측하지 않고 사유를 달고 거절한다 —
    // 자기 환경(`$SHELL`)을 읽는 것이 곧 그 추측이고, 그 답은 띄운 쪽의 답과 다를 수 있다.
    Command {
        name: "shell_which",
        args: &[Arg { name: "bin", ty: "string", required: REQ }],
        returns: "bool (사용자 PATH 에 있는가)",
        run: run_shell_which,
    },
    Command {
        name: "npm_global_dirs",
        args: &[],
        returns: "{ bin_dir, lib_dir }",
        run: run_npm_global_dirs,
    },
    // 개발 유닛 **읽기**. 쓰기(unit_dev_set/remove)와 달리 공유 config 를 갈아끼우지 않으므로
    // 두 번째 쓰기 프로세스 문제가 없다 — 홈·정체성만 있으면 선다.
    Command {
        name: "unit_dev_list",
        args: &[],
        returns: "UnitDevSource[] (이 정체성이 받아들인 선언)",
        run: run_unit_dev_list,
    },
    Command {
        name: "unit_dev_validate_path",
        args: &[Arg { name: "source", ty: "string", required: REQ }],
        returns: "string (검증한 source)",
        run: run_unit_dev_validate_path,
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
    // 활동 발행 — cored 는 **적재만** 한다. 부채질(창 emit)은 프레임워크의 것이고, 영속(records 쓰기)은
    // 저장소 소유자의 것이다. 적재분을 답에 실어 보내면 창을 가진 프레임워크가 그것을 뿌린다.
    // 저장소 경로는 인자가 아니라 부팅 상태다 — 앱의 activity_publish 도 받지 않는다.
    Command {
        name: "activity_publish",
        args: &[
            Arg { name: "kind", ty: "string", required: REQ },
            Arg { name: "source", ty: "string", required: REQ },
            Arg { name: "payload", ty: "any", required: REQ },
        ],
        returns: "ActivityEntry { seq, ts, kind, source, payload } — 적재분. 창 부채질은 프레임워크, 영속은 저장소 소유자",
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
    // 파일 읽기·쓰기 — 디스크는 프레임워크가 아니다. 창도 앱 핸들도 없이 같은 답이 나온다.
    // 홈이 필요한 것들(`~` 확장·트리 기본 뿌리·루트 판정)은 **사용자 홈**을 부팅 상태에서
    // 본다. 정체성 홈이 아니다 — 둘을 바꿔 쓰면 트리가 앱 관리 폴더에서 시작한다.
    Command {
        name: "read_text_file",
        args: &[
            Arg { name: "path", ty: "string", required: REQ },
            Arg { name: "offset", ty: "u64?", required: OPT },
        ],
        returns: "{ content, truncated, read_bytes, total_bytes, line_count }",
        run: run_read_text_file,
    },
    Command {
        name: "read_file_base64",
        args: &[Arg { name: "path", ty: "string", required: REQ }],
        returns: "{ mime, base64 }",
        run: run_read_file_base64,
    },
    Command {
        name: "write_text_file",
        args: &[
            Arg { name: "path", ty: "string", required: REQ },
            Arg { name: "content", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_write_text_file,
    },
    Command {
        name: "list_children",
        args: &[
            Arg { name: "path", ty: "string?", required: OPT },
            Arg { name: "meta", ty: "bool?", required: OPT },
        ],
        returns: "{ root, children: { name, dir, modified? }[] }",
        run: run_list_children,
    },
    Command {
        name: "ensure_project_dir",
        args: &[Arg { name: "folder", ty: "string", required: REQ }],
        returns: "string (만들어진 절대경로)",
        run: run_ensure_project_dir,
    },
    Command {
        name: "validate_project_root",
        args: &[Arg { name: "path", ty: "string", required: REQ }],
        returns: "string (정규화된 절대경로)",
        run: run_validate_project_root,
    },
    // ── 조회·프로브 ─────────────────────────────────────────────────────────
    // AI 세션은 identity 홈이 아니라 **사용자 홈** 아래 산다(~/.claude·~/.codex). 그 홈도
    // 부팅 상태다 — 앱의 같은 명령이 cwd 하나만 받기 때문에 인자로 요구할 수 없다.
    Command {
        name: "ai_session_dir",
        args: &[Arg { name: "cwd", ty: "string", required: REQ }],
        returns: "string (그 cwd 의 claude 세션 디렉터리)",
        run: run_ai_session_dir,
    },
    Command {
        name: "ai_session_find",
        args: &[Arg { name: "cwd", ty: "string", required: REQ }],
        returns: "SessionInfo | null (그 cwd 의 최신 claude 세션)",
        run: run_ai_session_find,
    },
    Command {
        name: "ai_session_inspect",
        args: &[Arg { name: "path", ty: "string", required: REQ }],
        returns: "SessionInfo | null (세션 파일 헤더)",
        run: run_ai_session_inspect,
    },
    Command {
        name: "probe_binary",
        args: &[
            Arg { name: "bin", ty: "string", required: REQ },
            Arg { name: "args", ty: "string[]", required: REQ },
        ],
        returns: "{ ok, stdout } (돌려 본 결과)",
        run: run_probe_binary,
    },
    Command {
        name: "host_unit_target",
        args: &[],
        returns: "string (이 호스트의 유닛 타깃 트리플)",
        run: run_host_unit_target,
    },
    // 아래 둘은 이 identity 의 **자리**를 답한다(누가 거기 있는지가 아니라).
    Command {
        name: "ipc_socket_path",
        args: &[],
        returns: "string | null (제어 소켓 자리)",
        run: run_ipc_socket_path,
    },
    Command {
        name: "ipc_cli_dir",
        args: &[],
        returns: "string | null (짝 CLI 가 든 디렉터리)",
        run: run_ipc_cli_dir,
    },
];

/// 감사했으나 서빙하지 않는 이름과 **무엇이 막는가**.
///
/// 표에 없다는 사실만으로는 "아직 안 옮겼다"와 "여기서는 못 한다"가 구분되지 않는다.
/// 프레임워크 저자가 받는 것은 UNKNOWN_COMMAND 한 줄뿐이라, 사유가 없으면 막힌 것을 다시 조사하거나
/// 더 나쁘게는 조사 없이 흉내를 낸다. 이유 없는 금지는 우회 대상이 된다.
pub struct Unserved {
    pub name: &'static str,
    pub blocked_by: &'static str,
}

/// 옮기려다 막힌 것들. 여기 있는 이름이 표로 올라가려면 사유가 먼저 사라져야 한다.
pub const UNSERVED: &[Unserved] = &[
    Unserved {
        name: "secret_status",
        blocked_by: "볼트를 연 프로세스의 상태(SecretsState)를 읽는다. 이 프로세스는 볼트를 열지 \
                     않는다 — 부팅이 키체인을 건드리지 않는 것이 규칙이고(2d06843f), 여는 순간 \
                     KEK 의 수명이 cored 의 수명이 된다. 저장소의 봉인 메타로 답하면 '봉인 가능' \
                     여부를 알 수 없다: 그것은 파일이 아니라 열린 키가 있는가의 문제라서, 같은 \
                     모양의 답이 잠긴 볼트를 열려 있다고 말하게 된다.",
    },
    Unserved {
        name: "activity_recent",
        blocked_by: "읽는 출처가 앱 프로세스 안의 링버퍼(ActivityHub)다. 저장소에도 항목이 있지만 \
                     둘은 같은 것이 아니다 — 링은 적재 순간부터 담고 지속에 실패한 항목도 회수 큐로 \
                     들고 있는 반면, 저장소에는 지속에 성공한 것만 있다. 저장소로 답하면 모양은 같고 \
                     내용이 다른 답이 나가고, 그 차이는 오류가 아니라 '없는 활동'으로 보인다. 링을 \
                     cored 가 쥐면 그 수명이 cored 의 수명이 되어, 프레임워크가 재기동해도 옛 창의 \
                     항목이 남는다.",
    },
    Unserved {
        name: "project_owners",
        blocked_by: "점유 원장이 앱 프로세스 안의 가변 상태다. 살아 있는 창 라벨은 인자로 받을 수 \
                     있지만(부팅 상태가 홈을 받는 것처럼) 원장은 못 받는다 — 그것을 바꾸는 \
                     claim/release 가 같은 프로세스에 있다. cored 가 원장을 쥐면 원장의 수명이 cored 의 \
                     수명이 되어, 프레임워크가 재기동한 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다.",
    },
    Unserved {
        name: "net_http_request",
        blocked_by: "전송기가 wreq 하나인데 wreq 는 tokio 를 끌고 온다(http2·wreq-proto·wreq-rt 경유). \
                     이 프로세스의 no_framework 게이트가 tokio 를 이름으로 막는다. 시크릿 치환은 앱이 연 \
                     볼트(SecretsState)를 읽으므로, 옮기려면 키체인 신원과 잠금 수명까지 함께 옮겨야 한다.",
    },
    Unserved {
        name: "process_reclaim_window",
        blocked_by: "회수 대상은 이 프로세스가 스폰한 자식의 Child 핸들이다. 창 라벨은 키일 뿐 회수할 \
                     것을 만들어 주지 않는다 — cored 에는 그 맵이 없어 언제나 0 을 돌려주는데, 그 0 은 \
                     '거둘 것이 없었다'와 구분되지 않는다.",
    },
    Unserved {
        name: "download_verify",
        blocked_by: "전송기가 wreq 하나이고 wreq 는 tokio 를 끌고 온다 — 이 프로세스의 no_framework 게이트가 \
                     tokio 를 이름으로 막는다(net_http_request 와 같은 벽). 검증·쓰기 부분은 이미 코어의 \
                     verify_and_link 와 같은 규칙이라, 막는 것은 다운로드 한 걸음뿐이다.",
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
/// 낯선 키가 실려 와도 거부하지 않는다(프레임워크가 봉투에 무엇을 더 얹든 이 명령의 답은 같다).
#[derive(serde::Deserialize)]
struct NoArgs {}

fn run_themes_scan(ctx: &Ctx, params: &Value) -> Outcome {
    // 홈은 부팅 상태에서 온다. 앱은 `identity::ambient().themes_dir()` 로 같은 곳을 본다.
    dispatch(params, |_: NoArgs| {
        themes::scan(&ctx.identity().themes_dir())
    })
}

#[derive(serde::Deserialize)]
struct WhichArgs {
    bin: String,
}

fn run_shell_which(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_npm_global_dirs(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_unit_dev_list(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_unit_dev_validate_path(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SourceOnly| {
        unit_dev::validate_source_exists(std::path::Path::new(&a.source))?;
        Ok(a.source)
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

fn run_read_text_file(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ReadText| {
        fsx::read_text_file(&a.path, a.offset, ctx.user_home())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathOnly {
    path: String,
}

fn run_read_file_base64(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PathOnly| fsx::read_file_base64(&a.path))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteText {
    path: String,
    content: String,
}

fn run_write_text_file(_ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_list_children(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ListChildren| {
        fsx::list_children(a.path.as_deref(), a.meta, ctx.user_home())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureProjectDir {
    folder: String,
}

fn run_ensure_project_dir(ctx: &Ctx, params: &Value) -> Outcome {
    // 앱이 만든 폴더는 앱 관리 영역에 산다 — 여기만 정체성 홈을 본다.
    dispatch(params, |a: EnsureProjectDir| {
        fsx::ensure_project_dir(&a.folder, ctx.identity())
    })
}

fn run_validate_project_root(ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_ai_session_dir(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Cwd| {
        // 빈 cwd 는 홈을 해소하기 전에 거절한다 — 그 답은 어느 홈에서도 같다(앱과 같은 순서).
        if a.cwd.is_empty() {
            return Err("cwd 필요".to_string());
        }
        let dir = session::claude_session_dir(&ctx.require_user_home()?.to_string_lossy(), &a.cwd);
        Ok(dir.to_string_lossy().into_owned())
    })
}

fn run_ai_session_find(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Cwd| {
        session::find_newest_session(&ctx.require_user_home()?.to_string_lossy(), &a.cwd)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArg {
    path: String,
}

fn run_ai_session_inspect(_ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_probe_binary(_ctx: &Ctx, params: &Value) -> Outcome {
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

fn run_host_unit_target(_ctx: &Ctx, params: &Value) -> Outcome {
    // 타깃은 인자다. 이 프로세스가 넣는 값은 **자기 빌드의 상수**이고, 그것이 앱과 같은
    // 답인 이유는 둘이 같은 호스트용으로 함께 빌드되기 때문이다.
    dispatch(params, |_: NoArgs| {
        let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
        unit_target::host_target(os, arch)
            .ok_or_else(|| format!("유닛 타깃이 정의되지 않은 호스트다: {os}-{arch}"))
    })
}

fn run_ipc_socket_path(ctx: &Ctx, params: &Value) -> Outcome {
    // **자리**를 답한다. 거기 붙는 것은 프레임워크의 일이고, 자리는 identity 가 정한다.
    dispatch(params, |_: NoArgs| {
        Ok(Some(
            ctx.identity().control_socket().to_string_lossy().into_owned(),
        ))
    })
}

fn run_ipc_cli_dir(_ctx: &Ctx, params: &Value) -> Outcome {
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
