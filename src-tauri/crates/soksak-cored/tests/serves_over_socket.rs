//! cored 를 실제로 띄워 소켓으로 묻고 답을 받는다 — 이 갈래의 GREEN.
//!
//! 인프로세스 단위 테스트는 "표가 옳다"까지만 증명한다. 이 프로세스가 존재하는 이유는
//! **다른 프로세스에서 같은 답이 나온다**는 것이므로, 증명도 프로세스를 건너야 한다:
//! 바이너리를 스폰하고, 소켓을 열고, 줄을 주고받는다.
//!
//! 준비 완료 신호는 stdout 한 줄이다 — 테스트는 그 줄에서 블로킹 read 로 기다린다.
//! 소켓 파일이 생겼는지 반복해 보는 폴링은 쓰지 않는다(파일 존재는 bind 완료가 아니다).

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

/// 살아 있는 cored — 드롭될 때 프로세스를 거둔다(테스트가 실패해도 고아를 남기지 않는다).
struct Helper {
    child: Child,
    socket: PathBuf,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Helper {
    /// 이 cored 의 픽스처 루트(소켓이 사는 디렉터리).
    fn dir(&self) -> &std::path::Path {
        self.socket.parent().expect("소켓의 부모")
    }

    /// 이 프로세스가 서빙하는 정체성 홈. 부팅 인자로 준 것과 같은 값이라야 한다.
    fn home(&self) -> PathBuf {
        self.dir().join("home")
    }

    /// OS 사용자 홈 — 정체성 홈과 **다른 값**이다(`~/.soksak-dev` 의 `~`).
    /// 파일 트리의 기본 뿌리이자 `~` 확장의 기준이라, 픽스처도 둘을 갈라 둔다.
    fn user_home(&self) -> PathBuf {
        self.dir().join("user")
    }

    /// 한 줄 요청 → 한 줄 응답. 연결은 요청마다 새로 연다(NDJSON 요청/응답의 최소 단위).
    fn ask(&self, req: Value) -> Value {
        let conn = UnixStream::connect(&self.socket).expect("cored 소켓 연결");
        conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut writer = conn.try_clone().unwrap();
        writeln!(writer, "{req}").expect("요청 쓰기");
        writer.flush().unwrap();
        let mut line = String::new();
        BufReader::new(conn).read_line(&mut line).expect("응답 읽기");
        assert!(!line.trim().is_empty(), "빈 응답 — cored 가 답하지 않았다");
        serde_json::from_str(line.trim()).expect("응답은 한 줄 JSON")
    }
}

/// 테스트 루트 — 홈 아래 고정 경로다(재사용·멱등).
///
/// cargo 의 `CARGO_TARGET_TMPDIR` 을 쓰지 않는 이유가 있다: 유닉스 소켓 경로에는 OS 상한이
/// 있어서(macOS ~104 바이트) `target/tmp/...` 아래 워크트리 경로는 그것만으로 상한을 넘긴다.
/// 짧고 고정된 루트라야 어디서 체크아웃해도 이 테스트가 돈다.
fn fixture_dir(name: &str) -> PathBuf {
    let home = std::env::var("HOME").expect("HOME");
    let dir = PathBuf::from(home).join(".soksak-cored-test").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("픽스처 루트 생성");
    dir
}

/// cored 를 띄우고 준비 완료 줄을 기다린다.
///
/// 정체성을 **인자로 준다** — cored 는 자기 홈을 파생하지 않는다. 테스트가 홈을 지목하므로
/// 홈 아래를 보는 명령(themes_scan·plugin_scan·app_environment)까지 이 프로세스 밖에서
/// 검증된다. 인자를 빼면 cored 는 뜨지 않는다(그 자체도 아래에서 단언한다).
fn spawn_helper(name: &str) -> Helper {
    let dir = fixture_dir(name);
    let socket = dir.join("h.sock");
    let home = dir.join("home");
    let user_home = dir.join("user");
    std::fs::create_dir_all(&home).expect("픽스처 홈 생성");
    std::fs::create_dir_all(&user_home).expect("픽스처 사용자 홈 생성");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket")
        .arg(&socket)
        .arg("--home")
        .arg(&home)
        .arg("--identifier")
        .arg("com.soksak.dev")
        .arg("--user-home")
        .arg(&user_home)
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    // 준비 완료 = stdout 한 줄. 블로킹 read 라 폴링이 없고, cored 가 죽으면 EOF 로 즉시 드러난다.
    let mut ready = String::new();
    let stdout = child.stdout.take().expect("stdout 파이프");
    let read = BufReader::new(stdout).read_line(&mut ready);
    assert!(
        matches!(read, Ok(n) if n > 0),
        "cored 가 준비 완료를 알리지 않고 죽었다: {read:?}"
    );
    assert!(
        ready.contains(&socket.to_string_lossy().to_string()),
        "준비 완료 줄이 소켓 경로를 말해야 한다: {ready}"
    );
    Helper { child, socket }
}

// ── 살아 있는 프로세스가 실제로 명령을 서빙한다 ──────────────────────────────────

// binary_integrity 는 디스크만 만지는 순수 관찰이다. 실재하는 파일을 두고 물으면
// present 가 나와야 한다 — cored 가 soksak-core 을 실제로 부르고 있다는 증거.
#[test]
fn serves_a_portable_command_over_the_socket() {
    let helper = spawn_helper("serves-portable");
    let bin = helper.dir().join("some-bin");
    std::fs::write(&bin, b"#!/bin/sh\n").unwrap();

    let reply = helper.ask(json!({
        "id": 7,
        "method": "binary_integrity",
        "params": {
            "binPath": bin.to_string_lossy(),
            "libPath": helper.dir().join("nope").to_string_lossy(),
        },
    }));

    assert_eq!(reply["ok"], true, "응답: {reply}");
    assert_eq!(reply["id"], 7, "id 는 그대로 되돌아온다: {reply}");
    // data 는 앱의 invoke 가 돌려주는 값 그대로다 — 봉투만 소켓 계약이 얹는다.
    assert_eq!(reply["data"]["present"], true, "응답: {reply}");
    assert_eq!(reply["data"]["partial"], false, "응답: {reply}");
    assert_eq!(reply["data"]["broken"], false, "응답: {reply}");
}

// UDP 는 디스크가 아니라 실제 소켓을 쓴다 — cored 프로세스가 진짜로 패킷을 보내는지.
// 답만 그럴듯한 것과 실제로 일한 것을 가른다.
#[test]
fn a_served_command_really_does_the_work() {
    let helper = spawn_helper("really-works");
    let recv = UdpSocket::bind("127.0.0.1:0").unwrap();
    recv.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let port = recv.local_addr().unwrap().port();

    let reply = helper.ask(json!({
        "id": "u1",
        "method": "net_udp_send",
        "params": { "host": "127.0.0.1", "port": port, "data": [9, 8, 7] },
    }));

    assert_eq!(reply["ok"], true, "응답: {reply}");
    assert_eq!(reply["data"], 3, "보낸 바이트 수를 그대로 돌려준다: {reply}");

    let mut buf = [0u8; 16];
    let (n, _) = recv.recv_from(&mut buf).expect("cored 가 보낸 패킷 수신");
    assert_eq!(&buf[..n], &[9u8, 8, 7], "cored 프로세스가 실제로 보냈다");
}

// 실패도 프로세스를 건너야 한다 — 코어 로직의 거부 사유가 message 로 그대로 온다.
#[test]
fn a_refusal_crosses_the_socket_with_its_reason() {
    let helper = spawn_helper("refusal");
    let reply = helper.ask(json!({
        "id": 1,
        "method": "cleanup_stale",
        "params": { "path": "/etc/passwd", "allowedRoots": ["/nowhere"] },
    }));
    assert_eq!(reply["ok"], false, "화이트리스트 밖은 거부: {reply}");
    let msg = reply["message"].as_str().unwrap_or_default();
    assert!(msg.contains("/etc/passwd"), "거부 사유가 경로를 말한다: {reply}");
}

// ── 모르는 것은 이름을 달고 실패한다 ────────────────────────────────────────────

#[test]
fn an_unknown_command_fails_by_name() {
    let helper = spawn_helper("unknown-command");
    let reply = helper.ask(json!({ "id": 2, "method": "webview_overlay_active", "params": {} }));
    assert_eq!(reply["ok"], false, "응답: {reply}");
    assert_eq!(reply["code"], "UNKNOWN_COMMAND", "응답: {reply}");
    assert!(
        reply["message"]
            .as_str()
            .unwrap_or_default()
            .contains("webview_overlay_active"),
        "모르는 명령의 이름을 말해야 한다: {reply}"
    );
}

// 이름은 아는데 인자가 틀린 것도 조용히 넘어가지 않는다.
#[test]
fn bad_arguments_fail_by_name() {
    let helper = spawn_helper("bad-args");
    let reply = helper.ask(json!({ "id": 3, "method": "binary_integrity", "params": { "binPath": 5 } }));
    assert_eq!(reply["ok"], false, "응답: {reply}");
    assert_eq!(reply["code"], "INVALID_PARAMS", "응답: {reply}");
    assert!(
        reply["message"]
            .as_str()
            .unwrap_or_default()
            .contains("binary_integrity"),
        "어느 명령의 인자가 틀렸는지 말해야 한다: {reply}"
    );
}

// ── 발견 가능한 표면 ────────────────────────────────────────────────────────────

// 서빙 목록은 코드를 읽어야 아는 것이 아니라 물어서 아는 것이다(R7).
#[test]
fn the_served_commands_are_discoverable() {
    let helper = spawn_helper("discoverable");
    let reply = helper.ask(json!({ "id": 4, "method": "cored.commands" }));
    assert_eq!(reply["ok"], true, "응답: {reply}");
    let cmds = reply["data"]["commands"].as_array().expect("commands 배열");
    let names: Vec<&str> = cmds.iter().filter_map(|c| c["name"].as_str()).collect();
    for expected in [
        "net_udp_send",
        "net_udp_request",
        "binary_integrity",
        "cleanup_stale",
        "verify_and_link",
        "ai_session_detect",
    ] {
        assert!(names.contains(&expected), "{expected} 이 목록에 없다: {names:?}");
    }
    // 이름만으로는 부를 수 없다 — 인자와 반환이 함께 선언돼야 한다.
    let one = cmds
        .iter()
        .find(|c| c["name"] == "binary_integrity")
        .expect("binary_integrity 선언");
    assert!(one["args"].is_array(), "인자 선언: {one}");
    assert!(one["returns"].is_string(), "반환 선언: {one}");
}

// 소켓 판 협상은 앱과 같은 계약(soksak-spec-socket)을 쓴다 — 사본 금지.
#[test]
fn hello_declares_the_socket_protocol() {
    let helper = spawn_helper("hello");
    let reply = helper.ask(json!({ "id": 5, "method": "system.hello" }));
    assert_eq!(reply["ok"], true, "응답: {reply}");
    assert_eq!(
        reply["protocol"],
        soksak_spec_socket::SOCKET_PROTOCOL_VERSION,
        "응답: {reply}"
    );
    assert_eq!(reply["role"], "cored", "무엇이 답했는지 말한다: {reply}");
}

// 미래 판을 선언한 클라이언트는 명령에 도달하지 못한다(앱의 게이트와 같은 판정).
#[test]
fn a_future_client_is_gated_before_the_command_runs() {
    let helper = spawn_helper("skew");
    let reply = helper.ask(json!({
        "id": 6,
        "method": "binary_integrity",
        "protocol": soksak_spec_socket::SOCKET_PROTOCOL_VERSION + 1,
        "params": { "binPath": "/x", "libPath": "/y" },
    }));
    assert_eq!(reply["ok"], false, "응답: {reply}");
    assert_eq!(reply["code"], "VERSION_SKEW", "응답: {reply}");
}

// ── 기본 표면 ───────────────────────────────────────────────────────────────────

#[test]
fn help_and_version_answer_without_a_socket() {
    for flag in ["--help", "--version"] {
        let out = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
            .arg(flag)
            .output()
            .expect("cored 실행");
        assert!(out.status.success(), "{flag} 는 성공해야 한다: {out:?}");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("soksak-cored"), "{flag} 출력: {text}");
    }
}

