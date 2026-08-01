// cored 가 앱과 **같은 저장소 표면**을 서빙한다.
//
// 저장소를 쓰는 주인은 하나여야 한다(단일 쓰기). 그런데 앱이 자기 프로세스에서 DB 를 열면
// 그 주인이 둘이 되고, SQLite 는 막지 않고 직렬화만 한다 — 그 잠금이 시끄럽게 만들려던 바로
// 그 조용한 경우다.
//
// 규칙은 이미 `soksak-store` 에 있다(앱의 data/ 3132줄이 그리로 갔다). 남은 것은 배선이다:
// cored 가 그 규칙을 소켓 뒤에 세우면 앱이 자기 커넥션을 놓을 수 있다.
//
// 이 검사는 **이름의 존재**를 잰다. 인자 모양과 답의 내용은 각 명령의 검사가 잰다 —
// 여기서는 "앱이 부르는 이름을 이 프로세스가 안다"만 못박는다. 그것이 앱이 커넥션을
// 놓을 수 있는지의 조건이기 때문이다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

/// 앱이 부르는 저장소 표면 전부. 이 목록이 곧 "앱이 커넥션을 놓으려면 무엇이 있어야 하는가"다.
///
/// 늘리는 것은 앱에 새 명령이 생겼다는 뜻이고, 줄이는 것은 앱에서 사라졌다는 뜻이다 —
/// 어느 쪽이든 이 목록과 앱의 표면이 갈리면 앱은 없는 이름을 부르거나 자기가 답한다.
const STORE_SURFACE: &[&str] = &[
    "data_define", "data_put", "data_get", "data_delete", "data_count", "data_search",
    "data_ns_remove", "data_export", "data_import", "data_backup", "data_restore",
    "data_verify", "data_repair", "data_canary", "data_retention_reap", "data_retention_trim",
    "data_kv_get", "data_kv_set", "data_kv_delete", "data_kv_keys", "data_encrypt_convert",
];

struct Cored {
    child: Child,
    socket: PathBuf,
}

impl Drop for Cored {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// 검사마다 **자기 자리**다. 한 자리를 나눠 쓰면 병렬 실행에서 서로의 홈을 지우고, 그 실패는
/// 단독 실행에서 재현되지 않아 "플래키"로 읽힌다 — 플래키가 아니라 공유다.
fn start(name: &str) -> Cored {
    let dir = PathBuf::from(std::env::var("HOME").expect("HOME"))
        .join(".soksak-e2e/store-surface")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).expect("픽스처 홈");
    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .args(["--socket".as_ref(), socket.as_os_str()])
        .args(["--home".as_ref(), dir.join("home").as_os_str()])
        .args(["--identifier", "com.soksak.dev"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let out = child.stdout.take().expect("stdout");
    let mut line = String::new();
    let ready = BufReader::new(out).read_line(&mut line).is_ok() && !line.trim().is_empty();
    let c = Cored { child, socket };
    assert!(ready, "cored 가 준비를 알리지 않았다");
    c
}

fn ask(socket: &std::path::Path, req: Value) -> Value {
    let conn = UnixStream::connect(socket).expect("소켓 연결");
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut w = conn.try_clone().unwrap();
    writeln!(w, "{req}").expect("요청");
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).expect("응답");
    serde_json::from_str(line.trim()).expect("한 줄 JSON")
}

/// 앱이 부르는 저장소 이름을 이 프로세스가 전부 안다.
///
/// "안다"는 서빙하거나(COMMANDS) 사유를 달고 거절한다(UNSERVED)는 뜻이다. 둘 다 아니면
/// 그 이름은 이 프로세스에 **없는** 것이고, 앱은 커넥션을 놓을 수 없다.
#[test]
fn every_store_command_the_app_calls_is_known_here() {
    let cored = start("known");
    let table = ask(&cored.socket, json!({ "id": 1, "method": "cored.commands" }));
    let served: Vec<&str> = table["data"]["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    let refused: Vec<&str> = table["data"]["unserved"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["name"].as_str()).collect())
        .unwrap_or_default();

    let missing: Vec<&str> = STORE_SURFACE
        .iter()
        .copied()
        .filter(|n| !served.contains(n) && !refused.contains(n))
        .collect();
    assert!(
        missing.is_empty(),
        "이 프로세스가 모르는 저장소 이름 {}건 — 앱이 커넥션을 못 놓는다: {missing:?}",
        missing.len()
    );
}

/// 그중 **서빙**하는 것이 몇인가. 거절만 하면 앱은 여전히 자기가 답해야 한다.
#[test]
fn the_store_surface_is_actually_served_not_merely_named() {
    let cored = start("served");
    let table = ask(&cored.socket, json!({ "id": 2, "method": "cored.commands" }));
    let served: Vec<&str> = table["data"]["commands"]
        .as_array()
        .expect("commands")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    let not_served: Vec<&str> = STORE_SURFACE
        .iter()
        .copied()
        .filter(|n| !served.contains(n))
        .collect();
    assert!(
        not_served.is_empty(),
        "서빙하지 않는 저장소 이름 {}건 — 그만큼 앱이 자기 커넥션을 놓지 못한다: {not_served:?}",
        not_served.len()
    );
}

/// **저장소 명령은 창으로 새지 않는다.**
///
/// 이 프로세스의 표는 밑줄 이름(`data_kv_get`)을 쓰고 사람·CLI·에이전트가 부르는 이름은 점
/// (`data.kv.get`)이다. 점 이름이 표에 없으면 라우터는 그것을 "창이 답할 이름"으로 넘긴다 —
/// 저장소는 주인이 하나인데(A22) 그 조회가 창으로 갔고, 두 앱을 함께 켜자 같은 이름을 두 창이
/// 들어 조회는 막히고 쓰기는 **두 번** 돌았다(실측 2026-08-01).
///
/// 이름의 존재만 잰다. 답의 모양은 delegated-shape 게이트와 각 명령의 검사가 잰다.
#[test]
fn the_store_command_surface_is_served_here_not_by_a_window() {
    let cored = start("store-surface-names");
    let decl = ask(&cored.socket, json!({ "id": 1, "method": "cored.commands" }));
    let names: Vec<String> = decl["data"]["commands"]
        .as_array()
        .expect("표")
        .iter()
        .filter_map(|c| c["name"].as_str().map(str::to_string))
        .collect();
    for surface in ["data.kv.get", "data.kv.set", "data.kv.delete", "data.kv.keys"] {
        assert!(
            names.iter().any(|n| n == surface),
            "{surface} 를 이 프로세스가 안 든다 — 창으로 배달되고, 두 앱을 켜면 조회는 막히고 \
             쓰기는 두 번 돈다"
        );
    }
}
