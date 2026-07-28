//! 헬퍼를 실제로 띄워 소켓으로 묻고 답을 받는다 — 이 갈래의 GREEN.
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

/// 살아 있는 헬퍼 — 드롭될 때 프로세스를 거둔다(테스트가 실패해도 고아를 남기지 않는다).
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
    /// 이 헬퍼의 픽스처 루트(소켓이 사는 디렉터리).
    fn dir(&self) -> &std::path::Path {
        self.socket.parent().expect("소켓의 부모")
    }

    /// 한 줄 요청 → 한 줄 응답. 연결은 요청마다 새로 연다(NDJSON 요청/응답의 최소 단위).
    fn ask(&self, req: Value) -> Value {
        let conn = UnixStream::connect(&self.socket).expect("헬퍼 소켓 연결");
        conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut writer = conn.try_clone().unwrap();
        writeln!(writer, "{req}").expect("요청 쓰기");
        writer.flush().unwrap();
        let mut line = String::new();
        BufReader::new(conn).read_line(&mut line).expect("응답 읽기");
        assert!(!line.trim().is_empty(), "빈 응답 — 헬퍼가 답하지 않았다");
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
    let dir = PathBuf::from(home).join(".soksak-helper-test").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("픽스처 루트 생성");
    dir
}

/// 헬퍼를 띄우고 준비 완료 줄을 기다린다.
fn spawn_helper(name: &str) -> Helper {
    let dir = fixture_dir(name);
    let socket = dir.join("h.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-helper"))
        .arg("--socket")
        .arg(&socket)
        .stdout(Stdio::piped())
        .spawn()
        .expect("헬퍼 스폰");
    // 준비 완료 = stdout 한 줄. 블로킹 read 라 폴링이 없고, 헬퍼가 죽으면 EOF 로 즉시 드러난다.
    let mut ready = String::new();
    let stdout = child.stdout.take().expect("stdout 파이프");
    let read = BufReader::new(stdout).read_line(&mut ready);
    assert!(
        matches!(read, Ok(n) if n > 0),
        "헬퍼가 준비 완료를 알리지 않고 죽었다: {read:?}"
    );
    assert!(
        ready.contains(&socket.to_string_lossy().to_string()),
        "준비 완료 줄이 소켓 경로를 말해야 한다: {ready}"
    );
    Helper { child, socket }
}

// ── 살아 있는 프로세스가 실제로 명령을 서빙한다 ──────────────────────────────────

// binary_integrity 는 디스크만 만지는 순수 관찰이다. 실재하는 파일을 두고 물으면
// present 가 나와야 한다 — 헬퍼가 soksak-core 을 실제로 부르고 있다는 증거.
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

// UDP 는 디스크가 아니라 실제 소켓을 쓴다 — 헬퍼 프로세스가 진짜로 패킷을 보내는지.
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
    let (n, _) = recv.recv_from(&mut buf).expect("헬퍼가 보낸 패킷 수신");
    assert_eq!(&buf[..n], &[9u8, 8, 7], "헬퍼 프로세스가 실제로 보냈다");
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
    let reply = helper.ask(json!({ "id": 4, "method": "helper.commands" }));
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
    assert_eq!(reply["role"], "helper", "무엇이 답했는지 말한다: {reply}");
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
        let out = Command::new(env!("CARGO_BIN_EXE_soksak-helper"))
            .arg(flag)
            .output()
            .expect("헬퍼 실행");
        assert!(out.status.success(), "{flag} 는 성공해야 한다: {out:?}");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("soksak-helper"), "{flag} 출력: {text}");
    }
}

// 유닉스 소켓 경로에는 OS 상한이 있다(macOS ~104 바이트). 깊은 트리에서 조용히 넘기는데,
// OS 가 주는 "path must be shorter than SUN_LEN" 만으로는 얼마나 긴지 알 수 없다 — 실제
// 길이를 말해야 부르는 쪽이 고칠 수 있다. (이 테스트 자신이 그 함정에 먼저 빠졌다.)
#[test]
fn an_overlong_socket_path_says_how_long_it_was() {
    let dir = fixture_dir("overlong");
    let socket = dir.join("x".repeat(200)).with_extension("sock");
    let out = Command::new(env!("CARGO_BIN_EXE_soksak-helper"))
        .arg("--socket")
        .arg(&socket)
        .output()
        .expect("헬퍼 실행");
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
    let out = Command::new(env!("CARGO_BIN_EXE_soksak-helper"))
        .output()
        .expect("헬퍼 실행");
    assert!(!out.status.success(), "소켓 경로 없이 성공하면 안 된다: {out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("--socket"), "무엇이 없는지 말해야 한다: {err}");
}