// 유닉스 소켓 경로에는 OS 상한이 있다(macOS ~104 바이트). 깊은 트리에서 조용히 넘기는데,
// OS 가 주는 "path must be shorter than SUN_LEN" 만으로는 얼마나 긴지 알 수 없다 — 실제
// 길이를 말해야 부르는 쪽이 고칠 수 있다. (이 테스트 자신이 그 함정에 먼저 빠졌다.)
#[test]
fn an_overlong_socket_path_says_how_long_it_was() {
    let dir = fixture_dir("overlong");
    let socket = dir.join("x".repeat(200)).with_extension("sock");
    let out = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket")
        .arg(&socket)
        .arg("--home")
        .arg(&dir)
        .arg("--identifier")
        .arg("com.soksak.dev")
        .output()
        .expect("cored 실행");
    assert!(!out.status.success(), "상한 밖 경로로 성공하면 안 된다");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(&socket.as_os_str().len().to_string()),
        "실제 길이를 말해야 한다: {err}"
    );
    assert!(err.contains("--socket"), "무엇을 고쳐야 하는지 말해야 한다: {err}");
}

// 소켓 경로 없이는 서빙할 수 없다 — 홈을 스스로 추측하지 않는다(Identity). 조용히
// 기본값을 고르는 대신 이름을 달고 실패한다.
#[test]
fn a_missing_socket_path_fails_by_name() {
    let out = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .output()
        .expect("cored 실행");
    assert!(!out.status.success(), "소켓 경로 없이 성공하면 안 된다: {out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("--socket"), "무엇이 없는지 말해야 한다: {err}");
}

// ── 부팅 상태를 쓰는 명령 ────────────────────────────────────────────────────
//
// 이 갈래가 없어서 결함이 살아남았다(2026-07-28): 인프로세스 검사는 "인자를 선언대로 읽는가"
// 만 봤고, 소켓 검사는 인자 없는 명령을 하나도 부르지 않았다. 그래서 cored 가 **앱과 다른
// 모양**을 요구한다는 사실이 라이브 부팅에서야 INVALID_PARAMS 한 줄로 드러났다.
//
// 아래 검사들은 전부 UI 가 실제로 보내는 모양 — 즉 **인자 없이** 부른다.

/// 홈 아래를 훑는 명령은 부팅 때 받은 홈을 본다. 인자를 요구하지 않는다.
#[test]
fn a_home_scan_uses_the_boot_home_not_an_argument() {
    let helper = spawn_helper("boot-home");
    let themes = helper.home().join("themes");
    std::fs::create_dir_all(&themes).unwrap();
    std::fs::write(themes.join("midnight.json"), br#"{"name":"Midnight"}"#).unwrap();

    // UI 는 `invoke("themes_scan")` 를 인자 없이 부른다 — 앱 명령이 인자를 안 받기 때문이다.
    let reply = helper.ask(json!({ "id": 1, "method": "themes_scan" }));
    assert_eq!(reply["ok"], true, "{reply}");
    let found = reply["data"].as_array().expect("배열");
    assert_eq!(found.len(), 1, "{reply}");
    assert_eq!(
        found[0]["file"],
        themes.join("midnight.json").to_string_lossy().to_string(),
        "스캔이 부팅 홈 아래를 봤다: {reply}"
    );
}

/// 정체성을 묻는 명령도 마찬가지다 — identifier 는 부팅 때 받았다.
#[test]
fn the_environment_answers_from_boot_state() {
    let helper = spawn_helper("boot-env");
    let reply = helper.ask(json!({ "id": 2, "method": "app_environment" }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["identity"], "com.soksak.dev", "{reply}");
    assert_eq!(reply["data"]["coreBuild"], "dev", "{reply}");
    assert_eq!(reply["data"]["cli"], "sok-dev", "{reply}");
    assert_eq!(
        reply["data"]["home"],
        helper.home().to_string_lossy().to_string(),
        "{reply}"
    );

    let is_release = helper.ask(json!({ "id": 3, "method": "app_is_release" }));
    assert_eq!(is_release["data"], false, "{is_release}");
}

/// 인자 없는 명령이 인자를 요구하면 UI 의 같은 호출이 앱에서는 되고 cored 에서는 거절된다.
/// 그 비대칭 자체를 막는다: `{}` 도 `null` 도 생략도 전부 같은 답이라야 한다.
#[test]
fn an_argumentless_command_accepts_every_empty_shape() {
    let helper = spawn_helper("boot-empty");
    let shapes = [json!({}), Value::Null];
    for params in shapes {
        let reply = helper.ask(json!({ "method": "app_is_release", "params": params.clone() }));
        assert_eq!(reply["ok"], true, "params={params}: {reply}");
    }
    let omitted = helper.ask(json!({ "method": "app_is_release" }));
    assert_eq!(omitted["ok"], true, "{omitted}");
}

/// 정체성 없이는 서빙하지 않는다. 홈을 추측하는 cored 는 **다른 identity 의 답을 성공처럼**
/// 돌려주고, 그 오답은 오류가 아니라 빈 결과로 나타난다.
#[test]
fn a_missing_identity_fails_by_name() {
    let dir = fixture_dir("no-identity");
    for missing in ["--home", "--identifier"] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_soksak-cored"));
        cmd.arg("--socket").arg(dir.join("h.sock"));
        if missing != "--home" {
            cmd.arg("--home").arg(&dir);
        }
        if missing != "--identifier" {
            cmd.arg("--identifier").arg("com.soksak.dev");
        }
        let out = cmd.output().expect("cored 실행");
        assert!(!out.status.success(), "{missing} 없이 성공하면 안 된다");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains(missing), "무엇이 빠졌는지 말해야 한다: {err}");
    }
}

/// 저장소를 옮긴 앱과 같은 파일을 봐야 한다 — cored 가 규칙만 보고 파생하면 다른 DB 를 열고
/// 그 차이는 "없음"으로 조용히 나타난다.
#[test]
fn a_relocated_store_is_followed_not_re_derived() {
    let dir = fixture_dir("relocated-store");
    let home = dir.join("home");
    let moved = dir.join("elsewhere");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&moved).unwrap();

    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket")
        .arg(&socket)
        .arg("--home")
        .arg(&home)
        .arg("--identifier")
        .arg("com.soksak.dev")
        .arg("--data-dir")
        .arg(&moved)
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let mut ready = String::new();
    let stdout = child.stdout.take().expect("stdout 파이프");
    assert!(
        matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0),
        "cored 가 준비 완료를 알리지 않고 죽었다"
    );
    let helper = Helper { child, socket };

    // 쓴 값이 **지목된 곳**에 있어야 하고 홈 아래에는 없어야 한다. 옛 판은 "열기 실패"를
    // 신호로 썼는데, 이제 쓰기 소유권을 잡은 cored 가 형태를 세우므로 열기가 성공한다 —
    // 그래서 더 강한 기준으로 옮긴다: 답이 아니라 **파일이 어디 생겼는가**를 본다.
    let wrote = helper.ask(json!({
        "method": "data_kv_set", "params": { "ns": "core", "key": "bookmarks", "value": "moved" }
    }));
    assert_eq!(wrote["ok"], true, "{wrote}");
    let read = helper.ask(json!({
        "method": "data_kv_get", "params": { "ns": "core", "key": "bookmarks" }
    }));
    assert_eq!(read["data"], "moved", "{read}");
    assert!(
        moved.join("soksak.db").exists(),
        "지목된 곳에 저장소가 없다: {}",
        moved.display()
    );
    assert!(
        !home.join("data").join("soksak.db").exists(),
        "규칙으로 파생한 곳에 저장소를 만들었다 — 지목을 무시했다: {}",
        home.display()
    );
}

