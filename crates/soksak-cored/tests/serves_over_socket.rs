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
    /// 스폰한 자식을 **즉시** 감싸고 나서 준비를 기다린다.
    ///
    /// spawn 과 Helper 생성 사이에 패닉이 나면 `Child` 가 그대로 샌다 — Rust 의 `Child::drop`
    /// 은 프로세스를 죽이지 않는다(실측: 이 세션의 테스트 반복으로 cored 20개가 남았다).
    /// 그 창을 없애려면 소유권을 먼저 넘기고 검사는 그 뒤에 해야 한다.
    fn adopt(mut child: std::process::Child, socket: std::path::PathBuf) -> Helper {
        let stdout = child.stdout.take().expect("stdout 파이프");
        let helper = Helper { child, socket };
        let mut ready = String::new();
        assert!(
            matches!(BufReader::new(stdout).read_line(&mut ready), Ok(n) if n > 0),
            "cored 가 준비 완료를 알리지 않고 죽었다"
        );
        helper
    }

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
    // 설치본 픽스처는 앱과 같은 잠금(`chmod -R a-w`)을 걸고, 잠긴 트리는 remove_dir_all 이
    // 막는다 — 앞선 실패가 남긴 트리를 못 지우면 다음 실행은 옛 상태 위에서 답한다.
    if dir.exists() {
        let _ = std::process::Command::new("chmod")
            .arg("-R")
            .arg("u+w")
            .arg(&dir)
            .output();
        std::fs::remove_dir_all(&dir).expect("앞선 실행이 남긴 픽스처 제거");
    }
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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
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
    Helper::adopt(child, socket)
}

// ── 살아 있는 프로세스가 실제로 명령을 서빙한다 ──────────────────────────────────

