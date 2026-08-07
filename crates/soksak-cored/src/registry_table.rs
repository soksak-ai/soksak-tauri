//! 이 프로세스가 서빙하는 명령 **표** — 선언만 산다.
//!
//! 몸(run_* 핸들러)과 갈라 둔다. 한 파일이 표와 몸을 함께 지면 그 길이가 "무엇을 서빙하는가"와
//! "그것을 어떻게 하는가" 둘을 한꺼번에 따라 자라고, 표를 읽으러 온 사람이 몸을 지나야 한다.

use crate::registry::*;
use crate::registry_session::{run_ai_session_active, run_ai_session_lineage, run_ai_session_untrack};
use crate::registry_clipboard::*;
use crate::registry_store::*;
use crate::registry_encrypt::{
    run_data_encrypt_change_recovery, run_data_encrypt_convert, run_data_encrypt_enable,
    run_data_encrypt_recover, run_data_encrypt_rotate, run_data_encrypt_status,
};
use crate::registry_sidecar::{run_sidecar_close, run_sidecar_open, run_sidecar_send};
use crate::registry_ptyd::{run_pty_daemon_restart, run_pty_daemon_upgrade};
use crate::registry_scaffold::{
    run_plugin_dev_new, run_plugin_dev_new2, run_sidecar_dev_new,
};
use crate::registry_unit_dev::{run_unit_dev_remove, run_unit_dev_set};
use crate::registry_install::{
    run_unit_install_begin, run_unit_install_commit, run_unit_install_read_utf8,
    run_unit_install_rollback, run_unit_install_stage,
};
use crate::registry_schedule::{
    run_schedule_cancel, run_schedule_list, run_schedule_poke, run_schedule_register,
    run_schedule_set,
};
use crate::registry_service::{
    run_service_bus_push, run_service_dispatch, run_service_ledger_sync, run_service_status,
};
use crate::registry_secret::{
    run_net_http_request, run_secret_backend, run_secret_delete, run_secret_has, run_secret_keys, run_secret_set, run_secret_status,
};
use crate::registry_daemon::{
    run_daemon_logs, run_daemon_reap, run_daemon_run_once, run_daemon_start, run_daemon_status,
    run_daemon_stop,
};
use crate::registry_ws::{run_ws_close, run_ws_connect, run_ws_send};

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
        // 내려받아 핀과 대조하고 실행물로 앉힌다 — verify_and_link 의 형제다(그쪽은 src 가
        // 디스크, 이쪽은 url). 판정과 쓰기는 코어의 verify_and_write 하나가 진다.
        name: "download_verify",
        args: &[
            Arg { name: "url", ty: "string", required: REQ },
            Arg { name: "dest", ty: "string", required: REQ },
            Arg { name: "sha256", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_download_verify,
    },
    Command {
        // 엔진 모델 사이드카 — dlopen 과 메인스레드는 이 프로세스가 준다. 네이티브 부모 표면은
        // 없고, 그래서 send 의 표면은 0 이다: 지어내면 유효한 주소로 읽혀 그 위에 얹으려 한다.
        // 표면을 쓰는 엔진은 그 순간 자기 이름으로 실패한다.
        name: "sidecar_open",
        args: &[
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "requirement", ty: "ContractRequirement", required: REQ },
            Arg { name: "onEvent", ty: "stream", required: REQ },
        ],
        returns: "u64 — 이 클라이언트의 핸들",
        run: run_sidecar_open,
    },
    Command {
        name: "sidecar_send",
        args: &[
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "handle", ty: "u64", required: REQ },
            Arg { name: "payload", ty: "string", required: REQ },
        ],
        returns: "object — 엔진이 답한 그대로",
        run: run_sidecar_send,
    },
    Command {
        name: "sidecar_close",
        args: &[
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "handle", ty: "u64", required: REQ },
        ],
        returns: "null",
        run: run_sidecar_close,
    },
    Command {
        // 파괴적 — 살아 있는 세션을 전부 죽인다. 앞을 막는 것은 카탈로그의 danger 게이트다.
        name: "pty_daemon_restart",
        args: &[],
        returns: "{ killed, pid }",
        run: run_pty_daemon_restart,
    },
    Command {
        // 무중단 판올림 — 못 지키는 상대면 시도 전에 이름을 달고 거절한다.
        name: "pty_daemon_upgrade",
        args: &[],
        returns: "{ before, after, staged }",
        run: run_pty_daemon_upgrade,
    },
    Command {
        // 새 유닛 스캐폴드 — 몸은 soksak-scaffold 가 진다. 스캐폴드와 개발 선언이 한 손이다:
        // 뒷절반이 빠지면 답은 성공인데 유닛은 아무도 적재하지 않는 반쪽만 남는다.
        name: "plugin_dev_new",
        args: &[Arg { name: "id", ty: "string", required: REQ }],
        returns: "{ dir, dirName, manifest }",
        run: run_plugin_dev_new,
    },
    Command {
        name: "plugin_dev_new2",
        args: &[Arg { name: "name", ty: "string", required: REQ }],
        returns: "{ dir, dirName, manifest }",
        run: run_plugin_dev_new2,
    },
    Command {
        name: "sidecar_dev_new",
        args: &[
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "interface", ty: "string?", required: OPT },
        ],
        returns: "{ dir, dirName, manifest }",
        run: run_sidecar_dev_new,
    },
    Command {
        // 개발 선언 — 규칙은 코어가, 잠금은 커널이 진다. 프로세스 안의 Mutex 는 프로세스 둘을
        // 못 막는다: 겹친 쓰기가 남의 선언을 지운 채로 성공을 답한다.
        name: "unit_dev_set",
        args: &[
            Arg { name: "kind", ty: "string", required: REQ },
            Arg { name: "id", ty: "string", required: REQ },
            Arg { name: "source", ty: "string", required: REQ },
        ],
        returns: "UnitDevSource",
        run: run_unit_dev_set,
    },
    Command {
        name: "unit_dev_remove",
        args: &[
            Arg { name: "kind", ty: "string", required: REQ },
            Arg { name: "id", ty: "string", required: REQ },
        ],
        returns: "bool — 있던 선언을 지웠는가",
        run: run_unit_dev_remove,
    },
    Command {
        // 유닛 설치 — 다섯이 한 원장을 공유한다. **함께** 서빙해야 begin 과 commit 이 같은
        // 프로세스에 앉는다: 나누면 뒤쪽은 100% 실패 경로만 남는다.
        name: "unit_install_begin",
        args: &[
            Arg { name: "registryId", ty: "string", required: REQ },
            Arg { name: "root", ty: "UnitIdentity", required: REQ },
        ],
        returns: "{ transactionId, ... }",
        run: run_unit_install_begin,
    },
    Command {
        name: "unit_install_stage",
        args: &[
            Arg { name: "transactionId", ty: "string", required: REQ },
            Arg { name: "registryId", ty: "string", required: REQ },
            Arg { name: "unit", ty: "UnitIdentity", required: REQ },
            Arg { name: "artifact", ty: "StageArtifact", required: REQ },
        ],
        returns: "{ handle, ... }",
        run: run_unit_install_stage,
    },
    Command {
        name: "unit_install_read_utf8",
        args: &[
            Arg { name: "transactionId", ty: "string", required: REQ },
            Arg { name: "handle", ty: "string", required: REQ },
            Arg { name: "path", ty: "string", required: REQ },
        ],
        returns: "string — 스테이징 안의 파일 내용",
        run: run_unit_install_read_utf8,
    },
    Command {
        name: "unit_install_commit",
        args: &[
            Arg { name: "transactionId", ty: "string", required: REQ },
            Arg { name: "units", ty: "VerifiedInstallUnit[]", required: REQ },
        ],
        returns: "{ installed, ... }",
        run: run_unit_install_commit,
    },
    Command {
        name: "unit_install_rollback",
        args: &[Arg { name: "transactionId", ty: "string", required: REQ }],
        returns: "null",
        run: run_unit_install_rollback,
    },
    Command {
        // 예약 — 시계와 장부는 soksak-schedule 이, 영속은 이 프로세스의 저장소가 진다.
        name: "schedule_register",
        args: &[
            Arg { name: "trigger", ty: "Trigger", required: REQ },
            Arg { name: "command", ty: "string", required: REQ },
            Arg { name: "params", ty: "object", required: OPT },
            Arg { name: "id", ty: "string?", required: OPT },
            Arg { name: "retry", ty: "Retry", required: OPT },
            Arg { name: "concurrency", ty: "u32", required: OPT },
            Arg { name: "timeoutMs", ty: "u64", required: OPT },
            Arg { name: "processLease", ty: "bool", required: OPT },
            Arg { name: "zombieBackstopMs", ty: "u64", required: OPT },
            Arg { name: "owner", ty: "string?", required: OPT },
        ],
        returns: "string — 배정된 id",
        run: run_schedule_register,
    },
    Command {
        name: "schedule_set",
        args: &[
            Arg { name: "at", ty: "u64", required: REQ },
            Arg { name: "command", ty: "string", required: REQ },
            Arg { name: "params", ty: "object", required: OPT },
            Arg { name: "id", ty: "string?", required: OPT },
        ],
        returns: "string — 배정된 id",
        run: run_schedule_set,
    },
    Command {
        name: "schedule_poke",
        args: &[Arg { name: "id", ty: "string?", required: OPT }],
        returns: "null",
        run: run_schedule_poke,
    },
    Command {
        name: "schedule_cancel",
        args: &[Arg { name: "id", ty: "string", required: REQ }],
        returns: "bool — 있던 것을 지웠는가",
        run: run_schedule_cancel,
    },
    Command {
        name: "schedule_list",
        args: &[],
        returns: "JobView[]",
        run: run_schedule_list,
    },
    Command {
        // 상주 서비스 — 매니저는 soksak-service 가, 호스트 능력 다섯은 이 프로세스가 진다.
        name: "service_dispatch",
        args: &[
            Arg { name: "method", ty: "string", required: REQ },
            Arg { name: "params", ty: "object", required: OPT },
            Arg { name: "parent", ty: "string?", required: OPT },
            Arg { name: "origin", ty: "string?", required: OPT },
            Arg { name: "timeoutMs", ty: "u64", required: OPT },
        ],
        returns: "봉투 — 서비스가 답한 그대로",
        run: run_service_dispatch,
    },
    Command {
        name: "service_bus_push",
        args: &[
            Arg { name: "topic", ty: "string", required: REQ },
            Arg { name: "payload", ty: "object", required: OPT },
            Arg { name: "dedupKey", ty: "string?", required: OPT },
        ],
        returns: "usize — 배달된 구독자 수",
        run: run_service_bus_push,
    },
    Command {
        name: "service_status",
        args: &[Arg { name: "plugin", ty: "string?", required: OPT }],
        returns: "{ services } 또는 { plugin, status }",
        run: run_service_status,
    },
    Command {
        // 파일 쓰기와 결속 맞춤은 한 손이어야 한다 — 절반만 하면 원장은 새 내용인데 도는
        // 서비스는 옛 결속이고, 그 어긋남은 "없앤 서비스가 계속 도는 것"으로 나타난다.
        name: "service_ledger_sync",
        args: &[Arg { name: "ledger", ty: "BindLedger", required: REQ }],
        returns: "null",
        run: run_service_ledger_sync,
    },
    Command {
        // HTTP — 몸은 soksak-net 이, 시크릿 해소는 이 프로세스의 볼트가 진다.
        name: "net_http_request",
        args: &[
            Arg { name: "method", ty: "string", required: REQ },
            Arg { name: "url", ty: "string", required: REQ },
            Arg { name: "headers", ty: "map<string,string>", required: OPT },
            Arg { name: "query", ty: "map<string,string>", required: OPT },
            Arg { name: "body", ty: "string?", required: OPT },
            Arg { name: "contentType", ty: "string?", required: OPT },
            Arg { name: "ns", ty: "string?", required: OPT },
            Arg { name: "secretSubst", ty: "map<string,string>", required: OPT },
            Arg { name: "impersonate", ty: "string?", required: OPT },
        ],
        returns: "{ status, headers, body }",
        run: run_net_http_request,
    },
    Command {
        // 시크릿 — 몸은 볼트가 진다. 값은 이 프로세스를 떠나지만 그것이 이 표면의 목적이다.
        name: "secret_set",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
            Arg { name: "value", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_secret_set,
    },
    Command {
        name: "secret_has",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "bool",
        run: run_secret_has,
    },
    Command {
        name: "secret_delete",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "bool — 있던 것을 지웠는가",
        run: run_secret_delete,
    },
    Command {
        name: "secret_keys",
        args: &[Arg { name: "ns", ty: "string", required: REQ }],
        returns: "string[]",
        run: run_secret_keys,
    },
    Command {
        name: "secret_backend",
        args: &[],
        returns: "{ backend, unlocked }",
        run: run_secret_backend,
    },
    Command {
        name: "secret_status",
        args: &[],
        returns: "{ backend, unlocked, expectVault, keyIds }",
        run: run_secret_status,
    },
    Command {
        // 봉인 — 규칙은 soksak-store 가, 열쇠는 이 프로세스의 볼트가 진다. 열쇠 순서가 곧
        // 안전핀이라 그 순서를 여기에 다시 적지 않는다.
        name: "data_encrypt_enable",
        args: &[Arg { name: "scope", ty: "string", required: REQ }],
        returns: "{ keyId, recoveryCode } — 복구코드는 1회만 나온다",
        run: run_data_encrypt_enable,
    },
    Command {
        name: "data_encrypt_recover",
        args: &[
            Arg { name: "scope", ty: "string", required: REQ },
            Arg { name: "recoveryCode", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_data_encrypt_recover,
    },
    Command {
        name: "data_encrypt_rotate",
        args: &[Arg { name: "scope", ty: "string", required: REQ }],
        returns: "{ oldKeyId, newKeyId, rekeyed, oldDisposed, recoveryCode }",
        run: run_data_encrypt_rotate,
    },
    Command {
        name: "data_encrypt_change_recovery",
        args: &[Arg { name: "scope", ty: "string", required: REQ }],
        returns: "string — 새 복구코드(1회)",
        run: run_data_encrypt_change_recovery,
    },
    Command {
        name: "data_encrypt_status",
        args: &[Arg { name: "scope", ty: "string", required: REQ }],
        returns: "{ enabled, keyId, algo, unlocked, tampered, keyMissing }",
        run: run_data_encrypt_status,
    },
    Command {
        // 데몬 — 몸은 soksak-daemon 이 진다. 창도 웹뷰도 필요 없고, 이 프로세스가 사는 동안
        // 자식도 산다(껍데기를 갈아도 데몬은 안 죽는다).
        name: "daemon_start",
        args: &[
            Arg { name: "root", ty: "string", required: REQ },
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "cmd", ty: "string", required: REQ },
            Arg { name: "restart", ty: "string", required: OPT },
        ],
        returns: "u32 — 자식 pid",
        run: run_daemon_start,
    },
    Command {
        name: "daemon_stop",
        args: &[
            Arg { name: "root", ty: "string", required: REQ },
            Arg { name: "name", ty: "string", required: OPT },
        ],
        returns: "string[] — 멈춘 이름들",
        run: run_daemon_stop,
    },
    Command {
        name: "daemon_status",
        args: &[Arg { name: "root", ty: "string", required: OPT }],
        returns: "DaemonStatus[]",
        run: run_daemon_status,
    },
    Command {
        name: "daemon_logs",
        args: &[
            Arg { name: "root", ty: "string", required: REQ },
            Arg { name: "name", ty: "string", required: REQ },
            Arg { name: "lines", ty: "usize", required: OPT },
        ],
        returns: "string[] — 출력 링의 끝에서 n 줄",
        run: run_daemon_logs,
    },
    Command {
        name: "daemon_reap",
        args: &[Arg { name: "entries", ty: "(u32,string)[]", required: REQ }],
        returns: "u32[] — 실제로 회수한 pid",
        run: run_daemon_reap,
    },
    Command {
        name: "daemon_run_once",
        args: &[
            Arg { name: "root", ty: "string", required: REQ },
            Arg { name: "cmd", ty: "string", required: REQ },
            Arg { name: "timeoutSecs", ty: "u64", required: OPT },
            Arg { name: "env", ty: "map<string,string>", required: OPT },
        ],
        returns: "{ code, out } — 끝까지 기다린 결과",
        run: run_daemon_run_once,
    },
    Command {
        // WebSocket — 몸은 soksak-net 이 진다(런타임 포함). 출구는 이 프로세스의 스트림 토큰.
        name: "ws_connect",
        args: &[
            Arg { name: "url", ty: "string", required: REQ },
            Arg { name: "onMessage", ty: "stream", required: REQ },
            Arg { name: "onClose", ty: "stream", required: REQ },
        ],
        returns: "u32 — 이 연결의 핸들",
        run: run_ws_connect,
    },
    Command {
        name: "ws_send",
        args: &[
            Arg { name: "id", ty: "u32", required: REQ },
            Arg { name: "text", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_ws_send,
    },
    Command {
        name: "ws_close",
        args: &[Arg { name: "id", ty: "u32", required: REQ }],
        returns: "null",
        run: run_ws_close,
    },
    Command {
        // 마지막 워크스페이스 창 — 장부는 이 프로세스가 하나만 쥔다.
        name: "ipc_last_project_window",
        args: &[],
        returns: "string | null (포커스한 적 없으면 null)",
        run: crate::registry_ptyd::run_ipc_last_project_window,
    },
    Command {
        // 데몬 상태 — 읽기다. 판올림·재기동은 여기서 하지 않는다(파괴적이고 세션을 죽인다).
        name: "pty_daemon_status",
        args: &[],
        returns: "{ running, pid, sessions, protocol, handoffContract, staged, stagedPath }",
        run: crate::registry_ptyd::run_pty_daemon_status,
    },
    Command {
        // dir 의 "방금 쓰인 세션" — 스냅샷 원장은 이 프로세스가 하나만 둔다.
        name: "ai_session_active",
        args: &[Arg { name: "dir", ty: "string", required: REQ }],
        returns: "string | null (변화 없으면 null)",
        run: run_ai_session_active,
    },
    Command {
        name: "ai_session_untrack",
        args: &[Arg { name: "dir", ty: "string", required: REQ }],
        returns: "null",
        run: run_ai_session_untrack,
    },
    Command {
        name: "ai_session_lineage",
        args: &[
            Arg { name: "cwd", ty: "string", required: REQ },
            Arg { name: "viewId", ty: "string?", required: OPT },
        ],
        returns: "{ viewId, fromSession, toSession, kind, time }[] — created 시간순",
        run: run_ai_session_lineage,
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
    // 훑기의 짝. 외부 경로에서 홈 아래 themes/ 로 복사한다 — 목적지 홈은 부팅 상태에서 오고
    // 원본 경로만 호출자가 준다(앱의 같은 명령도 path 하나만 받는다).
    Command {
        name: "theme_install",
        args: &[Arg { name: "path", ty: "string", required: REQ }],
        returns: "string (설치된 경로)",
        run: run_theme_install,
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
    // 원장을 읽는다. 규칙(커서·상한)은 코어가, 질의문도 코어가 소유한다.
    //
    // 한때 "링버퍼는 앱 프로세스의 것이라 못 옮긴다"고 거절했는데, 그 사유는 cored 가 적재만
    // 하던 때의 것이다. 지금은 적재와 **같은 자리에서** 저장하므로 저장소가 곧 적재된 집합이다.
    Command {
        name: "activity_recent",
        args: &[
            Arg { name: "since", ty: "u64?", required: OPT },
            Arg { name: "limit", ty: "usize?", required: OPT },
        ],
        returns: "Value[] (도장 찍힌 항목, 오래된 것부터)",
        run: run_activity_recent,
    },
    // ── 자식 프로세스 ────────────────────────────────────────────────────
    // 스폰 규칙은 코어 한 벌이다(soksak-core proc) — 두 벌이면 같은 명령이 프로세스마다 다른
    // env 로 뜨고, 그 차이는 "이쪽에서만 안 된다"로 나타난다.
    Command {
        name: "process_spawn",
        args: &[
            Arg { name: "cmd", ty: "string", required: true },
            Arg { name: "args", ty: "string[]", required: true },
            Arg { name: "cwd", ty: "string?", required: false },
            Arg { name: "env", ty: "object?", required: false },
            Arg { name: "envRemove", ty: "string[]?", required: false },
            Arg { name: "scrubAiEnv", ty: "bool?", required: false },
            Arg { name: "group", ty: "bool?", required: false },
            Arg { name: "detached", ty: "bool?", required: false },
            Arg { name: "ns", ty: "string?", required: false },
            Arg { name: "secretEnv", ty: "object?", required: false },
            Arg { name: "onStdout", ty: "stream", required: true },
            Arg { name: "onStderr", ty: "stream", required: true },
            Arg { name: "onExit", ty: "stream", required: true },
        ],
        returns: "u32 — 프로세스 id",
        run: run_process_spawn,
    },
    // 이 창 앞으로 남은 앞선 런타임의 고아를 거둔다(웹뷰 리로드·HMR·크래시 복구).
    //
    // 이름이 앱과 다르다. 앱에서는 창이 **프레임워크 주입**이라 호출자가 인자를 보내지 않는데,
    // 이 프로세스에는 창이 없어 라벨을 받아야 한다 — 같은 이름으로 두면 인자 없이 부른 UI 가
    // INVALID_PARAMS 를 받는다. 부르는 쪽도 다르다: 창을 아는 프레임워크가 부른다.
    Command {
        name: "process_reclaim_by_window",
        args: &[Arg { name: "window", ty: "string", required: true }],
        returns: "u32 — 거두기 전 그 창의 자식 수",
        run: run_process_reclaim_by_window,
    },
    Command {
        name: "process_write",
        args: &[
            Arg { name: "id", ty: "u32", required: true },
            Arg { name: "data", ty: "string", required: true },
        ],
        returns: "null",
        run: run_process_write,
    },
    Command {
        name: "process_stdin_close",
        args: &[Arg { name: "id", ty: "u32", required: true }],
        returns: "null",
        run: run_process_stdin_close,
    },
    Command {
        name: "process_list",
        args: &[],
        returns: "object[]",
        run: run_process_list,
    },
    Command {
        name: "process_kill",
        args: &[Arg { name: "id", ty: "u32", required: true }],
        returns: "null",
        run: run_process_kill,
    },
    // ── 데이터 컬렉션 ────────────────────────────────────────────────────
    // 질의 규칙과 질의문은 soksak-store 한 벌이 소유한다 — 두 벌이면 같은 레코드가 프로세스마다
    // 다르게 읽히고, 그 차이는 오류가 아니라 **빈 결과**다.
    Command {
        name: "data_define",
        args: &[
            Arg { name: "ns", ty: "string", required: true },
            Arg { name: "coll", ty: "string", required: true },
            Arg { name: "indexes", ty: "string[]", required: true },
            Arg { name: "fts", ty: "string[]", required: true },
        ],
        returns: "null",
        run: run_data_define,
    },
    // ns 이행 — 플러그인 id 개명이 남긴 옛 ns 의 레코드를 새 ns 로 옮긴다. 규칙(같은 ns 는
    // no-op·이행 결과를 값으로)은 저장 크레이트가 소유한다.
    Command {
        name: "data_migrate_ns",
        args: &[
            Arg { name: "fromNs", ty: "string", required: true },
            Arg { name: "toNs", ty: "string", required: true },
        ],
        returns: "{ migrated, reason }",
        run: run_data_migrate_ns,
    },
    Command {
        name: "data_query",
        args: &[
            Arg { name: "ns", ty: "string", required: true },
            Arg { name: "coll", ty: "string", required: true },
            Arg { name: "scope", ty: "string?", required: false },
            Arg { name: "filter", ty: "object?", required: false },
            Arg { name: "order", ty: "string?", required: false },
            Arg { name: "desc", ty: "bool?", required: false },
            Arg { name: "limit", ty: "i64?", required: false },
            Arg { name: "offset", ty: "i64?", required: false },
        ],
        returns: "object[]",
        run: run_data_query,
    },
    // ── 파일 감시 ──────────────────────────────────────────────────────────
    // 변경 사건은 창으로 간다. 이 프로세스에는 창이 없으므로 **방송**으로 넘긴다 —
    // 감시만 하고 못 뿌리면 트리가 조용히 낡는다(오류 없이 "안 바뀐다").
    Command {
        name: "watch_dir",
        args: &[Arg { name: "path", ty: "string", required: true }],
        returns: "usize — 등록 후 refcount",
        run: run_watch_dir,
    },
    Command {
        name: "unwatch_dir",
        args: &[Arg { name: "path", ty: "string", required: true }],
        returns: "usize — 해제 후 refcount",
        run: run_unwatch_dir,
    },
    // ── 터미널 ────────────────────────────────────────────────────────────
    // 셸은 데몬이 소유한다(soksak-ptyd). 이 프로세스는 앱이 쓰는 그 클라이언트로 같은 데몬에
    // 붙는다 — 인자 모양도 앱 명령과 같다(UI 는 누가 답하는지 모른다).
    Command {
        name: "spawn_terminal",
        args: &[
            Arg { name: "cols", ty: "u16", required: true },
            Arg { name: "rows", ty: "u16", required: true },
            Arg { name: "cwd", ty: "string?", required: false },
            Arg { name: "shell", ty: "string?", required: false },
            Arg { name: "paneId", ty: "string?", required: false },
            Arg { name: "windowLabel", ty: "string?", required: false },
            Arg { name: "replay", ty: "\"none\" | {fromSeq}?", required: false },
            Arg { name: "onOutput", ty: "stream", required: true },
        ],
        returns: "{ id }",
        run: run_spawn_terminal,
    },
    Command {
        name: "write_terminal",
        args: &[
            Arg { name: "id", ty: "u32", required: true },
            Arg { name: "data", ty: "string", required: true },
        ],
        returns: "null",
        run: run_write_terminal,
    },
    Command {
        name: "resize_terminal",
        args: &[
            Arg { name: "id", ty: "u32", required: true },
            Arg { name: "cols", ty: "u16", required: true },
            Arg { name: "rows", ty: "u16", required: true },
        ],
        returns: "null",
        run: run_resize_terminal,
    },
    Command {
        name: "ack_terminal",
        args: &[
            Arg { name: "id", ty: "u32", required: true },
            Arg { name: "bytes", ty: "u64", required: true },
        ],
        returns: "null",
        run: run_ack_terminal,
    },
    Command {
        name: "close_terminal",
        args: &[Arg { name: "id", ty: "u32", required: true }],
        returns: "null",
        run: run_close_terminal,
    },
    // 생존 미러 사이드카에 NDJSON 한 왕복을 릴레이한다. 내용은 해석하지 않는다 —
    // 웹뷰 JS 가 유닉스 소켓을 못 여니 이 프로세스가 대신 연결해 준다.
    Command {
        name: "pty_sidecar_request",
        args: &[Arg { name: "request", ty: "object", required: true }],
        returns: "object — 사이드카의 답 그대로",
        run: run_pty_sidecar_request,
    },
    Command {
        name: "pty_read_sealed_screen",
        args: &[
            Arg { name: "windowLabel", ty: "string?", required: false },
            Arg { name: "paneId", ty: "string", required: true },
            Arg { name: "legacyPaneId", ty: "string?", required: false },
        ],
        returns: "{ paintB64 } | null",
        run: run_pty_read_sealed_screen,
    },
    Command {
        name: "pty_pane_pid",
        args: &[Arg { name: "paneId", ty: "string", required: REQ }],
        returns: "u32? — 전경 프로세스 pid(없으면 null)",
        run: run_pty_pane_pid,
    },
    Command {
        name: "pty_pane_alive",
        args: &[Arg { name: "paneId", ty: "string", required: true }],
        returns: "bool",
        run: run_pty_pane_alive,
    },
    // 창 호스트 등록 — **이 연결이 배달 통로가 된다.** 창을 가진 쪽만 부른다.
    Command {
        name: "control_host_attach",
        args: &[
            Arg { name: "live", ty: "string[]", required: true },
            Arg { name: "focused", ty: "string", required: true },
        ],
        returns: "null",
        run: run_control_host_attach,
    },
    // 클립보드 — **플랫폼 자원**이라 이 프로세스가 진다(A26). 프레임워크마다 하나씩 두면
    // 한쪽만 되고, 그 차이는 "저 앱에서는 복사가 안 잡힌다"로만 나타난다.
    Command {
        name: "clipboard_read",
        args: &[],
        returns: "string (비텍스트면 빈 문자열)",
        run: run_clipboard_read,
    },
    Command {
        name: "clipboard_write",
        args: &[Arg { name: "text", ty: "string", required: REQ }],
        returns: "null",
        run: run_clipboard_write,
    },
    Command {
        name: "clipboard_watch_start",
        args: &[],
        returns: "null (변경은 clipboard-change 방송으로 간다)",
        run: run_clipboard_watch_start,
    },
    Command {
        name: "clipboard_watch_stop",
        args: &[],
        returns: "null",
        run: run_clipboard_watch_stop,
    },
    // 딥링크 — 밖에서 온 명령은 명령 표면의 주인이 받는다. 프레임워크는 OS 가 준 URL 을
    // 그대로 넘기고, 형식은 코어가 읽는다(창에 먼저 넘기면 창 없는 곳에 영영 못 닿는다).
    Command {
        name: "deeplink_open",
        args: &[Arg { name: "url", ty: "string", required: REQ }],
        returns: "{ ran, command?, reply? }",
        run: run_deeplink_open,
    },
    // 창이 신고한다: 이 이름들은 **주인이 답한다**. 같은 이름을 든 창이 여럿일 때 배달이 이
    // 값을 보고 한 곳에만 보낸다 — 안 그러면 같은 쓰기가 두 프로세스에서 각각 돈다.
    // 어느 쪽인지는 명령 자신이 알고(CommandSpec.windowScoped), 그 사실을 아는 것은 창이다.
    Command {
        name: "control_owner_answered",
        args: &[Arg { name: "names", ty: "string[]", required: REQ }],
        returns: "{ known }",
        run: run_control_owner_answered,
    },
    // 이 연결은 창의 다리다 — 서빙하지 않는 이름이 와도 창으로 되돌리지 않는다.
    // 창이 자기가 물은 것을 자기가 받으면 회신할 자리가 없어 상한까지 침묵한다.
    Command {
        name: "control_bridge_attach",
        args: &[],
        returns: "null",
        run: run_control_bridge_attach,
    },
    // 창 사실 갱신. 낡은 목록으로 타겟을 고르면 죽은 창에 배달한다 — 그 오답은 조용하다.
    Command {
        // 이름으로 묻는 hello — 전송층 선점 응답과 같은 사실이다. 두 벌이면 어느 쪽이 참인지
        // 부른 쪽이 못 가린다.
        name: "ipc_hello_info",
        args: &[],
        returns: "{ protocol, minClientProtocol, identity, pid, startedAt, role }",
        run: run_ipc_hello_info,
    },
    Command {
        // 관측 — 겹친 라벨을 실패로 배우지 않게 한다. 창 복원이 저장된 w-<uuid> 를 되쓰므로
        // 한 홈을 두 프레임워크가 보면 같은 슬롯을 각자 되살린다.
        name: "window_census",
        args: &[],
        returns: "{ windows: [{ label, hosts, focused }] } — hosts>1 이면 그 라벨은 모호하다",
        run: run_window_census,
    },
    Command {
        name: "control_windows",
        args: &[
            Arg { name: "live", ty: "string[]", required: true },
            Arg { name: "focused", ty: "string", required: true },
        ],
        returns: "bool — 호스트가 붙어 있었는가",
        run: run_control_windows,
    },
    // 창의 회신. 기다리던 그 요청과 짝지어진다.
    Command {
        name: "cmd_result",
        args: &[
            Arg { name: "id", ty: "u64", required: true },
            Arg { name: "result", ty: "object", required: true },
        ],
        returns: "bool — 짝을 찾았는가",
        run: run_cmd_result,
    },
    Command {
        name: "plugin_scan",
        args: &[],
        returns: "PluginScanEntry[] (디렉터리 스캔 결과)",
        run: run_plugin_scan,
    },
    // 플러그인 전용 저장소 — 자리(<홈>/plugins-data)는 부팅 상태에서 나오고 id·key·value 만
    // 인자다. 읽기 둘은 디렉터리를 만들지 않는다: 세 명령의 답을 하나도 바꾸지 않으면서
    // 부작용만 프로세스마다 갈리기 때문이다(읽기는 부재를 값으로 가르고, 쓰기는 자기가 만든다).
    Command {
        name: "plugin_data_list",
        args: &[Arg { name: "id", ty: "string", required: REQ }],
        returns: "string[] (저장된 key 이름, 사전순)",
        run: run_plugin_data_list,
    },
    Command {
        name: "plugin_data_read",
        args: &[
            Arg { name: "id", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "string | null (저장된 원문 그대로 — 파싱하지 않는다)",
        run: run_plugin_data_read,
    },
    Command {
        name: "plugin_data_write",
        args: &[
            Arg { name: "id", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
            Arg { name: "value", ty: "string", required: REQ },
        ],
        returns: "null",
        run: run_plugin_data_write,
    },
    // 설치본 제거 — 순서와 "전용 저장소는 남긴다"는 결정은 코어가 소유한다. 이 프로세스가
    // 주는 것은 잠금 해제 스폰 한 걸음뿐이다.
    Command {
        name: "plugin_remove",
        args: &[Arg { name: "id", ty: "string", required: REQ }],
        returns: "null",
        run: run_plugin_remove,
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
    // 명령 표면의 이름 — 저장소 명령이 창으로 새지 않게 이 표가 직접 든다(registry_store 머리말).
    Command {
        name: "data.kv.get",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "{ ns, key, value }",
        run: run_kv_get_surface,
    },
    Command {
        name: "data.kv.set",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
            Arg { name: "value", ty: "json", required: REQ },
        ],
        returns: "{ ns, key }",
        run: run_kv_set_surface,
    },
    Command {
        name: "data.kv.delete",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "{ ns, key, deleted }",
        run: run_kv_delete_surface,
    },
    Command {
        name: "data.kv.keys",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "prefix", ty: "string", required: OPT },
        ],
        returns: "{ ns, keys }",
        run: run_kv_keys_surface,
    },
    Command {
        name: "data.kv.entries",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "prefix", ty: "string", required: OPT },
        ],
        returns: "{ ns, entries: { key, value }[] }",
        run: run_kv_entries_surface,
    },
    Command {
        name: "data.kv.deleteMany",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "keys", ty: "string[] (1..4096 exact keys)", required: REQ },
        ],
        returns: "{ ns, requested, deleted, absent }",
        run: run_kv_delete_many_surface,
    },
    // 되돌릴 자리는 **물어서 알 수 있어야 한다**. 저장소가 과거를 간직해도 꺼낼 길이 없으면
    // 그 과거는 없는 것과 같다 — 사고가 난 순간 사람이 볼 수 있어야 한다.
    Command {
        name: "data_kv_history",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "any[] (최신 직전 값이 앞)",
        run: run_data_kv_history,
    },
    Command {
        name: "data_kv_undo",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "bool (되돌렸으면 true)",
        run: run_data_kv_undo,
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
    // ── 저장소 표면 — 앱이 부르는 이름을 이 프로세스가 서빙한다 ──────────────────
    //
    // 규칙은 soksak-store 가 진다(앱의 data/ 3132줄이 그리로 갔다). 여기 있는 것은 배선뿐이다.
    // 이 표가 채워져야 앱이 자기 커넥션을 놓을 수 있고, 그래야 저장소를 쓰는 주인이 하나가
    // 된다 — 지금은 앱과 이 프로세스가 같은 파일을 각자 연다.
    //
    // 인자 모양은 **앱 명령과 같다**. UI 는 자기가 누구와 말하는지 모른다: `invoke("data_get")`
    // 은 앱이 답하든 이 프로세스가 답하든 한 호출이다. 프레임워크가 주입하는 것(AppHandle·
    // State)은 호출자가 보내는 값이 아니므로 여기 없다.
    Command {
        name: "data_ns_remove",
        args: &[Arg { name: "ns", ty: "string", required: REQ }],
        returns: "object — 지운 것의 수",
        run: run_data_ns_remove,
    },
    Command {
        name: "data_export",
        args: &[
            Arg { name: "ns", ty: "string?", required: OPT },
            Arg { name: "coll", ty: "string?", required: OPT },
        ],
        returns: "string — JSONL",
        run: run_data_export,
    },
    Command {
        name: "data_import",
        args: &[Arg { name: "jsonl", ty: "string", required: REQ }],
        returns: "i64 — 들인 행 수",
        run: run_data_import,
    },
    Command {
        name: "data_backup",
        args: &[Arg { name: "path", ty: "string?", required: OPT }],
        returns: "string — 만든 파일 경로",
        run: run_data_backup,
    },
    Command {
        name: "data_restore",
        args: &[Arg { name: "path", ty: "string", required: REQ }],
        returns: "null",
        run: run_data_restore,
    },
    Command {
        // 실황 — 답에 role·pid 가 실린다. 값의 절반이 답한 프로세스의 것이라, 그것 없이는
        // 두 프로세스의 답이 같은 모양이고 부른 쪽이 남의 힙을 자기 것으로 읽는다.
        name: "data_stats",
        args: &[],
        returns: "{ role, pid, sqliteVersion, memoryUsed, ... }",
        run: run_data_stats,
    },
    Command {
        // 붙음은 기다릴 수 있어야 한다 — 등록부를 가진 이 프로세스가 그 사실을 아는데 기다릴
        // 자리가 없어서, 부르는 쪽이 되묻는 폴링밖에 못 했다. 폴링이 아니다: 등록이 일어나는
        // 그 순간 깨어난다.
        name: "host_wait",
        args: &[Arg { name: "timeoutMs", ty: "number", required: false }],
        returns: "{ attached } — 창을 가진 쪽이 붙었는가",
        run: run_host_wait,
    },
    Command {
        name: "data_verify",
        args: &[],
        returns: "string[] — 진단 소견",
        run: run_data_verify,
    },
    Command {
        name: "data_repair",
        args: &[],
        returns: "object — 치유 결과",
        run: run_data_repair,
    },
    Command {
        name: "data_canary",
        args: &[],
        returns: "null",
        run: run_data_canary,
    },
    Command {
        name: "data_retention_reap",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "cutoffMs", ty: "i64", required: REQ },
        ],
        returns: "usize — 거둔 수",
        run: run_data_retention_reap,
    },
    Command {
        name: "data_retention_trim",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string", required: REQ },
            Arg { name: "cap", ty: "i64", required: REQ },
        ],
        returns: "usize — 잘라낸 수",
        run: run_data_retention_trim,
    },
    Command {
        name: "data_encrypt_convert",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string", required: REQ },
        ],
        returns: "usize — 변환한 수",
        run: run_data_encrypt_convert,
    },
    Command {
        name: "data_put",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string?", required: OPT },
            Arg { name: "id", ty: "string?", required: OPT },
            Arg { name: "doc", ty: "any", required: REQ },
        ],
        returns: "string — 레코드 id",
        run: run_data_put,
    },
    Command {
        name: "data_get",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "id", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string?", required: OPT },
        ],
        returns: "any? — 없으면 null",
        run: run_data_get,
    },
    Command {
        name: "data_delete",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "id", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string?", required: OPT },
        ],
        returns: "bool — 지웠는가",
        run: run_data_delete,
    },
    Command {
        name: "data_count",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string?", required: OPT },
            Arg { name: "filter", ty: "object?", required: OPT },
        ],
        returns: "i64",
        run: run_data_count,
    },
    Command {
        name: "data_search",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string", required: REQ },
            Arg { name: "query", ty: "string", required: REQ },
            Arg { name: "scope", ty: "string?", required: OPT },
            Arg { name: "limit", ty: "i64?", required: OPT },
        ],
        returns: "any[]",
        run: run_data_search,
    },
    // 저장소를 **자기가 쓴** 프로세스가 그 사실을 여기로 넘긴다 — 창 가진 쪽들에 뿌리는 자리는
    // 하나여야 한다(A22 의 알림 축). 저장소 소유가 선착순이라 실제 쓰기는 앱에서 일어날 수 있고,
    // 그때 앱이 자기 창에만 뿌리면 같은 홈을 보는 다른 프레임워크는 옛 값을 진실로 안다.
    Command {
        name: "data_change_notify",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "op", ty: "string", required: REQ },
            Arg { name: "coll", ty: "string?", required: OPT },
            Arg { name: "scope", ty: "string?", required: OPT },
            Arg { name: "id", ty: "string?", required: OPT },
        ],
        returns: "null",
        run: run_data_change_notify,
    },
    // 창 복원 장부의 slot 병합 — **읽기·병합·쓰기가 한 트랜잭션 안**이다. 부르는 쪽이 전체를
    // 읽어 고쳐 쓰면 두 프레임워크가 겹칠 때 나중 쓰기가 상대의 창을 지운다.
    Command {
        name: "window_manifest_upsert",
        args: &[
            Arg { name: "entry", ty: "any", required: REQ },
            Arg { name: "focused", ty: "bool?", required: OPT },
        ],
        returns: "bool(장부가 바뀌었는가)",
        run: run_window_manifest_upsert,
    },
    Command {
        name: "data_kv_delete",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "key", ty: "string", required: REQ },
        ],
        returns: "bool(지웠는가 — 앱의 같은 이름과 같은 모양)",
        run: run_data_kv_delete,
    },
    Command {
        name: "data_kv_entries",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "prefix", ty: "string?", required: OPT },
        ],
        returns: "{ ns, entries: { key, value }[] }",
        run: run_data_kv_entries,
    },
    Command {
        name: "data_kv_delete_many",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "keys", ty: "string[] (1..4096 exact keys)", required: REQ },
        ],
        returns: "{ ns, requested, deleted, absent }",
        run: run_data_kv_delete_many,
    },
    Command {
        name: "data_kv_keys",
        args: &[
            Arg { name: "ns", ty: "string", required: REQ },
            Arg { name: "prefix", ty: "string?", required: OPT },
        ],
        returns: "string[]",
        run: run_data_kv_keys,
    },
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
    // 닫힌 창의 흔적 폐기 — 남기면 다음 부트의 리스폰이 그 창을 되살린다(닫을수록 늘어난다).
    // 무엇을 지우는가는 코어의 규칙이다(window_traces); 여기는 저장소를 여는 자리다.
    Command {
        name: "window_traces_prune",
        args: &[Arg { name: "label", ty: "string", required: REQ }],
        returns: "{ snapshot: bool, slot: bool } — 실제로 지운 것",
        run: run_window_traces_prune,
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
        name: "activity_persist",
        args: &[Arg { name: "entry", ty: "json", required: REQ }],
        returns: "null",
        run: run_activity_persist,
    },
    Command {
        name: "activity_audit",
        args: &[],
        returns: "{ rows, minSeq, maxSeq, gaps, timeRegressions, firstRegressionSeq, singleWriter, ledger }",
        run: run_activity_audit,
    },
    Command {
        name: "write_file_base64",
        args: &[
            Arg { name: "path", ty: "string", required: REQ },
            Arg { name: "base64", ty: "string", required: REQ },
        ],
        returns: "{ path, bytes }",
        run: run_write_file_base64,
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
    // 로그인 셸을 통한 일회 실행과 잔존 회수. 둘 다 **장부를 안 건드린다** — 거둘 것·돌릴 것은
    // 호출자 인자와 부팅 상태(로그인 셸)가 만들어 주므로 DaemonManager 의 Child 맵도 창도
    // 필요 없다. 도는 데몬을 세우고 세는 daemon_start/stop/status/logs 와 갈리는 자리가 여기다.
    // 스킬 재생성 방아쇠 — 몸이 둘뿐이다: 정체성 홈의 매니페스트 읽기와 argv 하나 분리 스폰.
    // 홈은 부팅 상태에서 오고 매니페스트가 CLI 실물을 지목하므로, 창도 앱 핸들도 필요 없다.
    // 렌더 로직의 단일 진실은 그 CLI 다(P8 쓰기-스루) — 여기는 방아쇠만 소유한다.
    Command {
        name: "skill_refresh_spawn",
        args: &[],
        returns: "bool (true=스폰했다, false=재생성할 스킬이 없다)",
        run: run_skill_refresh_spawn,
    },
];

#[cfg(test)]
mod kv_batch_surface_tests {
    use super::COMMANDS;

    #[test]
    fn cored_declares_internal_and_public_batch_kv_surfaces() {
        for name in [
            "data_kv_entries",
            "data_kv_delete_many",
            "data.kv.entries",
            "data.kv.deleteMany",
        ] {
            assert!(COMMANDS.iter().any(|c| c.name == name), "missing {name}");
        }
        let args = |name| {
            COMMANDS
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .args
                .iter()
                .map(|a| a.name)
                .collect::<Vec<_>>()
        };
        assert_eq!(args("data_kv_entries"), args("data.kv.entries"));
        assert_eq!(args("data_kv_delete_many"), args("data.kv.deleteMany"));
    }
}