// 감사해서 서빙하지 않기로 한 이름은 목록에 사유와 함께 있어야 한다. 셸 저자는 이 프로세스에
// 물어서 "이건 네가 해야 한다, 이유는 이것"을 알아야 하고, 그렇지 않으면 막힌 이유를 다시
// 조사하거나 — 더 나쁘게는 조사 없이 흉내를 낸다.
#[test]
fn what_it_refuses_is_discoverable_with_the_reason() {
    let helper = spawn_helper("unserved");
    let reply = helper.ask(json!({ "id": 8, "method": "cored.commands" }));
    assert_eq!(reply["ok"], true, "응답: {reply}");
    let unserved = reply["data"]["unserved"]
        .as_array()
        .unwrap_or_else(|| panic!("unserved 선언이 없다: {reply}"));
    let named: Vec<&str> = unserved.iter().filter_map(|u| u["name"].as_str()).collect();
    for expected in ["project_owners", "net_http_request", "process_reclaim_window"] {
        assert!(named.contains(&expected), "{expected} 이 없다: {named:?}");
    }
    // 이름만 있고 이유가 없으면 다음 사람이 "왜 안 되지"부터 다시 한다.
    for u in unserved {
        assert!(
            !u["blockedBy"].as_str().unwrap_or_default().is_empty(),
            "이유 없는 금지: {u}"
        );
    }
}