// binary_integrity 는 디스크만 만지는 순수 관찰이다. 실재하는 파일을 두고 물으면
// present 가 나와야 한다 — cored 가 soksak-core 을 실제로 부르고 있다는 증거.
#[test]
fn serves_a_core_command_over_the_socket() {
    let helper = spawn_helper("serves-core");
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
    // 창이 안 붙었으면 "없는 명령"이 아니라 **붙을 창이 없다**가 사실이다 — 이 프로세스는
    // 창의 카탈로그를 모르므로 없다고 판정할 자격이 없고, 두 사실을 같은 코드로 답하면 부른
    // 쪽이 재시도할 이유를 못 찾는다.
    assert_eq!(reply["code"], "NO_HOST", "응답: {reply}");
    assert!(
        reply["message"]
            .as_str()
            .unwrap_or_default()
            .contains("webview_overlay_active"),
        "어느 이름 때문인지 말해야 한다: {reply}"
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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
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
    let helper = Helper::adopt(child, socket);

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

// 감사해서 서빙하지 않기로 한 이름은 목록에 사유와 함께 있어야 한다. 프레임워크 저자는 이 프로세스에
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
    // 감사한 open 이름 전부. 하나라도 빠지면 그 이름은 표에 없는 침묵이 되어, 부른 쪽이
    // UNKNOWN_COMMAND 를 받는다 — "아직 안 옮겼다"와 "여기서는 못 한다"가 구분되지 않는다.
    for expected in [
        "sidecar_ensure",
        "project_owners",
        "media_proxy_info",
        "app_relaunch",
        "sidecar_ensure",
        "clipboard_read",
        "media_proxy_info",
        "plugin_install_git",
        "plugin_update",
        "app_relaunch",
    ] {
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

    // 두 벌을 본다 — 한 이름만 보면 그 항목만 배선되고 나머지는 목록에만 있는 채로 통과한다.
    for (id, name) in [(10, "app_relaunch"), (11, "clipboard_read")] {
        let declared = table["data"]["unserved"]
            .as_array()
            .and_then(|u| u.iter().find(|e| e["name"] == name))
            .and_then(|e| e["blockedBy"].as_str())
            .unwrap_or_else(|| panic!("{name} 의 사유 선언이 없다: {table}"))
            .to_string();
        assert!(!declared.is_empty(), "{name} 의 사유가 비었다: {table}");

        let reply = helper.ask(json!({ "id": id, "method": name, "params": {} }));
        // ok:false 만 보면 "표에 없어서 모른다"가 "감사해서 거절했다"로 위장한다 — code 까지 본다.
        // 그리고 그 둘은 **다른 코드**여야 한다: 원장이 코드를 기록하므로 같으면 한 통에 섞인다.
        assert_eq!(reply["ok"], false, "응답: {reply}");
        assert_eq!(reply["code"], "REFUSED_BY_AUDIT", "응답: {reply}");
        let msg = reply["message"].as_str().unwrap_or_default();
        assert!(msg.contains(name), "거절이 이름을 말하지 않는다: {reply}");
        assert!(msg.contains(&declared), "선언한 사유가 응답에 없다: {reply}");
    }
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

// cored 는 적재분을 답에 실어 준다 — 창은 프레임워크의 것이므로 부채질은 그 항목을 받은 프레임워크가 한다.
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
    // data 는 앱의 invoke 가 돌려주는 값 그대로다 — 프레임워크가 값을 다시 조립하지 않는다.
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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let helper = Helper::adopt(child, socket);

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

/// **덮어써도 지워도 직전 값이 남는다.** 저장소 주인이 이 프로세스이므로, 여기서 안 남기면
/// 아무 데도 안 남는다.
///
/// RED 근거(실측 2026-08-01): 이 프로세스의 kv 어댑터가 자기 UPSERT 를 직접 돌아, 형제
/// 프로세스가 남기던 과거를 통째로 지나쳤다. 같은 사실이 두 자리에 있으면 한쪽만 고쳐지고,
/// 그 어긋남은 오류가 아니라 "되돌릴 자리가 없다"로 나타난다.
#[test]
fn an_overwrite_keeps_the_previous_value() {
    let helper = spawn_helper("kv-past");
    kv_store(&helper);
    for v in [1, 2, 3] {
        let r = helper.ask(json!({
            "method": "data_kv_set", "params": { "ns": "core", "key": "w", "value": v }
        }));
        assert_eq!(r["ok"], true, "{r}");
    }
    let past = helper.ask(json!({
        "method": "data_kv_history", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(past["ok"], true, "{past}");
    assert_eq!(past["data"][0], 2, "최신 직전 값이 앞에 와야 한다: {past}");
    assert_eq!(past["data"][1], 1, "{past}");
}

/// 지운 값도 되돌릴 자리가 있어야 한다 — 지운 쪽은 그 값을 다시 만들어 낼 수 없다.
#[test]
fn a_delete_keeps_the_previous_value() {
    let helper = spawn_helper("kv-past-delete");
    kv_store(&helper);
    helper.ask(json!({
        "method": "data_kv_set", "params": { "ns": "core", "key": "w", "value": { "projects": [1] } }
    }));
    let del = helper.ask(json!({
        "method": "data_kv_delete", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(del["ok"], true, "{del}");
    let past = helper.ask(json!({
        "method": "data_kv_history", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(past["data"][0]["projects"][0], 1, "{past}");
}

/// 되돌리기가 실제로 값을 되돌리고, **되돌린 것도 되돌릴 수 있어야** 한다. 왕복이 아니면
/// 잘못 되돌렸을 때 돌아올 자리가 없다.
#[test]
fn undo_restores_and_can_itself_be_undone() {
    let helper = spawn_helper("kv-undo");
    kv_store(&helper);
    for v in [1, 2] {
        helper.ask(json!({
            "method": "data_kv_set", "params": { "ns": "core", "key": "w", "value": v }
        }));
    }
    let undone = helper.ask(json!({
        "method": "data_kv_undo", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(undone["data"], true, "{undone}");
    let now = helper.ask(json!({
        "method": "data_kv_get", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(now["data"], 1, "되돌아가지 않았다: {now}");
    let past = helper.ask(json!({
        "method": "data_kv_history", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(past["data"][0], 2, "되돌리기가 직전 값을 안 남겼다: {past}");
}

/// 되돌릴 것이 없으면 그렇게 말한다 — 조용히 성공하면 부른 쪽은 되돌아간 줄 안다.
#[test]
fn undo_without_a_past_says_so() {
    let helper = spawn_helper("kv-undo-empty");
    kv_store(&helper);
    helper.ask(json!({
        "method": "data_kv_set", "params": { "ns": "core", "key": "w", "value": 1 }
    }));
    let r = helper.ask(json!({
        "method": "data_kv_undo", "params": { "ns": "core", "key": "w" }
    }));
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["data"], false, "{r}");
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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let helper = Helper::adopt(child, socket);

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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .arg("--login-shell").arg(&shell)
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    (Helper::adopt(child, socket), shell)
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

// ── 파일 읽기·쓰기 — 디스크는 프레임워크가 아니다 ────────────────────────────
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
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let helper = Helper::adopt(child, socket);

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

// ── 조회·프로브 ──────────────────────────────────────────────────────────────

/// AI 세션은 identity 홈이 아니라 **사용자 홈** 아래 산다. 그 홈은 부팅 인자로 온다 —
/// cored 가 자기 환경의 HOME 을 읽으면 이 테스트 프로세스의 홈을 답하게 되고, 그 오답은
/// "세션 없음"으로 조용히 나타난다.
///
/// 정체성 홈의 부모로 파생하지도 않는다. 그 관계는 배포 배치에서만 참이라, 여기처럼 홈과
/// 사용자 홈이 나란히 있는 배치에서는 엉뚱한 곳을 가리킨다 — 그래서 **받은 값 그대로**를
/// 단언한다.
#[test]
fn a_session_path_comes_from_the_boot_home_not_this_environment() {
    let helper = spawn_helper("ai-session-dir");
    let reply = helper.ask(json!({
        "id": 30, "method": "ai_session_dir", "params": { "cwd": "/workspace/proj" }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(
        reply["data"],
        helper
            .user_home()
            .join(".claude/projects/-workspace-proj")
            .to_string_lossy()
            .to_string(),
        "부팅 인자로 받은 사용자 홈 아래를 가리켜야 한다: {reply}"
    );
    // 환경의 HOME 을 읽었다면 이 테스트 프로세스의 홈이 나온다 — 그것과 다름을 못박는다.
    let ambient = std::env::var("HOME").expect("HOME");
    assert!(
        !reply["data"].as_str().unwrap_or_default().starts_with(&format!("{ambient}/.claude")),
        "환경의 HOME 을 읽었다: {reply}"
    );
}

/// 빈 cwd 는 "어느 프로젝트인가"가 없는 질문이다 — 홈을 해소하기 전에 거절한다.
#[test]
fn an_empty_cwd_is_refused_before_any_home_is_resolved() {
    let helper = spawn_helper("ai-session-empty");
    let reply = helper.ask(json!({ "method": "ai_session_dir", "params": { "cwd": "" } }));
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["message"].as_str().unwrap_or_default().contains("cwd"), "{reply}");
}

/// 탐색도 같은 축이다 — 그 홈에 실제로 있는 세션을 프로세스를 건너 찾아낸다.
#[test]
fn a_session_is_found_under_the_boot_home() {
    let helper = spawn_helper("ai-session-find");
    // 세션은 **받은** 사용자 홈 아래 둔다 — 파생이 아니라 부팅 인자가 답을 정한다.
    let dir = helper.user_home().join(".claude/projects/-w");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("accd937f-5c22-48c6-b83d-70a2e0f2e4aa.jsonl"),
        "{\"sessionId\":\"accd937f-5c22-48c6-b83d-70a2e0f2e4aa\",\"cwd\":\"/w\"}\n",
    )
    .unwrap();

    let reply = helper.ask(json!({
        "id": 31, "method": "ai_session_find", "params": { "cwd": "/w" }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    // 필드 표기는 앱의 invoke 가 주는 것 그대로다(SessionInfo 의 serde) — 프레임워크가 다시
    // 조립하지 않도록 여기서 이름을 바꾸지 않는다.
    assert_eq!(reply["data"]["session_id"], "accd937f-5c22-48c6-b83d-70a2e0f2e4aa", "{reply}");
    assert_eq!(reply["data"]["cwd"], "/w", "{reply}");
    assert_eq!(reply["data"]["kind"], "claude", "{reply}");

    // 없는 cwd 는 "없음"이지 오류가 아니다.
    let none = helper.ask(json!({
        "method": "ai_session_find", "params": { "cwd": "/nowhere-xyz" }
    }));
    assert_eq!(none["ok"], true, "{none}");
    assert!(none["data"].is_null(), "{none}");
}

/// 경로 가드는 프로세스를 건너서도 살아 있어야 한다. 이 핸들러가 프레임워크 밖으로 나온 지금
/// 이것이 유일한 게이트다 — 새면 임의 파일 읽기 프리미티브가 소켓에 열린다.
#[test]
fn inspect_refuses_anything_outside_a_session_directory() {
    let helper = spawn_helper("ai-session-inspect");
    let secret = helper.dir().join("secret.txt");
    std::fs::write(&secret, b"TOP-SECRET").unwrap();

    // ① 세션 디렉터리가 아닌 경로.
    let plain = helper.ask(json!({
        "method": "ai_session_inspect", "params": { "path": secret.to_string_lossy() }
    }));
    assert_eq!(plain["ok"], false, "임의 파일을 읽었다: {plain}");

    // ② 세션 디렉터리 이름을 파일명에 심은 미끼 — 부분문자열 판정이면 통과한다.
    let decoy = helper.dir().join("x .claude_projects_ y.jsonl");
    std::fs::write(&decoy, b"TOP-SECRET").unwrap();
    let baited = helper.ask(json!({
        "method": "ai_session_inspect", "params": { "path": decoy.to_string_lossy() }
    }));
    assert_eq!(baited["ok"], false, "미끼 파일명이 통과했다: {baited}");

    // ③ 세션 디렉터리를 지난 뒤 '..' 로 빠져나간다.
    let deep = helper.dir().join(".claude").join("projects");
    std::fs::create_dir_all(&deep).unwrap();
    let escape = deep.join("..").join("..").join("secret.txt");
    let escaped = helper.ask(json!({
        "method": "ai_session_inspect", "params": { "path": escape.to_string_lossy() }
    }));
    assert_eq!(escaped["ok"], false, "'..' 탈출이 통과했다: {escaped}");

    // 진짜 세션 파일은 계속 읽힌다 — 가드가 기능을 죽이면 그것도 결함이다.
    let real = deep.join("s.jsonl");
    std::fs::write(
        &real,
        "{\"sessionId\":\"019d09a1-6bc4-7691-9458-088bde7fca3d\",\"cwd\":\"/tmp\"}\n",
    )
    .unwrap();
    let ok = helper.ask(json!({
        "method": "ai_session_inspect", "params": { "path": real.to_string_lossy() }
    }));
    assert_eq!(ok["ok"], true, "{ok}");
    assert_eq!(ok["data"]["session_id"], "019d09a1-6bc4-7691-9458-088bde7fca3d", "{ok}");
}

/// 부재도 답이다 — 실행조차 못 한 것을 명령 실패로 올리면 호출자는 "의존성이 없다"와
/// "물어보지 못했다"를 구분할 수 없다. 그 둘의 처리는 다르다.
#[test]
fn an_absent_binary_is_an_answer_not_a_failure() {
    let helper = spawn_helper("probe-absent");
    let reply = helper.ask(json!({
        "id": 32, "method": "probe_binary",
        "params": { "bin": "definitely-no-such-bin-xyz", "args": [] }
    }));
    assert_eq!(reply["ok"], true, "관찰 자체는 실패하지 않는다: {reply}");
    assert_eq!(reply["data"]["ok"], false, "{reply}");
    assert_eq!(reply["data"]["stdout"], "", "{reply}");
}

/// 호스트 타깃은 이름을 지어내지 않는다 — 표에 있는 트리플만 답한다.
#[test]
fn the_host_target_is_one_of_the_declared_triples() {
    let helper = spawn_helper("host-target");
    let reply = helper.ask(json!({ "id": 33, "method": "host_unit_target" }));
    assert_eq!(reply["ok"], true, "{reply}");
    let triple = reply["data"].as_str().unwrap_or_default();
    assert!(
        [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
        ]
        .contains(&triple),
        "지어낸 트리플: {reply}"
    );
}

/// 제어 소켓 **자리**는 identity 가 정한다 — 부팅 때 받은 홈과 identifier 둘 다에서 나온다.
#[test]
fn the_control_socket_seat_comes_from_the_boot_identity() {
    let helper = spawn_helper("socket-seat");
    let reply = helper.ask(json!({ "id": 34, "method": "ipc_socket_path" }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(
        reply["data"],
        helper.home().join("com.soksak.dev.sock").to_string_lossy().to_string(),
        "{reply}"
    );
    // cored 자신의 소켓이 아니다 — 자기가 서빙하는 자리를 답하면 오케스트레이터가 cored 를
    // 제어 평면으로 착각한다.
    assert_ne!(
        reply["data"].as_str().unwrap_or_default(),
        helper.socket.to_string_lossy().to_string(),
        "자기 소켓을 답했다: {reply}"
    );
}

/// 짝 CLI 자리는 "찾았거나 못 찾았거나"다 — 못 찾은 것을 빈 문자열이나 그럴듯한 경로로
/// 채우면 그 경로가 PATH 앞에 붙어 엉뚱한 바이너리를 실행한다.
#[test]
fn the_cli_dir_is_either_a_directory_holding_sok_or_nothing() {
    let helper = spawn_helper("cli-dir");
    let reply = helper.ask(json!({ "id": 35, "method": "ipc_cli_dir" }));
    assert_eq!(reply["ok"], true, "{reply}");
    match reply["data"].as_str() {
        None => assert!(reply["data"].is_null(), "찾지 못한 것은 null 이다: {reply}"),
        Some(dir) => assert!(
            std::path::Path::new(dir).join("sok").is_file(),
            "sok 이 없는 디렉터리를 답했다: {reply}"
        ),
    }
}

/// probe_binary 는 셸을 거치지 않는다(bin 을 직접 실행한다) — 부팅 상태도 필요 없다.
/// 그래서 이것은 인자만으로 서는 명령이고, 두 프로세스에서 같은 답이 나온다.
///
/// 같은 계열의 shell_which·npm_global_dirs 는 로그인 셸을 거쳐야 답이 나온다 — 그 값이
/// --login-shell 로 오면서 둘도 서빙된다(serves_shell_which_by_asking_the_shell_it_was_given).
#[test]
fn serves_probe_binary_over_the_socket() {
    let helper = spawn_helper("probe-binary");

    let works = helper.ask(json!({
        "method": "probe_binary", "params": { "bin": "echo", "args": ["hello"] }
    }));
    assert_eq!(works["ok"], true, "응답: {works}");
    assert_eq!(works["data"]["ok"], true, "{works}");
    assert!(
        works["data"]["stdout"].as_str().unwrap_or_default().contains("hello"),
        "stdout 을 그대로 실어야 한다(TS 가 버전을 뽑는다): {works}"
    );

    // 존재하나 실패: present != working. 이 구분이 이 명령의 존재 이유다.
    let fails = helper.ask(json!({
        "method": "probe_binary", "params": { "bin": "false", "args": [] }
    }));
    assert_eq!(fails["ok"], true, "관찰 자체는 성공한다: {fails}");
    assert_eq!(fails["data"]["ok"], false, "{fails}");
}

// ── 개발 유닛 선언 읽기 ──────────────────────────────────────────────────────
//
// 읽기 검증은 부팅 상태(홈·정체성)만 있으면 선다 — 쓰기(unit_dev_set/remove)와 달리 공유
// config 를 갈아끼우지 않으므로 두 번째 쓰기 프로세스 문제가 없다.

#[test]
fn serves_unit_dev_list_from_the_boot_home() {
    let helper = spawn_helper("unit-dev-list");
    let cfg = helper.home().join("config");
    std::fs::create_dir_all(&cfg).unwrap();
    let src = helper.dir().join("a-plugin");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        cfg.join("development-units.json"),
        format!(
            r#"{{"version":1,"units":[{{"kind":"plugin","id":"a","source":"{}"}}]}}"#,
            src.to_string_lossy()
        ),
    )
    .unwrap();

    let reply = helper.ask(json!({ "method": "unit_dev_list", "params": {} }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"][0]["id"], "a", "{reply}");
    assert_eq!(reply["data"][0]["kind"], "plugin", "{reply}");
}

/// 앱과 같은 엄격함으로 읽는다. 느슨하면 같은 config 를 앱은 거부하고 이 프로세스는
/// 통과시키고, 그 차이는 오류가 아니라 **한쪽에서만 보이는 유닛**으로 나타난다.
#[test]
fn a_malformed_declaration_is_refused_the_same_way() {
    let helper = spawn_helper("unit-dev-bad");
    let cfg = helper.home().join("config");
    std::fs::create_dir_all(&cfg).unwrap();
    std::fs::write(
        cfg.join("development-units.json"),
        r#"{"version":1,"units":[{"kind":"plugin","id":"a","source":"relative/path"}]}"#,
    )
    .unwrap();

    let reply = helper.ask(json!({ "method": "unit_dev_list", "params": {} }));
    assert_eq!(reply["ok"], false, "상대경로 소스를 통과시켰다: {reply}");
    // UNKNOWN_COMMAND 도 ok:false 다 — 코드를 함께 보지 않으면 미서빙이 통과로 위장한다.
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("절대경로"),
        "{reply}"
    );
}

#[test]
fn serves_unit_dev_validate_path() {
    let helper = spawn_helper("unit-dev-validate");
    let good = helper.dir().join("real-src");
    std::fs::create_dir_all(&good).unwrap();

    let ok = helper.ask(json!({
        "method": "unit_dev_validate_path", "params": { "source": good.to_string_lossy() }
    }));
    assert_eq!(ok["ok"], true, "{ok}");

    // 없는 디렉터리는 거부다 — 선언은 되지만 검증은 실체를 본다.
    let missing = helper.ask(json!({
        "method": "unit_dev_validate_path",
        "params": { "source": helper.dir().join("nope").to_string_lossy() }
    }));
    assert_eq!(missing["ok"], false, "{missing}");

    let relative = helper.ask(json!({
        "method": "unit_dev_validate_path", "params": { "source": "rel/path" }
    }));
    assert_eq!(relative["ok"], false, "{relative}");
}

// ── 활동은 적재만이 아니라 남는다 ────────────────────────────────────────────
//
// 실측(2026-07-28, Electron 라이브): activity_publish 가 24회 성공했는데 저장소의 records 가
// 비어 있었다. cored 는 seq 만 매기고 쓰지 않았다 — 앱은 admit 다음에 persist 까지 한다.
//
// 그 절반이 없으면 답은 성공으로 나가고 원장은 남지 않는다. 그리고 그 부재는 오류가 아니라
// **다음 부팅에서 아무 일도 없었던 것**으로 나타난다: 활동 피드가 비고, 재개 지점이 0 이 되어
// 새 원장이 조용히 시작된다.
#[test]
fn an_admitted_entry_is_actually_stored() {
    let helper = spawn_helper("activity-persist");

    let first = helper.ask(json!({
        "method": "activity_publish",
        "params": { "kind": "boot.step", "source": "boot", "payload": { "step": "enter" } }
    }));
    assert_eq!(first["ok"], true, "{first}");
    let seq = first["data"]["seq"].as_u64().expect("seq");

    // 같은 프로세스에서 다시 물어 확인하는 것으로는 부족하다(링만 보고 답할 수 있다).
    // 저장소를 직접 연다 — 남았는가는 파일의 사실이다.
    let db = helper.dir().join("home").join("data").join("soksak.db");
    let conn = rusqlite::Connection::open(&db).expect("저장소");
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM records WHERE ns='core' AND coll='activity'",
            [],
            |r| r.get(0),
        )
        .expect("세기");
    assert_eq!(n, 1, "적재는 됐는데 남지 않았다");

    let doc: String = conn
        .query_row(
            "SELECT doc FROM records WHERE ns='core' AND coll='activity'",
            [],
            |r| r.get(0),
        )
        .expect("읽기");
    let v: serde_json::Value = serde_json::from_str(&doc).expect("json");
    assert_eq!(v["seq"].as_u64(), Some(seq), "도장 찍힌 항목 그대로여야 한다");
    assert_eq!(v["kind"], "boot.step");

    // 재개 지점이 저장소에서 온다 — 남지 않으면 다음 프로세스가 0 부터 매긴다.
    let second = helper.ask(json!({
        "method": "activity_publish",
        "params": { "kind": "boot.step", "source": "boot", "payload": { "step": "done" } }
    }));
    assert_eq!(second["data"]["seq"].as_u64(), Some(seq + 1), "{second}");
}

/// 미디어 base64 는 남기지 않는다 — 원장은 관찰 요약이지 사본이 아니다.
#[test]
fn a_stored_entry_is_a_summary_not_a_copy() {
    let helper = spawn_helper("activity-summary");
    helper.ask(json!({
        "method": "activity_publish",
        "params": { "kind": "k", "source": "core",
                    "payload": { "media": { "base64": "AAAA", "mime": "image/png" } } }
    }));
    let db = helper.dir().join("home").join("data").join("soksak.db");
    let conn = rusqlite::Connection::open(&db).expect("저장소");
    let doc: String = conn
        .query_row("SELECT doc FROM records WHERE coll='activity'", [], |r| r.get(0))
        .expect("읽기");
    assert!(!doc.contains("AAAA"), "base64 가 그대로 남았다: {doc}");
    assert!(doc.contains("image/png"), "kind 는 남아야 한다: {doc}");
}

// ── 플러그인 전용 저장소 · 제거 ──────────────────────────────────────────────
//
// 자리는 <홈>/plugins-data/<id>/<key>.json 이다. 앱이 그 문자열을 직접 적고 cored 가 또 적으면
// 한쪽만 고쳐질 수 있고, 그 어긋남은 오류가 아니라 **빈 목록**으로 나타난다(없는 곳을 훑고
// "저장된 게 없다"고 답한다). 그래서 자리도 검증 문자셋도 코어 한 벌이라야 한다.

/// 쓴 원문이 파싱 없이 그대로 돌아오고, 목록은 확장자를 뗀 이름을 사전순으로 답한다.
/// 값은 JSON 문자열이지만 이 명령은 그것을 해석하지 않는다 — 해석하면 저장한 것과 돌려받는
/// 것이 달라지고(키 순서·수 표기), 그 차이는 저장소를 쓰는 플러그인에게만 보인다.
#[test]
fn plugin_data_round_trips_the_stored_text_verbatim() {
    let helper = spawn_helper("plugin-data-roundtrip");
    let raw = r#"{"b":1,"a":[2,3],"note":"한글 그대로"}"#;

    let wrote = helper.ask(json!({
        "method": "plugin_data_write",
        "params": { "id": "memo", "key": "notes", "value": raw }
    }));
    assert_eq!(wrote["ok"], true, "{wrote}");

    let read = helper.ask(json!({
        "method": "plugin_data_read", "params": { "id": "memo", "key": "notes" }
    }));
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(read["data"], raw, "원문이 그대로 돌아와야 한다: {read}");

    // 쓰기가 상위 디렉터리까지 만든다 — 부팅이 만들어 두는 것에 기대지 않는다.
    assert!(
        helper.home().join("plugins-data").join("memo").join("notes.json").is_file(),
        "쓰기가 <홈>/plugins-data/<id>/<key>.json 에 남지 않았다"
    );

    helper.ask(json!({
        "method": "plugin_data_write",
        "params": { "id": "memo", "key": "config", "value": "{}" }
    }));
    let listed = helper.ask(json!({ "method": "plugin_data_list", "params": { "id": "memo" } }));
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(
        listed["data"],
        json!(["config", "notes"]),
        "확장자를 뗀 이름이 사전순으로 와야 한다: {listed}"
    );
}

/// 부재는 값이지 실패가 아니다 — 그리고 **읽기 명령이 디스크를 만들지 않는다**.
/// 앱은 스캔 전에 자기 홈 배치를 만들어 두지만 cored 는 남의 홈을 읽을 뿐이라 그 부작용을
/// 지지 않는다. 만들어 버리면 "한 번도 저장한 적 없는 홈"이 저장한 적 있는 홈과 같아진다.
#[test]
fn plugin_data_answers_absence_without_touching_the_disk() {
    let helper = spawn_helper("plugin-data-absent");

    let read = helper.ask(json!({
        "method": "plugin_data_read", "params": { "id": "memo", "key": "nothing" }
    }));
    assert_eq!(read["ok"], true, "부재는 실패가 아니다: {read}");
    assert_eq!(read["data"], Value::Null, "없는 key 는 null: {read}");

    let listed = helper.ask(json!({ "method": "plugin_data_list", "params": { "id": "memo" } }));
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["data"], json!([]), "없는 id 는 빈 목록: {listed}");

    assert!(
        !helper.home().join("plugins-data").exists(),
        "읽기 두 번이 저장소 디렉터리를 만들었다: {}",
        helper.home().join("plugins-data").display()
    );
}

/// 설치본은 읽기전용으로 잠겨 있다 — 잠금을 풀지 않으면 remove_dir_all 이 막힌다.
/// 그리고 전용 저장소는 **남긴다**: 재설치 시 데이터 보존이 이 명령의 결정이다.
#[test]
fn plugin_remove_unlocks_the_tree_and_keeps_the_data() {
    let helper = spawn_helper("plugin-remove");
    let installed = helper.home().join("plugins").join("memo");
    std::fs::create_dir_all(installed.join("src")).unwrap();
    std::fs::write(installed.join("plugin.json"), br#"{"id":"memo"}"#).unwrap();
    std::fs::write(installed.join("src").join("main.js"), b"export default {}").unwrap();
    let data = helper.home().join("plugins-data").join("memo");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("notes.json"), b"{}").unwrap();
    // 앱이 설치 직후 거는 것과 같은 잠금.
    let locked = std::process::Command::new("chmod")
        .arg("-R")
        .arg("a-w")
        .arg(&installed)
        .output()
        .expect("chmod 실행");
    assert!(locked.status.success(), "픽스처를 잠그지 못했다");

    let reply = helper.ask(json!({ "method": "plugin_remove", "params": { "id": "memo" } }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert!(!installed.exists(), "잠긴 트리가 남았다: {}", installed.display());
    assert!(
        data.join("notes.json").is_file(),
        "전용 저장소까지 지웠다 — 재설치 시 데이터 보존 결정을 어겼다"
    );
}

// ── 로그인 셸을 통한 일회 실행과 잔존 회수 ──────────────────────────────────────
//
// 이 둘은 거둘 것·돌릴 것을 **인자와 부팅 상태**가 만들어 준다 — 앱 프로세스의 Child 맵도
// 창도 필요 없다. 그래서 프로세스를 건너도 같은 답이 나온다. 다만 로그인 셸은 값으로 받아야 한다:
// 자기 `$SHELL` 을 읽으면 띄운 쪽과 다른 셸로 돌면서 성공을 답한다.

/// 진짜 셸을 로그인 셸로 준 cored — daemon_run_once 는 그 셸에게 명령을 시킨다.
fn spawn_with_login_shell(name: &str, shell: &str) -> Helper {
    let dir = fixture_dir(name);
    let home = dir.join("home");
    std::fs::create_dir_all(&home).expect("픽스처 홈 생성");
    let socket = dir.join("h.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .arg("--socket").arg(&socket)
        .arg("--home").arg(&home)
        .arg("--identifier").arg("com.soksak.dev")
        .arg("--login-shell").arg(shell)
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    Helper::adopt(child, socket)
}

/// 두 스트림이 **한 링**으로 섞여 온다 — 한쪽만 펌프하면 답은 성공인데 절반이 사라진다.
/// (원본은 stdout·stderr 를 같은 링버퍼에 넣는다. 가르면 그것은 다른 명령이다.)
#[test]
fn daemon_run_once_answers_the_code_and_both_streams() {
    let helper = spawn_with_login_shell("daemon-run-once", "/bin/sh");
    let reply = helper.ask(json!({
        "id": 60,
        "method": "daemon_run_once",
        "params": {
            "root": helper.dir().to_string_lossy(),
            "cmd": "printf 'to-stdout\\n'; printf 'to-stderr\\n' >&2",
            "timeoutSecs": 20,
        },
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["code"], 0, "정상 종료 코드가 그대로 와야 한다: {reply}");
    let lines: Vec<&str> = reply["data"]["lines"]
        .as_array()
        .unwrap_or_else(|| panic!("lines 가 없다: {reply}"))
        .iter()
        .filter_map(|l| l.as_str())
        .collect();
    assert!(lines.contains(&"to-stdout"), "stdout 줄이 없다: {lines:?}");
    assert!(lines.contains(&"to-stderr"), "stderr 줄이 없다: {lines:?}");
}

/// env 는 **자식 환경에만** 간다 — 이 프로세스(cored)에는 남지 않는다.
/// 남으면 다음 호출이 앞 호출의 토큰을 물려받고, 그 물림은 오류가 아니라 성공으로 나타난다.
#[test]
fn daemon_run_once_injects_env_into_the_child_only() {
    let helper = spawn_with_login_shell("daemon-run-once-env", "/bin/sh");
    let root = helper.dir().to_string_lossy().to_string();
    let with_env = helper.ask(json!({
        "id": 61,
        "method": "daemon_run_once",
        "params": {
            "root": root,
            "cmd": "printf '%s\\n' \"[$SOKSAK_SOCKET_TEST_ENV]\"",
            "timeoutSecs": 20,
            "env": { "SOKSAK_SOCKET_TEST_ENV": "injected-marker-xyz" },
        },
    }));
    assert_eq!(with_env["ok"], true, "{with_env}");
    assert_eq!(
        with_env["data"]["lines"],
        json!(["[injected-marker-xyz]"]),
        "주입한 값이 자식에 닿지 않았다: {with_env}"
    );

    let without = helper.ask(json!({
        "id": 62,
        "method": "daemon_run_once",
        "params": {
            "root": root,
            "cmd": "printf '%s\\n' \"[$SOKSAK_SOCKET_TEST_ENV]\"",
            "timeoutSecs": 20,
        },
    }));
    assert_eq!(
        without["data"]["lines"],
        json!(["[]"]),
        "앞 호출의 env 가 cored 프로세스에 남았다: {without}"
    );
}

/// 상한을 넘기면 사유를 달고 실패하고, **자식 트리가 살아남지 않는다**.
/// 손자가 t+2 에 남길 표식이 끝내 없어야 한다 — 본체만 죽이면 손자는 계속 돈다.
#[test]
fn daemon_run_once_kills_the_tree_when_the_timeout_passes() {
    let helper = spawn_with_login_shell("daemon-run-once-timeout", "/bin/sh");
    let marker = helper.dir().join("grandchild-lived");
    // 스스로 끝나는 트리다 — 그룹 킬이 실패해도 4초 뒤엔 아무것도 남지 않는다.
    let cmd = format!("(sleep 2; : > {}) & sleep 4", marker.display());

    let reply = helper.ask(json!({
        "id": 63,
        "method": "daemon_run_once",
        "params": { "root": helper.dir().to_string_lossy(), "cmd": cmd, "timeoutSecs": 1 },
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    // UNKNOWN_COMMAND 도 ok:false 다 — 코드를 함께 보지 않으면 미서빙이 통과로 위장한다.
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert_eq!(
        reply["message"].as_str().unwrap_or_default(),
        format!("시간 초과(1초): {cmd}"),
        "{reply}"
    );

    std::thread::sleep(Duration::from_secs(3));
    assert!(
        !marker.exists(),
        "손자가 살아남아 표식을 남겼다 — 그룹이 아니라 본체만 죽였다: {}",
        marker.display()
    );
}

/// 로그인 셸을 못 받았으면 **이름을 달고 거절한다**. 자기 $SHELL 을 읽으면 여기서 통과해
/// 버리는데, 그 통과가 곧 결함이다 — 띄운 쪽과 다른 로그인 셸로 돌면서 성공을 답한다.
#[test]
fn daemon_run_once_refuses_without_a_login_shell() {
    let helper = spawn_helper("daemon-run-once-no-shell");
    let marker = helper.dir().join("ran-anyway");
    let reply = helper.ask(json!({
        "id": 64,
        "method": "daemon_run_once",
        "params": {
            "root": helper.dir().to_string_lossy(),
            "cmd": format!(": > {}", marker.display()),
            "timeoutSecs": 20,
        },
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("로그인 셸"),
        "거절이 무엇이 없어서인지 말해야 한다: {reply}"
    );
    assert!(
        !marker.exists(),
        "로그인 셸을 추측해서 돌려 버렸다: {}",
        marker.display()
    );
}

/// 회수는 **명령줄이 대조될 때만** 한다 — pid 재사용으로 남을 죽이지 않기 위해서다.
#[test]
fn daemon_reap_kills_the_matching_pid() {
    use std::os::unix::process::{CommandExt, ExitStatusExt};

    let helper = spawn_helper("daemon-reap");
    // 데몬과 같은 모양으로 띄운다(자기 그룹의 리더) — 스스로 3초 뒤 끝난다.
    let mut child = Command::new("/bin/sleep")
        .arg("3")
        .process_group(0)
        .spawn()
        .expect("픽스처 자식 스폰");
    let pid = child.id();

    let reply = helper.ask(json!({
        "id": 65,
        "method": "daemon_reap",
        "params": { "entries": [[pid, "/bin/sleep 3"]] },
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"], json!([pid]), "거둔 pid 만 와야 한다: {reply}");

    let status = child.wait().expect("자식 종료 대기");
    assert_eq!(
        status.signal(),
        Some(9),
        "SIGKILL 로 끝나지 않았다 — 답만 하고 거두지 않았다: {status:?}"
    );
}

/// 대조에 걸리지 않으면 **빈 배열**이고 그 프로세스는 살아 있다. 그 빈 배열은 "대조된 것이
/// 없다"는 계산된 답이지, 재 본 적 없는 0 이 아니다.
#[test]
fn daemon_reap_answers_an_empty_list_and_spares_the_mismatch() {
    use std::os::unix::process::CommandExt;

    let helper = spawn_helper("daemon-reap-mismatch");
    let mut child = Command::new("/bin/sleep")
        .arg("5")
        .process_group(0)
        .spawn()
        .expect("픽스처 자식 스폰");
    let pid = child.id();

    let reply = helper.ask(json!({
        "id": 66,
        "method": "daemon_reap",
        "params": { "entries": [[pid, "some-other-binary --flag"]] },
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"], json!([]), "대조 안 된 pid 를 거뒀다: {reply}");
    assert!(
        child.try_wait().expect("상태 확인").is_none(),
        "명령줄이 다른데 죽였다 — pid 재사용이면 남의 프로세스다"
    );

    // 테스트가 띄운 것은 테스트가 거둔다.
    let _ = child.kill();
    let _ = child.wait();
}

/// 없는 것을 지우는 것은 성공이 아니다. 부재를 성공으로 접으면 호출자는 없앤 적 없는 것을
/// 없앴다고 믿고, 오탈자 하나가 "제거됨"으로 조용히 지나간다.
#[test]
fn plugin_remove_refuses_an_uninstalled_id_by_name() {
    let helper = spawn_helper("plugin-remove-absent");
    let reply = helper.ask(json!({ "method": "plugin_remove", "params": { "id": "ghost" } }));
    assert_eq!(reply["ok"], false, "{reply}");
    // UNKNOWN_COMMAND 도 ok:false 다 — 코드를 함께 보지 않으면 미서빙이 통과로 위장한다.
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert_eq!(
        reply["message"].as_str().unwrap_or_default(),
        "설치되지 않은 플러그인: ghost",
        "{reply}"
    );
}

// ── 스킬 재생성 방아쇠 ──────────────────────────────────────────────────────────
//
// 몸이 둘이다: 정체성 홈의 매니페스트 읽기와 argv 하나 분리 스폰. 홈은 부팅 상태에서 오고
// 매니페스트가 CLI 실물을 지목하므로, 이 프로세스가 앱이 아니어도 같은 답이 나온다.
//
// 이 명령의 요점은 **부재와 고장을 가르는 것**이다. 둘을 합치면 '설치 전'이 고장으로 보이거나
// (설치 안 한 홈에서 매번 오류) 고장이 조용한 false 가 된다(매니페스트가 깨져도 아무도 모른다).

/// 스폰된 CLI 가 남길 표식을 기다린다 — 상한 5초, 25ms 간격, 보이면 즉시 끝난다.
///
/// 이 명령의 계약이 `Child` 를 즉시 버리는 것이라(원본 그대로) 종료 사건을 받을 길이 없다.
/// 그래서 여기서만 짧게 다시 본다. 상한을 넘기면 실패다 — 무한 감시가 아니다.
fn wait_for_trace(path: &std::path::Path) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if let Ok(s) = std::fs::read_to_string(path) {
            if !s.trim().is_empty() {
                return s;
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!(
        "표식이 끝내 생기지 않았다 — 스폰하지 않고 답만 했다: {}",
        path.display()
    );
}

/// 매니페스트가 없으면 **성공에 false** 다. 설치 전은 고장이 아니다 — 오류로 답하면
/// 스킬 CLI 를 안 깐 홈에서 플러그인을 켤 때마다 실패가 뜬다.
#[test]
fn skill_refresh_spawn_answers_false_when_the_manifest_is_absent() {
    let helper = spawn_helper("skill-refresh-absent");
    let reply = helper.ask(json!({
        "id": 70, "method": "skill_refresh_spawn", "params": {}
    }));
    assert_eq!(reply["ok"], true, "부재를 고장으로 답했다: {reply}");
    assert_eq!(reply["data"], false, "{reply}");
}

/// 매니페스트가 지목한 CLI 를 **실제로 돌린다**. true 만 보는 단언은 스폰을 안 해도 통과하므로
/// 판별자는 그 CLI 만 남길 수 있는 표식이고, 표식의 내용이 argv(`skill refresh`)를 못박는다.
#[test]
fn skill_refresh_spawn_runs_the_cli_the_manifest_names() {
    let helper = spawn_helper("skill-refresh-spawn");
    let trace = helper.dir().join("cli-ran");
    let cli = helper.dir().join("fixture-cli");
    std::fs::write(
        &cli,
        format!(
            "#!/bin/sh\n\
             # 받은 인자를 그대로 남기고 스스로 끝난다(뒤에 남는 프로세스가 없다).\n\
             printf '%s\\n' \"$*\" > {}\n",
            trace.display()
        ),
    )
    .expect("픽스처 CLI");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(
        helper.home().join("skill-refresh.json"),
        json!({ "cli": cli.to_string_lossy() }).to_string(),
    )
    .expect("픽스처 매니페스트");

    let reply = helper.ask(json!({
        "id": 71, "method": "skill_refresh_spawn", "params": {}
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"], true, "스폰했다고 답하지 않았다: {reply}");
    assert_eq!(
        wait_for_trace(&trace).trim(),
        "skill refresh",
        "다른 argv 로 돌렸다"
    );
}

/// 매니페스트는 있는데 `cli` 가 없으면 **사유를 달고 실패한다**. 부재의 false 와 같은 답이
/// 되면 잘못 쓴 매니페스트가 '설치 전'으로 보이고, 스킬은 영영 재생성되지 않는다.
#[test]
fn skill_refresh_spawn_fails_by_name_when_the_manifest_has_no_cli() {
    let helper = spawn_helper("skill-refresh-broken");
    std::fs::write(
        helper.home().join("skill-refresh.json"),
        json!({ "note": "cli 가 없다" }).to_string(),
    )
    .expect("픽스처 매니페스트");

    let reply = helper.ask(json!({
        "id": 72, "method": "skill_refresh_spawn", "params": {}
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    // UNKNOWN_COMMAND 도 ok:false 다 — 코드를 함께 보지 않으면 미서빙이 통과로 위장한다.
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert_eq!(
        reply["message"].as_str().unwrap_or_default(),
        "매니페스트에 cli 없음",
        "{reply}"
    );
}

// ── 외부 테마 설치 ─────────────────────────────────────────────────────────────
//
// 훑기(themes_scan)와 짝이다. 둘의 부작용은 **다르다**: 읽기는 디스크를 만들지 않고,
// 쓰기는 자기 목적지를 만든다. 앱이 훑기 앞에서 홈 배치를 만들어 두면 같은 이름의 명령이
// 프로세스마다 다른 부작용을 지고, 그 차이는 답에 안 실려 아무 데도 안 남는다.

/// 설치는 부팅 홈 아래 themes/ 로 복사하고 **그 목적지를 스스로 만든다**.
#[test]
fn theme_install_copies_into_the_boot_home_and_makes_its_destination() {
    let helper = spawn_helper("theme-install");
    let src = helper.dir().join("midnight.json");
    std::fs::write(&src, br#"{"name":"Midnight"}"#).expect("픽스처 테마");
    let themes = helper.home().join("themes");
    assert!(!themes.exists(), "픽스처가 이미 목적지를 만들어 두었다");

    let reply = helper.ask(json!({
        "id": 80, "method": "theme_install",
        "params": { "path": src.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], true, "{reply}");
    let dst = themes.join("midnight.json");
    assert_eq!(
        reply["data"].as_str().unwrap_or_default(),
        dst.to_string_lossy(),
        "답이 설치된 경로다: {reply}"
    );
    assert_eq!(
        std::fs::read_to_string(&dst).expect("설치된 파일"),
        r#"{"name":"Midnight"}"#,
        "내용을 그대로 옮긴다"
    );

    // 설치한 것을 같은 프로세스의 훑기가 본다 — 두 명령이 같은 디렉터리를 가리킨다.
    let scanned = helper.ask(json!({ "id": 81, "method": "themes_scan" }));
    assert_eq!(scanned["data"][0]["file"], dst.to_string_lossy().to_string(), "{scanned}");

    // 동명 파일은 덮어쓴다(갱신) — 원본의 결정이다.
    std::fs::write(&src, br#"{"name":"Midnight2"}"#).expect("갱신본");
    let again = helper.ask(json!({
        "id": 82, "method": "theme_install",
        "params": { "path": src.to_string_lossy() }
    }));
    assert_eq!(again["ok"], true, "{again}");
    assert_eq!(
        std::fs::read_to_string(&dst).expect("갱신된 파일"),
        r#"{"name":"Midnight2"}"#,
        "동명 파일은 갱신된다"
    );
}

/// .json 이 아니면 이름을 달고 거절한다 — 복사하기 전에 거절해야 홈에 남지 않는다.
#[test]
fn theme_install_refuses_a_non_json_file_by_name() {
    let helper = spawn_helper("theme-install-ext");
    let src = helper.dir().join("theme.txt");
    std::fs::write(&src, b"not a theme").expect("픽스처");

    let reply = helper.ask(json!({
        "id": 83, "method": "theme_install",
        "params": { "path": src.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    // UNKNOWN_COMMAND 도 ok:false 다 — 코드를 함께 보지 않으면 미서빙이 통과로 위장한다.
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert_eq!(
        reply["message"].as_str().unwrap_or_default(),
        "테마 파일은 .json 이어야 함",
        "{reply}"
    );
    assert!(
        !helper.home().join("themes").exists(),
        "거절해 놓고 목적지를 만들었다"
    );
}

/// 없는 원본은 복사 실패다 — 성공을 답하면 설치되지 않은 테마가 설치된 것으로 읽힌다.
#[test]
fn theme_install_fails_when_the_source_is_absent() {
    let helper = spawn_helper("theme-install-absent");
    let src = helper.dir().join("ghost.json");

    let reply = helper.ask(json!({
        "id": 84, "method": "theme_install",
        "params": { "path": src.to_string_lossy() }
    }));
    assert_eq!(reply["ok"], false, "{reply}");
    assert_eq!(reply["code"], "COMMAND_FAILED", "{reply}");
    assert!(
        reply["message"].as_str().unwrap_or_default().contains("os error 2"),
        "무엇이 막았는지 말해야 한다: {reply}"
    );
}

/// 훑기는 디스크를 만들지 않는다 — 부재는 '설치된 테마 없음'이지 만들 이유가 아니다.
#[test]
fn a_home_scan_does_not_make_the_directory_it_reads() {
    let helper = spawn_helper("theme-scan-absent");
    let reply = helper.ask(json!({ "id": 85, "method": "themes_scan" }));
    assert_eq!(reply["ok"], true, "부재는 실패가 아니다: {reply}");
    assert_eq!(reply["data"], json!([]), "{reply}");
    assert!(
        !helper.home().join("themes").exists(),
        "읽기가 테마 디렉터리를 만들었다: {}",
        helper.home().join("themes").display()
    );
}

/// 감사해서 거절한 이름과 **모르는 이름**은 다른 답이다.
///
/// 지금은 코드가 둘 다 UNKNOWN_COMMAND 다. 사유는 message 에 실리지만 **기계는 코드만 본다** —
/// 요구 원장이 코드를 기록하므로(invoke-demand.jsonl) 둘이 한 통에 섞이고, "아직 안 옮겼다"와
/// "여기서는 못 한다"를 세는 사람이 그 차이를 잃는다(실측 2026-07-29: 라이브 원장에서 사유가
/// 등재된 넷이 미등재와 같은 코드로 나왔다).
///
/// 프레임워크 표는 이미 이 구분을 갖는다(FRAMEWORK_CONCEPT_ABSENT vs FRAMEWORK_DELEGATED).
/// 같은 이유로 여기도 가른다.
#[test]
fn an_audited_refusal_is_not_an_unknown_name() {
    let helper = spawn_helper("refusal-code");

    let audited = helper.ask(json!({ "method": "app_relaunch", "params": {} }));
    assert_eq!(audited["ok"], false, "{audited}");
    assert_eq!(audited["code"], "REFUSED_BY_AUDIT", "{audited}");
    // 사유는 그대로 실린다 — 코드를 가른다고 문장을 잃지 않는다.
    assert!(
        audited["message"].as_str().unwrap_or_default().contains("프로세스"),
        "{audited}"
    );

    let unknown = helper.ask(json!({ "method": "no_such_name_xyz", "params": {} }));
    assert_eq!(unknown["code"], "NO_HOST", "{unknown}");
    assert!(
        unknown["message"].as_str().unwrap_or_default().contains("no_such_name_xyz"),
        "어느 이름 때문인지 말한다: {unknown}"
    );
}


/// 원장 읽기는 저장소에서 온다 — 적재한 것이 그대로 돌아온다.
#[test]
fn recent_reads_back_what_was_admitted() {
    let helper = spawn_helper("activity-recent");
    for step in ["enter", "render", "done"] {
        let r = helper.ask(json!({
            "method": "activity_publish",
            "params": { "kind": "boot.step", "source": "boot", "payload": { "step": step } }
        }));
        assert_eq!(r["ok"], true, "{r}");
    }

    let all = helper.ask(json!({ "method": "activity_recent", "params": {} }));
    assert_eq!(all["ok"], true, "{all}");
    let rows = all["data"].as_array().expect("배열");
    assert_eq!(rows.len(), 3, "{all}");
    // 오래된 것부터 — 소비자가 그 순서로 붙인다.
    assert_eq!(rows[0]["payload"]["step"], "enter");
    assert_eq!(rows[2]["payload"]["step"], "done");

    // 커서는 배타다 — 이미 본 seq 는 다시 오지 않는다.
    let seq1 = rows[0]["seq"].as_u64().unwrap();
    let after = helper.ask(json!({ "method": "activity_recent", "params": { "since": seq1 } }));
    assert_eq!(after["data"].as_array().unwrap().len(), 2, "{after}");

    // 상한은 **새 것**을 남긴다 — 오래된 것을 남기면 피드가 과거에 멈춘다.
    let capped = helper.ask(json!({ "method": "activity_recent", "params": { "limit": 1 } }));
    assert_eq!(capped["data"][0]["payload"]["step"], "done", "{capped}");
}

// ── 제어면 ────────────────────────────────────────────────────────────────────
//
// 이 소켓은 **하나의 표면**이다: cored 가 서빙하는 이름은 cored 가 답하고, 창이 답하는
// 이름은 창으로 배달된다. 부르는 쪽은 누가 답하는지 몰라도 되고 봉투는 같다.
//
// 인프로세스 검사는 규칙까지만 증명한다. 여기서 증명하는 것은 **프로세스를 건너서도**
// 그 왕복이 선다는 것 — 밖에서 부르고, 다른 연결의 창이 받아, 답이 부른 쪽으로 돌아온다.

/// 창을 가진 쪽을 흉내낸다 — 붙어서 배달을 기다리는 연결 하나.
struct FakeHost {
    reader: BufReader<UnixStream>,
    /// 등록·회신을 쓰는 끝. 살아 있어야 연결이 유지된다 — 놓으면 cored 가 호스트를 잃는다.
    #[allow(dead_code)]
    writer: UnixStream,
    socket: PathBuf,
}

impl FakeHost {
    fn attach(h: &Helper, live: &[&str], focused: &str) -> FakeHost {
        let conn = UnixStream::connect(&h.socket).expect("호스트 연결");
        conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut writer = conn.try_clone().unwrap();
        let mut reader = BufReader::new(conn);
        writeln!(
            writer,
            "{}",
            json!({"id":"attach","method":"control_host_attach",
                   "params":{"live":live,"focused":focused}})
        )
        .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).expect("등록 응답");
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["ok"], true, "등록이 서지 않았다: {v}");
        FakeHost { reader, writer, socket: h.socket.clone() }
    }

    /// 배달 하나를 받아 그대로 답한다 — 창이 하는 일의 최소형.
    fn serve_one(&mut self, answer: Value) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("배달 읽기");
        let push: Value = serde_json::from_str(line.trim()).expect("배달은 한 줄 JSON");
        // 앱의 cmd_result 와 **같은 축**(u64 seq) — 렌더러는 받은 id 를 그대로 되울린다.
        let id = push["deliver"]["id"].as_u64().expect("배달에는 상관 id 가 있다");
        // 회신은 **다른 연결**로 보낸다 — 창이 자기 요청 흐름과 무관하게 답하는 실제 모양이다.
        let conn = UnixStream::connect(&self.socket).expect("회신 연결");
        let mut w = conn.try_clone().unwrap();
        writeln!(w, "{}", json!({"method":"cmd_result","params":{"id":id,"result":answer}})).unwrap();
        let mut ack = String::new();
        BufReader::new(conn).read_line(&mut ack).expect("회신 응답");
        let a: Value = serde_json::from_str(ack.trim()).unwrap();
        assert_eq!(a["data"], true, "짝을 못 찾았다: {a}");
        push
    }
}

/// 창이 붙지 않았으면 그 사실을 이름과 함께 말한다 — "없는 명령"이 아니다.
///
/// 두 사실을 같은 코드로 답하면 부른 쪽은 재시도할 이유를 못 찾는다: 없는 명령은 기다려도
/// 안 생기고, 부팅 중인 창은 기다리면 생긴다.
#[test]
fn without_a_window_host_an_app_command_says_no_host() {
    let h = spawn_helper("control-no-host");
    let r = h.ask(json!({"id":1,"method":"project.open","params":{"root":"/x"}}));
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NO_HOST", "{r}");
    assert!(r["message"].as_str().unwrap_or_default().contains("project.open"), "{r}");
    assert_eq!(r["id"], 1);
}

/// 붙은 뒤에는 같은 이름이 **창으로 배달되고** 창의 답이 부른 쪽으로 돌아온다.
#[test]
fn an_app_command_travels_to_the_window_and_back() {
    let h = spawn_helper("control-roundtrip");
    let mut host = FakeHost::attach(&h, &["main"], "main");

    let caller = std::thread::spawn({
        let socket = h.socket.clone();
        move || {
            let conn = UnixStream::connect(&socket).unwrap();
            conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut w = conn.try_clone().unwrap();
            writeln!(
                w,
                "{}",
                json!({"id":7,"method":"project.open","params":{"root":"/p"},"timeoutMs":8000})
            )
            .unwrap();
            let mut line = String::new();
            BufReader::new(conn).read_line(&mut line).unwrap();
            serde_json::from_str::<Value>(line.trim()).unwrap()
        }
    });

    let push = host.serve_one(json!({"ok":true,"data":{"opened":"/p"}}));
    // 인자가 **그대로** 간다 — cored 를 거쳤다고 모양이 달라지지 않는다.
    assert_eq!(push["deliver"]["method"], "project.open");
    assert_eq!(push["deliver"]["params"]["root"], "/p");
    assert_eq!(push["deliver"]["window"], "main");

    let reply = caller.join().expect("부른 쪽");
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["data"]["opened"], "/p");
    assert_eq!(reply["id"], 7, "하니스가 준 id 로 돌아온다");
}

/// cored 가 서빙하는 이름은 호스트가 붙어 있어도 **cored 가 답한다** — 배달로 새지 않는다.
#[test]
fn a_served_name_is_still_answered_here() {
    let h = spawn_helper("control-served-wins");
    let _host = FakeHost::attach(&h, &["main"], "main");
    let r = h.ask(json!({"method":"cored.commands"}));
    assert_eq!(r["ok"], true, "{r}");
    let names: Vec<&str> = r["data"]["commands"]
        .as_array()
        .expect("명령 목록")
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"control_host_attach"), "제어면 명령이 목록에 없다");
    assert!(names.contains(&"cmd_result"));
}

// ── 스트림 ────────────────────────────────────────────────────────────────────
//
// 답이 여럿인 명령(터미널 출력·프로세스 stdout)의 되돌아오는 길. 요청이 토큰을 싣고, 그 뒤로
// 프레임이 **그 연결로** 밀려온다. 여기서 고정하는 것은 그 **자리**다 — 미는 쪽(명령의 몸)은
// 아직 없다.

#[test]
fn a_reply_is_never_shaped_like_a_frame() {
    let h = spawn_helper("stream-bind");
    let r = h.ask(json!({
        "id": 1,
        "method": "cored.commands",
        "params": { "onOutput": { "__frameworkStream": "t-live" } }
    }));
    assert_eq!(r["ok"], true, "{r}");
    // 겹치면 받는 쪽이 프레임을 답으로 읽고 짝을 지운다.
    assert!(r.get("stream").is_none(), "{r}");
}

/// 토큰을 실은 인자가 명령의 몸까지 흘러가면 안 된다 — 명령마다 무시 규칙을 따로 알아야 한다.
#[test]
fn a_token_never_breaks_the_command_it_rode_on() {
    let h = spawn_helper("stream-passthrough");
    let r = h.ask(json!({
        "id": 2,
        "method": "app_environment",
        "params": { "onOutput": { "__frameworkStream": "t-x" } }
    }));
    // 인자를 하나도 받지 않는 명령이다. 토큰이 인자로 새면 INVALID_PARAMS 로 죽는다.
    assert_eq!(r["ok"], true, "{r}");
}

/// 느린 명령 하나가 **같은 연결의 뒤를** 막지 않는다.
///
/// 프로토콜에 id 가 있는 것은 한 연결에 요청을 겹쳐도 짝이 정해진다는 뜻이다 — 다리(bridge)가
/// 그 약속 위에 유지 연결 하나로 전부를 보낸다. 직렬로 답하면 그 약속이 깨진다.
///
/// 실측(2026-07-29): Electron 부팅에서 process_spawn 이 30초 상한까지 답을 못 받았다. 직접
/// 부르면 3ms 다 — 앞선 느린 명령 뒤에 줄 서 있었다. 그 증상은 "사이드카 스폰 실패"로 나와
/// 원인과 한참 떨어져 보인다.
#[test]
fn a_slow_command_does_not_block_the_rest_of_its_connection() {
    let h = spawn_helper("serial-block");
    // 붙어 있지만 회신하지 않는 창 — 배달은 상한까지 기다린다.
    let _host = FakeHost::attach(&h, &["main"], "main");

    let conn = UnixStream::connect(&h.socket).expect("연결");
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut w = conn.try_clone().unwrap();
    let mut reader = BufReader::new(conn);

    // 느린 것 먼저(회신 없는 배달), 곧바로 빠른 것.
    writeln!(w, "{}", json!({"id":1,"method":"project.open","timeoutMs":3000})).unwrap();
    writeln!(w, "{}", json!({"id":2,"method":"cored.commands"})).unwrap();

    let started = std::time::Instant::now();
    let mut line = String::new();
    reader.read_line(&mut line).expect("첫 답");
    let first: Value = serde_json::from_str(line.trim()).unwrap();

    // 먼저 오는 것은 **빠른 쪽**이라야 한다 — 직렬이면 3초짜리가 먼저 오고 그 뒤에 온다.
    assert_eq!(
        first["id"], 2,
        "느린 명령이 뒤를 막았다({}ms): {first}",
        started.elapsed().as_millis()
    );
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "빠른 명령이 {}ms 걸렸다 — 앞의 상한을 기다렸다",
        started.elapsed().as_millis()
    );
}

/// `system.hello` 가 **앱과 같은 축**을 답한다.
///
/// 부르는 쪽은 규약이 아니라 답으로 위상을 안다. 축이 빠지면 그 클라이언트는 두 소켓에 서로
/// 다른 코드를 써야 하고, 그것이 두 번째 진실이다 — 실측(2026-07-29): 기존 P0 계약 하니스가
/// 이 소켓에서 appVersion·identity·startedAt·capabilities 없음으로 5건 실패했다.
///
/// `framework` 는 예외다. 이 프로세스에는 프레임워크가 없고, 모르는 것을 말하지 않는 것이
/// 이 축의 규칙이다(`role: "cored"` 가 그 사실을 이미 말한다).
#[test]
fn hello_answers_the_same_axes_as_the_app() {
    let h = spawn_helper("hello-axes");
    let r = h.ask(json!({ "id": 1, "method": "system.hello" }));
    assert_eq!(r["ok"], true, "{r}");
    for key in [
        "protocol",
        "minClientProtocol",
        "appVersion",
        "identity",
        "pid",
        "startedAt",
        "role",
        "capabilities",
    ] {
        assert!(!r[key].is_null(), "{key} 가 없다: {r}");
    }
    assert_eq!(r["role"], "cored");
    // 정체성은 부팅 인자로 받은 그것이라야 한다 — 지어내면 두 프로세스가 다른 홈을 말한다.
    assert_eq!(r["identity"], "com.soksak.dev");
    assert!(
        r["capabilities"].as_array().is_some_and(|c| c.iter().any(|v| v == "hello.v1")),
        "능력 목록에 hello.v1 이 없다: {r}"
    );
    // 기동 시각은 과거의 한 순간이다 — 0 이면 "모른다"를 값으로 답한 것이다.
    assert!(r["startedAt"].as_u64().is_some_and(|t| t > 0), "{r}");
    // 이 프로세스에는 프레임워크가 없다 — 모르는 것을 말하지 않는다.
    assert!(r["framework"].is_null(), "프레임워크를 지어냈다: {r}");
}