// 그 사유는 실제로 부를 때도 온다 — 목록을 먼저 읽지 않은 호출자가 침묵을 받지 않도록.
// 선언한 문자열과 같은지까지 본다: 두 벌이면 한쪽만 고쳐지고 목록과 응답이 갈린다.
#[test]
fn calling_an_audited_name_carries_the_reason_across_the_socket() {
    let helper = spawn_helper("unserved-call");
    let table = helper.ask(json!({ "id": 9, "method": "cored.commands" }));
    let declared = table["data"]["unserved"]
        .as_array()
        .and_then(|u| u.iter().find(|e| e["name"] == "process_reclaim_window"))
        .and_then(|e| e["blockedBy"].as_str())
        .unwrap_or_else(|| panic!("사유 선언이 없다: {table}"))
        .to_string();

    let reply = helper.ask(json!({ "id": 10, "method": "process_reclaim_window", "params": {} }));
    assert_eq!(reply["ok"], false, "응답: {reply}");
    assert_eq!(reply["code"], "UNKNOWN_COMMAND", "응답: {reply}");
    let msg = reply["message"].as_str().unwrap_or_default();
    assert!(msg.contains("process_reclaim_window"), "응답: {reply}");
    assert!(msg.contains(&declared), "선언한 사유가 응답에 없다: {reply}");
}

// ── 활동 원장 — 적재는 프로세스를 건너서도 같은 규칙이다 ──────────────────────

/// 앱이 만드는 records 스키마 그대로의 저장소 하나(활동 행 seq 포함).
/// cored 가 보는 곳에 만든다 — 저장소 경로는 인자가 아니라 부팅 상태다.
fn ledger_store(helper: &Helper, seq: u64) -> PathBuf {
    let dir = helper.home().join("data");
    std::fs::create_dir_all(&dir).expect("데이터 디렉터리");
    let path = dir.join("soksak.db");
    let conn = rusqlite::Connection::open(&path).expect("저장소 생성");
    // 형태는 코어가 소유한다(cored 가 부팅에서 이미 세웠을 수도 있어 멱등이라야 한다).
    conn.execute_batch(soksak_core::kv::BASE_SCHEMA_SQL)
        .expect("스키마");
    conn.execute(
        "INSERT INTO records(ns,coll,scope,id,doc,created,updated) \
         VALUES('core','activity','app',?1,?2,0,0)",
        (format!("a{seq:016}"), format!(r#"{{"seq":{seq},"kind":"k"}}"#)),
    )
    .expect("행");
    path
}

// cored 는 적재분을 답에 실어 준다 — 창은 셸의 것이므로 부채질은 그 항목을 받은 셸이 한다.
// 그리고 번호는 저장소가 이미 가진 역사 **위에서** 이어야 한다: 0 부터 다시 매기면
// 소비자의 영속 읽음 커서가 미래를 가리켜 그 소비자가 전면 침묵한다.
#[test]
fn admission_crosses_the_socket_and_resumes_above_the_stored_history() {
    let helper = spawn_helper("activity-admit");
    ledger_store(&helper, 40_000);

    // UI 가 보내는 모양 그대로 — 앱의 activity_publish 도 kind·source·payload 뿐이다.
    let reply = helper.ask(json!({
        "id": 11,
        "method": "activity_publish",
        "params": { "kind": "boot.step", "source": "core", "payload": { "step": "ready" } },
    }));

    assert_eq!(reply["ok"], true, "응답: {reply}");
    assert_eq!(reply["id"], 11, "응답: {reply}");
    // data 는 앱의 invoke 가 돌려주는 값 그대로다 — 셸이 값을 다시 조립하지 않는다.
    let entry = &reply["data"];
    assert_eq!(entry["seq"], 40_001, "영속 역사 위에서 재개: {reply}");
    assert_eq!(entry["kind"], "boot.step", "{reply}");
    assert_eq!(entry["source"], "core", "{reply}");
    assert_eq!(entry["payload"]["step"], "ready", "{reply}");
    assert!(entry["ts"].as_u64().is_some_and(|t| t > 0), "{reply}");

    // 같은 프로세스의 두 번째 적재는 그다음 번호다(연결이 달라도 원장은 하나).
    let again = helper.ask(json!({
        "id": 12,
        "method": "activity_publish",
        "params": { "kind": "boot.step", "source": "core", "payload": {} },
    }));
    assert_eq!(again["data"]["seq"], 40_002, "단조: {again}");
}

// 재개 지점을 모르는 채로는 적재하지 않는다 — 조용히 새 원장을 시작하는 것이 위 결함이다.
//
// 쓰기 소유권을 잡으면 cored 가 형태를 세우므로 원장은 읽을 수 있게 된다. 그래서 이 검사가
// 겨누는 것은 **소유권이 없는 경우**다: 만들 자격이 없고 읽을 것도 없을 때, 0 부터 매기는
// 대신 이름을 달고 실패해야 한다.
#[test]
fn admission_without_a_readable_ledger_fails_by_name() {
    let dir = fixture_dir("activity-no-store");
    let home = dir.join("home");
    let data = home.join("data");
    std::fs::create_dir_all(&data).unwrap();

    // 남이 쓰기 잠금을 쥔다 — cored 는 형태를 세울 자격이 없다.
    let held = std::fs::File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(data.join("soksak.db.writelock"))
        .unwrap();
    held.try_lock().expect("테스트가 먼저 잡는다");

    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let mut ready = String::new();
    let stdout = child.stdout.take().unwrap();
    assert!(matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0));
    let helper = Helper { child, socket };

    let reply = helper.ask(json!({
        "method": "activity_publish",
        "params": { "kind": "k", "source": "core", "payload": {} },
    }));
    assert_eq!(reply["ok"], false, "응답: {reply}");
    assert_eq!(reply["code"], "COMMAND_FAILED", "응답: {reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("원장"),
        "사유가 원장을 말한다: {reply}"
    );
}

// ── 저장소 쓰기 — 소유권을 증명한 프로세스만 ────────────────────────────────
//
// 부팅 요구 원장에서 마지막 구멍이 data_kv_set 이었다(쓰기라 읽기 전용 연결로는 못 답한다).
// 쓰기를 서빙하되 "두 프로세스가 같은 파일에 쓰지 않는다"는 전제를 코드 배치가 아니라
// **잠금으로** 증명한다.

/// 앱이 만드는 kv 스키마 그대로의 저장소.
fn kv_store(helper: &Helper) -> PathBuf {
    let dir = helper.home().join("data");
    std::fs::create_dir_all(&dir).expect("데이터 디렉터리");
    let path = dir.join("soksak.db");
    let conn = rusqlite::Connection::open(&path).expect("저장소 생성");
    conn.execute_batch(soksak_core::kv::BASE_SCHEMA_SQL)
        .expect("스키마");
    path
}

/// 쓴 값을 같은 소켓으로 되읽을 수 있어야 한다 — 두 명령이 같은 저장소를 본다는 증거.
#[test]
fn a_written_value_reads_back_through_the_same_socket() {
    let helper = spawn_helper("kv-write");
    kv_store(&helper);

    let set = helper.ask(json!({
        "id": 20, "method": "data_kv_set",
        "params": { "ns": "core", "key": "layout", "value": { "rail": 240 } }
    }));
    assert_eq!(set["ok"], true, "{set}");

    let got = helper.ask(json!({
        "id": 21, "method": "data_kv_get", "params": { "ns": "core", "key": "layout" }
    }));
    assert_eq!(got["ok"], true, "{got}");
    assert_eq!(got["data"]["rail"], 240, "{got}");
}

/// 덮어쓰기는 마지막 값이 남는다(앱의 upsert 와 같은 규칙).
#[test]
fn writing_twice_keeps_the_last_value() {
    let helper = spawn_helper("kv-overwrite");
    kv_store(&helper);
    for v in [1, 2] {
        let r = helper.ask(json!({
            "method": "data_kv_set", "params": { "ns": "core", "key": "n", "value": v }
        }));
        assert_eq!(r["ok"], true, "{r}");
    }
    let got = helper.ask(json!({
        "method": "data_kv_get", "params": { "ns": "core", "key": "n" }
    }));
    assert_eq!(got["data"], 2, "{got}");
}

/// 네임스페이스 규칙은 앱과 같은 것을 쓴다 — cored 에서만 통과하는 ns 가 있으면 안 된다.
#[test]
fn the_namespace_rule_is_the_apps_rule() {
    let helper = spawn_helper("kv-ns");
    kv_store(&helper);
    let r = helper.ask(json!({
        "method": "data_kv_set", "params": { "ns": "../etc", "key": "k", "value": 1 }
    }));
    assert_eq!(r["ok"], false, "{r}");
}

/// **쓰기 소유권이 없으면 쓰지 않는다.** 다른 프로세스가 잠금을 쥔 채로 cored 를 띄우면
/// 읽기는 서빙하되 쓰기는 이름을 달고 거절해야 한다 — 조용히 쓰면 이 잠금이 막으려던
/// 이중 쓰기가 그대로 일어난다.
#[test]
fn without_the_write_lock_a_write_is_refused_and_a_read_still_works() {
    let dir = fixture_dir("kv-not-owner");
    let home = dir.join("home");
    let data = home.join("data");
    std::fs::create_dir_all(&data).unwrap();

    // 저장소와 값 하나를 미리 만들어 둔다(읽기가 여전히 되는지 보기 위해).
    let db = data.join("soksak.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, \
         updated INTEGER NOT NULL, PRIMARY KEY(ns, k)) WITHOUT ROWID;\
         INSERT INTO kv VALUES('core','seeded','\"before\"',0);",
    )
    .unwrap();
    drop(conn);

    // 남이 쓰기 잠금을 쥔 상태를 만든다 — 이 서술자가 살아 있는 동안 cored 는 못 잡는다.
    let held = std::fs::File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(data.join("soksak.db.writelock"))
        .unwrap();
    held.try_lock().expect("테스트가 먼저 잡는다");

    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let mut ready = String::new();
    let stdout = child.stdout.take().unwrap();
    assert!(
        matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0),
        "쓰기 소유권이 없어도 서빙은 시작한다 — 읽기 서버로 산다"
    );
    let helper = Helper { child, socket };

    let read = helper.ask(json!({
        "method": "data_kv_get", "params": { "ns": "core", "key": "seeded" }
    }));
    assert_eq!(read["ok"], true, "읽기는 여전히 된다: {read}");
    assert_eq!(read["data"], "before", "{read}");

    let write = helper.ask(json!({
        "method": "data_kv_set", "params": { "ns": "core", "key": "seeded", "value": "after" }
    }));
    assert_eq!(write["ok"], false, "소유권 없이 썼다: {write}");
    let msg = write["message"].as_str().unwrap_or_default();
    assert!(msg.contains("쓰기"), "무엇이 막았는지 말해야 한다: {write}");

    // 값이 실제로 안 바뀌었는지 — 거절이 말뿐이 아니어야 한다.
    let after = helper.ask(json!({
        "method": "data_kv_get", "params": { "ns": "core", "key": "seeded" }
    }));
    assert_eq!(after["data"], "before", "거절해 놓고 썼다: {after}");
}

// ── 로그인 셸을 인자로 받는다 ────────────────────────────────────────────────
//
// 이식을 막던 사유("부팅 인자로 셸을 받으면 GUI 의 좁은 PATH 에 다시 묶인다")는 성립하지
// 않는다 — 넘기는 값은 PATH 가 아니라 셸 실행 파일 경로이고 `-l` 이 rc/profile 로 PATH 를
// 새로 만든다. 사유가 사라졌으므로 두 명령은 서빙 가능하다.
//
// 판별자: **픽스처 셸만 낼 수 있는 답**을 요구한다. 프로세스 env 를 읽고 있으면 진짜 셸이
// 답하므로 통과할 수 없다.

/// 답을 아는 가짜 셸 — `-lc <cmd>` 를 받아 정해진 답만 낸다.
fn fixture_shell(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("fixture-shell");
    std::fs::write(
        &path,
        "#!/bin/sh\n\
         # 이 셸만이 이렇게 답한다: sh 는 없다고, npm prefix 는 /fixture/prefix 라고.\n\
         case \"$2\" in\n\
         *'command -v sh'*) exit 1 ;;\n\
         *'command -v node'*) echo /fixture/bin/node; exit 0 ;;\n\
         *'npm prefix -g'*) echo /fixture/prefix; exit 0 ;;\n\
         *) exit 1 ;;\n\
         esac\n",
    )
    .expect("픽스처 셸");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn spawn_with_shell(name: &str) -> (Helper, std::path::PathBuf) {
    let dir = fixture_dir(name);
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let shell = fixture_shell(&dir);
    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .arg("--login-shell").arg(&shell)
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let mut ready = String::new();
    let stdout = child.stdout.take().unwrap();
    assert!(matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0));
    (Helper { child, socket }, shell)
}

#[test]
fn serves_shell_which_by_asking_the_shell_it_was_given() {
    let (helper, _shell) = spawn_with_shell("shell-which");

    // 픽스처 셸은 sh 가 **없다**고 답한다. 진짜 셸에 물었다면 sh 는 반드시 있으므로 true 다 —
    // 그래서 이 false 하나가 "인자로 받은 셸에 물었는가"의 판별자다.
    let reply = helper.ask(json!({
        "method": "shell_which", "params": { "bin": "sh" }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"], false, "프로세스 env 의 셸에 물었다: {reply}");

    let found = helper.ask(json!({
        "method": "shell_which", "params": { "bin": "node" }
    }));
    assert_eq!(found["data"], true, "{found}");

    // 주입은 셸에 닿기 전에 막힌다.
    let bad = helper.ask(json!({
        "method": "shell_which", "params": { "bin": "a;id" }
    }));
    assert_eq!(bad["data"], false, "셸 메타문자를 넘겼다: {bad}");
}

#[test]
fn serves_npm_global_dirs_from_the_shell_it_was_given() {
    let (helper, _shell) = spawn_with_shell("npm-dirs");
    let reply = helper.ask(json!({ "method": "npm_global_dirs", "params": {} }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["bin_dir"], "/fixture/prefix/bin", "{reply}");
    assert_eq!(reply["data"]["lib_dir"], "/fixture/prefix/lib", "{reply}");
}

// ── 파일 읽기·쓰기 — 디스크는 셸이 아니다 ────────────────────────────────────
//
// 이 갈래의 홈은 **둘**이다. 정체성 홈(`~/.soksak-dev`)과 OS 사용자 홈(`~`)은 다른 값이고,
// 파일 트리·`~` 확장이 보는 것은 후자다. cored 는 둘 다 부팅 인자로 받는다 — 사용자 홈을
// 정체성 홈에서 파생하면(부모 디렉터리) 픽스처·격리 배치에서 조용히 다른 곳을 훑는다.

/// 읽기가 프로세스를 건넌다 — 인자 모양은 앱의 read_text_file 과 같다(path·offset).
#[test]
fn a_text_file_reads_back_across_the_socket() {
    let helper = spawn_helper("fs-read-text");
    let f = helper.dir().join("note.txt");
    std::fs::write(&f, "first\nsecond\n").unwrap();

    let reply = helper.ask(json!({
        "id": 30, "method": "read_text_file", "params": { "path": f.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["content"], "first\nsecond\n", "{reply}");
    assert_eq!(reply["data"]["truncated"], false, "{reply}");
    assert_eq!(reply["data"]["total_bytes"], 13, "{reply}");
    assert_eq!(reply["data"]["line_count"], 2, "{reply}");
}

/// offset 은 증가하는 로그의 증분 tail 축이다 — 델타만 읽고 total 은 실제 크기를 말한다.
#[test]
fn an_offset_read_carries_only_the_delta() {
    let helper = spawn_helper("fs-read-offset");
    let f = helper.dir().join("log.jsonl");
    std::fs::write(&f, "aaaa\nbbbb\n").unwrap();

    let reply = helper.ask(json!({
        "id": 31, "method": "read_text_file",
        "params": { "path": f.to_string_lossy(), "offset": 5 }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["content"], "bbbb\n", "{reply}");
    assert_eq!(reply["data"]["read_bytes"], 5, "{reply}");
    assert_eq!(reply["data"]["total_bytes"], 10, "{reply}");
}

/// 바이너리는 이름을 달고 거절한다 — 프론트가 그 사유로 미리보기 경로로 갈린다.
#[test]
fn a_binary_file_is_refused_by_name() {
    let helper = spawn_helper("fs-read-binary");
    let f = helper.dir().join("blob.bin");
    std::fs::write(&f, [0u8, 1, 2, 3]).unwrap();

    let reply = helper.ask(json!({
        "id": 32, "method": "read_text_file", "params": { "path": f.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("바이너리"),
        "사유가 바이너리를 말한다: {reply}"
    );
}

/// 쓰고 같은 소켓으로 되읽는다 — 두 명령이 같은 디스크를 본다는 증거.
#[test]
fn a_written_file_reads_back_through_the_same_socket() {
    let helper = spawn_helper("fs-write");
    let f = helper.dir().join("edit.txt");

    let set = helper.ask(json!({
        "id": 33, "method": "write_text_file",
        "params": { "path": f.to_string_lossy(), "content": "first\nedit" }
    }));
    assert_eq!(set["ok"], true, "{set}");

    let got = helper.ask(json!({
        "id": 34, "method": "read_text_file", "params": { "path": f.to_string_lossy() }
    }));
    assert_eq!(got["data"]["content"], "first\nedit", "{got}");
}

/// 재저장은 이전 내용을 통째로 대체한다(앱의 ⌘S 재호출과 같은 규칙).
#[test]
fn writing_twice_replaces_the_whole_file() {
    let helper = spawn_helper("fs-write-twice");
    let f = helper.dir().join("edit.txt");
    for content in ["a longer first version", "short"] {
        let r = helper.ask(json!({
            "method": "write_text_file",
            "params": { "path": f.to_string_lossy(), "content": content }
        }));
        assert_eq!(r["ok"], true, "{r}");
    }
    assert_eq!(
        std::fs::read_to_string(&f).unwrap(),
        "short",
        "덮어쓰기가 앞부분만 갈아치웠다"
    );
}

/// 미리보기는 base64 + MIME 로 온다.
#[test]
fn a_preview_crosses_as_base64_with_its_mime() {
    let helper = spawn_helper("fs-base64");
    let f = helper.dir().join("dot.png");
    std::fs::write(&f, [0u8, 1, 2]).unwrap();

    let reply = helper.ask(json!({
        "id": 35, "method": "read_file_base64", "params": { "path": f.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["mime"], "image/png", "{reply}");
    assert_eq!(reply["data"]["base64"], "AAEC", "{reply}");
}

/// 나열은 폴더 먼저, 그다음 이름순(대소문자 무시) — 앱의 트리와 같은 순서.
#[test]
fn children_are_listed_folders_first_then_by_name() {
    let helper = spawn_helper("fs-list");
    let root = helper.dir().join("tree");
    std::fs::create_dir_all(root.join("Zebra")).unwrap();
    std::fs::write(root.join("apple.txt"), "a").unwrap();
    std::fs::write(root.join("Banana.txt"), "b").unwrap();

    let reply = helper.ask(json!({
        "id": 36, "method": "list_children", "params": { "path": root.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    let names: Vec<&str> = reply["data"]["children"]
        .as_array()
        .expect("children 배열")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert_eq!(names, vec!["Zebra", "apple.txt", "Banana.txt"], "{reply}");
    // meta 를 안 물으면 수정시각은 실리지 않는다(stat 회피 — 앱과 같은 기본값).
    assert!(reply["data"]["children"][0]["modified"].is_null(), "{reply}");
}

/// meta 를 물으면 수정시각이 함께 온다.
#[test]
fn asking_for_meta_carries_the_modified_time() {
    let helper = spawn_helper("fs-list-meta");
    let root = helper.dir().join("tree");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "a").unwrap();

    let reply = helper.ask(json!({
        "id": 37, "method": "list_children",
        "params": { "path": root.to_string_lossy(), "meta": true }
    }));
    assert!(
        reply["data"]["children"][0]["modified"].as_u64().is_some_and(|t| t > 0),
        "{reply}"
    );
}

/// 경로를 안 주면 **사용자 홈**이다 — 정체성 홈이 아니다. UI 의 파일 트리가 이 기본값으로 뜬다.
#[test]
fn an_omitted_path_lists_the_boot_user_home() {
    let helper = spawn_helper("fs-list-default");
    std::fs::write(helper.user_home().join("marker.txt"), "x").unwrap();
    // 정체성 홈에도 다른 이름을 둔다 — 둘을 헷갈리면 이 검사가 잡는다.
    std::fs::write(helper.home().join("wrong.txt"), "x").unwrap();

    let reply = helper.ask(json!({ "id": 38, "method": "list_children" }));
    assert_eq!(reply["ok"], true, "{reply}");
    let names: Vec<&str> = reply["data"]["children"]
        .as_array()
        .expect("children 배열")
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert_eq!(names, vec!["marker.txt"], "사용자 홈을 훑어야 한다: {reply}");
}

/// 선행 `~` 는 부팅 때 받은 사용자 홈으로 푼다.
#[test]
fn a_tilde_path_expands_to_the_boot_user_home() {
    let helper = spawn_helper("fs-tilde");
    std::fs::write(helper.user_home().join("rc.txt"), "hello").unwrap();

    let reply = helper.ask(json!({
        "id": 39, "method": "read_text_file", "params": { "path": "~/rc.txt" }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["content"], "hello", "{reply}");
}

/// 사용자 홈을 못 받았으면 **추측하지 않는다**. 자기 환경의 HOME 을 읽거나 정체성 홈의 부모를
/// 짚으면 앱과 다른 트리를 훑고, 그 오답은 오류가 아니라 "다른 파일 목록"으로 나타난다.
#[test]
fn without_a_user_home_a_home_relative_call_fails_by_name() {
    let dir = fixture_dir("fs-no-user-home");
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let mut ready = String::new();
    let stdout = child.stdout.take().unwrap();
    assert!(
        matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0),
        "사용자 홈이 없어도 서빙은 시작한다 — 홈에 안 걸린 명령은 여전히 답한다"
    );
    let helper = Helper { child, socket };

    let reply = helper.ask(json!({ "method": "list_children" }));
    assert_eq!(reply["ok"], false, "홈을 추측했다: {reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("--user-home"),
        "무엇을 주면 되는지 말해야 한다: {reply}"
    );

    // 절대경로는 홈이 필요 없다 — 못 하는 것 하나가 나머지를 막지 않는다.
    let f = dir.join("plain.txt");
    std::fs::write(&f, "ok").unwrap();
    let read = helper.ask(json!({
        "method": "read_text_file", "params": { "path": f.to_string_lossy() }
    }));
    assert_eq!(read["ok"], true, "절대경로까지 막았다: {read}");
}

/// 프로젝트 폴더는 **정체성 홈** 아래 만들어진다 — 앱이 만든 폴더는 앱 관리 영역에 산다.
#[test]
fn a_project_dir_is_made_under_the_identity_home() {
    let helper = spawn_helper("fs-project-dir");
    let reply = helper.ask(json!({
        "id": 40, "method": "ensure_project_dir", "params": { "folder": "my-app" }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    let made = helper.home().join("projects").join("my-app");
    assert_eq!(reply["data"], made.to_string_lossy().to_string(), "{reply}");
    assert!(made.is_dir(), "실제로 만들어져야 한다: {made:?}");
}

/// 폴더명 계약은 앱의 계약이다 — cored 에서만 통과하는 이름이 있으면 안 된다.
#[test]
fn the_project_folder_rule_is_the_apps_rule() {
    let helper = spawn_helper("fs-project-slug");
    for bad in ["../etc", "My App", "-lead", ""] {
        let reply = helper.ask(json!({
            "method": "ensure_project_dir", "params": { "folder": bad }
        }));
        assert_eq!(reply["ok"], false, "{bad:?} 를 통과시켰다: {reply}");
        // 이름을 몰라서 실패한 것과 규칙이 거부한 것은 다른 사실이다 — 안 서빙해도
        // ok:false 라, 코드를 안 보면 이 검사가 통과로 위장한다.
        assert_eq!(reply["code"], "COMMAND_FAILED", "규칙이 아니라 부재가 막았다: {reply}");
    }
}

/// 프로젝트 루트 판정 — 사용자 홈 자신은 안 된다. 그 판정의 기준이 부팅 때 받은 홈이다.
#[test]
fn the_boot_user_home_is_not_a_project_root() {
    let helper = spawn_helper("fs-project-root");
    let refused = helper.ask(json!({
        "id": 41, "method": "validate_project_root",
        "params": { "path": helper.user_home().to_string_lossy() }
    }));
    assert_eq!(refused["ok"], false, "{refused}");

    let work = helper.user_home().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let ok = helper.ask(json!({
        "id": 42, "method": "validate_project_root",
        "params": { "path": work.to_string_lossy() }
    }));
    assert_eq!(ok["ok"], true, "{ok}");
    // 정규화된 경로를 돌려준다 — 중복 비교의 기준이다.
    assert_eq!(
        ok["data"],
        work.canonicalize().unwrap().to_string_lossy().to_string(),
        "{ok}"
    );
}
