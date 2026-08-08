// 붙기 전에 정해지는 것들 — 봉투·밀려온 줄의 해석·cored 를 세우는 판정.
//
// 소켓 위의 계약은 tests/attaches_to_cored.rs 가 잰다. 여기서 재는 것은 그 계약에 들어가기
// 전에 이 프로세스가 혼자 정하는 값들이다: 무엇을 보내는가, 받은 줄을 무엇으로 읽는가,
// 그리고 "이미 서 있는 cored 를 채택하는가 / 띄우는가 / 이름을 달고 실패하는가".

use super::*;

/// 픽스처 뿌리는 홈 아래 고정 경로다(재사용·멱등). `CARGO_TARGET_TMPDIR` 을 쓰지 않는 이유:
/// 유닉스 소켓 경로에는 OS 상한이 있어(macOS ~104바이트) 워크트리 아래 target 경로는 그것만으로
/// 상한을 넘는다. 사용자 정본 홈(`~/.soksak-dev`)에는 쓰지 않는다 — 검사가 사람의 홈을 건드리면
/// 그 사고는 다음 규칙 변경까지 아무도 못 본다.
fn fixture_dir(name: &str) -> PathBuf {
    let base = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".soksak-e2e/cored-host");
    let dir = base.join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("픽스처 디렉터리");
    dir
}

/// 실행 가능한 가짜 cored 하나. 진짜 프로세스를 상대로 판정을 재기 위해서다 — 스폰을 흉내로
/// 대신하면 "띄우고 첫 줄을 읽는다"는 계약이 검사에서 사라진다.
///
/// 오래 사는 가짜는 반드시 `exec` 로 자리를 넘겨야 한다. `sh` 가 자식을 두면 우리가 거두는
/// 것은 `sh` 뿐이고 그 자식은 살아남는다 — 그러면 "우리가 띄운 것은 우리가 거둔다"는 단언이
/// 거짓인 채로 통과하고, 남은 고아가 이 프로세스에서 상속한 fd 를 계속 쥔다(실측: 그 고아가
/// 닫힌 소켓을 살아 있는 것으로 보이게 해 다른 검사가 무작위로 실패했다).
fn fake_binary(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).expect("가짜 실행물");
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("실행 권한");
    p
}

fn facts(live: &[&str], focused: &str) -> WindowFacts {
    WindowFacts {
        live: live.iter().map(|s| s.to_string()).collect(),
        focused: focused.to_string(),
    }
}

/// 등록 봉투는 세 가지를 말한다: 이름·상관 id·지금의 창 사실. 하나라도 빠지면 cored 는
/// INVALID_PARAMS 로 거절하고, 그 거절은 프레임워크 로그 한 줄이라 조용하다.
#[test]
fn the_attach_envelope_names_the_method_and_carries_the_facts() {
    let v = attach_envelope(&facts(&["main", "w-1"], "w-1"));
    assert_eq!(v["method"], ATTACH);
    assert_eq!(v["id"], ATTACH_ID);
    assert_eq!(v["params"]["live"], json!(["main", "w-1"]));
    assert_eq!(v["params"]["focused"], "w-1");
}

/// 갱신은 등록과 **같은 모양**이다 — 다르면 cored 가 둘을 다르게 읽고, 붙은 뒤의 창 변화가
/// 통째로 반영되지 않는다.
#[test]
fn the_windows_envelope_reports_the_same_shape_as_attach() {
    let f = facts(&["w-2"], "w-2");
    assert_eq!(windows_envelope(&f)["params"], attach_envelope(&f)["params"]);
    assert_eq!(windows_envelope(&f)["method"], WINDOWS);
}

/// 상관 id 를 달아도 보고는 **같은 보고**다 — 모양이 갈리면 답을 기다리는 경로와 안 기다리는
/// 경로가 cored 에 서로 다르게 읽힌다.
#[test]
fn a_correlated_report_is_the_same_report() {
    let f = facts(&["w-3"], "w-3");
    let plain = windows_envelope(&f);
    let tagged = windows_envelope_with(&f, "w7");
    assert_eq!(tagged["method"], plain["method"]);
    assert_eq!(tagged["params"], plain["params"]);
    assert_eq!(tagged["id"], "w7");
    assert!(plain.get("id").is_none(), "안 기다리는 보고에는 상관 id 가 없다");
}

/// 답이 없는 것을 성공으로 읽지 않는다.
///
/// 붙었는지 묻는 자리가 상한에서 `Ok` 를 답하면 부팅 진단이 "안 붙었다"를 못 본다 — 그리고
/// 그 상태는 밖에서 부른 명령이 `NO_HOST` 로 거절될 때까지 아무 데도 나타나지 않는다.
#[test]
fn silence_is_not_a_registration() {
    let dir = fixture_dir("silent-attach");
    let socket = dir.join("h.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("가짜 cored");
    // 받기만 하고 답하지 않는다. 연결은 붙잡아 둔다 — 놓으면 "끊겼다"가 되어 다른 갈래를 잰다.
    let held = std::thread::spawn(move || listener.accept().map(|(c, _)| c));
    let host = CoredHost::attach(&socket, Arc::new(SilentFacts), Arc::new(SilentExec)).expect("붙는다");
    let e = host
        .attached(Duration::from_millis(200))
        .expect_err("답이 없으면 실패다");
    assert!(e.contains("200ms"), "{e}");
    // 두 번째로 물어도 같은 답이다 — 채널은 한 번만 주므로 판정을 붙잡아야 한다.
    assert_eq!(host.attached(Duration::from_millis(1)).unwrap_err(), e);
    drop(held.join().expect("가짜 cored 연결"));
}

#[test]
fn cored_writer_has_a_finite_write_deadline() {
    let dir = fixture_dir("bounded-writer");
    let socket = dir.join("h.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("가짜 cored");
    let held = std::thread::spawn(move || listener.accept().map(|(c, _)| c));
    let host = CoredHost::attach(&socket, Arc::new(SilentFacts), Arc::new(SilentExec)).expect("붙는다");
    let timeout = host
        .writer
        .lock()
        .expect("writer lock")
        .write_timeout()
        .expect("timeout query");
    assert_eq!(timeout, Some(CORED_WRITE_LIMIT));
    drop(held.join().expect("가짜 cored 연결"));
}

struct SilentFacts;
impl WindowFactsSource for SilentFacts {
    fn facts(&self) -> WindowFacts {
        facts(&["w-silent"], "w-silent")
    }
}

struct SilentExec;
impl DeliveryExec for SilentExec {
    fn execute(&self, _d: &Delivery) -> Value {
        json!({ "ok": false, "code": "UNREACHABLE", "message": "이 검사에는 배달이 오지 않는다" })
    }
    fn broadcast(&self, _event: &str, _payload: Value) -> bool {
        false
    }
}

/// 회신은 **배달 id** 로 짝지어진다. 다른 번호를 실으면 cored 는 짝을 못 찾아 조용히 버리고,
/// 부른 쪽은 사유 없는 TIMEOUT 만 본다.
#[test]
fn the_result_envelope_carries_the_delivery_id() {
    let v = result_envelope(7, json!({ "ok": true, "data": 1 }));
    assert_eq!(v["method"], RESULT);
    assert_eq!(v["params"]["id"], 7);
    assert_eq!(v["params"]["result"]["ok"], true);
}

/// 배달 봉투를 그대로 읽는다 — 이름을 바꾸거나 값을 채우면 그것이 두 번째 계약이 된다.
///
/// 키를 골라 담지 않는다는 것이 요점이다: 고르는 자리는 새 필드를 모르고, 모르는 필드는 실패가
/// 아니라 **소멸**한다. 실측(2026-08-01) — 배달 봉투가 5키였고 요청 봉투는 10키라 `--parent` 로
/// 온 상관 id 가 cored 를 지나며 사라졌다. 그래서 여기서 `parent`·`origin` 까지 함께 잰다.
#[test]
fn a_delivery_is_read_as_it_came() {
    let line = r#"{"deliver":{"id":3,"method":"panel.split","params":{"side":"right"},"pane":"p3","window":"w-1","parent":"turn-9","origin":"schedule"}}"#;
    let Ok(Incoming::Deliver(d)) = classify(line) else {
        panic!("배달로 읽지 못했다");
    };
    assert_eq!(d.id, 3);
    assert_eq!(d.req.method, "panel.split");
    assert_eq!(d.req.params, json!({ "side": "right" }));
    assert_eq!(d.req.pane.as_deref(), Some("p3"));
    assert_eq!(d.window(), "w-1");
    assert_eq!(d.req.parent.as_deref(), Some("turn-9"), "상관 부모가 배달에서 살아남는다");
    assert_eq!(d.req.origin.as_deref(), Some("schedule"), "유래도 살아남는다");
}

/// 창을 안 짚은 배달은 거절한다 — 아무 창에서나 돌면 남의 창이 답하고 그 오답은 오류로 안 보인다.
#[test]
fn a_delivery_without_a_window_is_refused() {
    assert!(classify(r#"{"deliver":{"id":1,"method":"x.y"}}"#).is_err());
}

/// 방송과 배달은 다른 키다. 같은 것으로 읽으면 방송마다 없는 id 로 회신하게 되고, 그 회신은
/// cored 에서 짝 없는 줄로 버려진다.
#[test]
fn a_broadcast_is_not_a_delivery() {
    let Ok(Incoming::Broadcast { event, payload }) =
        classify(r#"{"broadcast":{"event":"fs.changed","payload":{"path":"/x"}}}"#)
    else {
        panic!("방송으로 읽지 못했다");
    };
    assert_eq!(event, "fs.changed");
    assert_eq!(payload["path"], "/x");
}

/// 등록의 답은 배달이 아니다 — 그 답이 "이제 밖에서 온 명령이 이 창들로 온다"는 신호다.
#[test]
fn the_answer_to_the_attach_is_recognised() {
    let Ok(Incoming::Answer { id, ok, .. }) = classify(r#"{"id":"attach","ok":true,"data":null}"#)
    else {
        panic!("응답으로 읽지 못했다");
    };
    assert_eq!(id, json!(ATTACH_ID));
    assert!(ok);
    let Ok(Incoming::Answer { ok, code, .. }) =
        classify(r#"{"id":"attach","ok":false,"code":"INVALID_PARAMS","message":"x"}"#)
    else {
        panic!("응답으로 읽지 못했다");
    };
    assert!(!ok);
    assert_eq!(code, "INVALID_PARAMS");
}

/// 못 읽은 줄은 이름을 달고 실패한다. 조용히 넘기면 붙은 곳이 cored 가 아닌 것이 "명령이
/// 사라진다"로만 나타난다.
#[test]
fn a_line_that_is_not_json_fails_by_name() {
    assert!(classify("not json").is_err());
    // 배달인데 창이 없다 — 어디로 보낼지 모르는 배달을 실행하면 폴백으로 창을 고르게 된다.
    assert!(classify(r#"{"deliver":{"id":1,"method":"x.y"}}"#).is_err());
}

/// 부팅 인자는 **넘기는 값**이다. cored 가 자기 환경에서 읽으면 자기를 띄운 쪽의 환경을
/// 사용자의 것인 양 답하고, 그 오답은 오류가 아니라 빈 결과로 나타난다.
#[test]
fn the_boot_arguments_are_values_this_process_hands_over() {
    let args = spawn_args(
        Path::new("/h/cored.sock"),
        Path::new("/h"),
        "com.soksak.tauri.dev",
        Path::new("/tmp/moved-data"),
        Some(Path::new("<machine-path>")),
        Some("/bin/zsh"),
    );
    assert_eq!(
        args.iter().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "--socket", "/h/cored.sock",
            "--home", "/h",
            "--identifier", "com.soksak.tauri.dev",
            "--data-dir", "/tmp/moved-data",
            "--user-home", "<machine-path>",
            "--login-shell", "/bin/zsh",
        ]
    );
    // 모르는 것은 지어내지 않는다 — 안 넘기면 cored 가 그 값이 필요한 명령만 이름을 달고
    // 거절하고 나머지는 계속 서빙한다. 빈 셸을 넘기면 그 거절이 "빈 셸로 실행"이 된다.
    let bare = spawn_args(
        Path::new("/h/cored.sock"),
        Path::new("/h"),
        "com.soksak.tauri.dev",
        Path::new("/h/data"),
        None,
        Some(""),
    );
    assert_eq!(bare.len(), 8, "{bare:?}");
}

/// 저장소 위치는 **넘긴다** — 파생 규칙을 양쪽에 두면 한쪽만 옮겨진다.
///
/// RED 근거(실측 2026-08-01): 앱은 debug 빌드에서 `SOKSAK_DATA_DIR` 를 읽어 저장소를 옮기는데
/// (`data::data_dir_from`), cored 는 그 env 를 **아예 안 읽고** `identity.data_dir()` 로 자기
/// 파생을 한다. `--data-dir` 을 받는 자리는 이미 있는데 아무도 안 넘겼다. 그러면 두 프로세스가
/// **다른 파일**을 열고, 쓰기 소유권 잠금도 서로 다른 디렉터리에서 잡혀 무의미해진다 —
/// 증상은 오류가 아니라 "저장한 것이 안 보인다"다.
///
/// 그래서 이 인자는 Option 이 아니다. Option 은 "안 넘겨도 된다"는 뜻이고, 지금 상태가 정확히
/// 그 결과였다.
#[test]
fn the_store_location_is_handed_over_never_re_derived() {
    let moved = spawn_args(
        Path::new("/h/cored.sock"),
        Path::new("/h"),
        "com.soksak.tauri.dev",
        Path::new("/tmp/e2e-store"),
        None,
        None,
    );
    let i = moved.iter().position(|a| a == "--data-dir").expect("저장소 위치를 넘긴다");
    assert_eq!(moved[i + 1], "/tmp/e2e-store");
}

/// 준비 완료 줄은 **그 소켓**을 말해야 한다. 아니면 우리가 부른 것이 cored 가 아니거나 다른
/// 자리에 붙은 것이다 — 둘 다 "붙은 척"으로 넘어가면 안 된다.
#[test]
fn readiness_must_name_the_socket_we_asked_for() {
    let s = Path::new("/h/cored.sock");
    assert!(readiness_names_socket("soksak-cored: listening /h/cored.sock", s));
    assert!(!readiness_names_socket("soksak-cored: listening /other/cored.sock", s));
    assert!(!readiness_names_socket("", s));
}

/// 이미 서빙 중이면 **띄우지 않는다.** 같은 자리에 둘을 띄우면 나중 것이 남의 서빙을 끊거나
/// 조용히 물러난다 — 그리고 우리는 어느 쪽인지 모른 채 붙는다.
#[test]
fn a_live_cored_is_adopted_and_never_respawned() {
    let dir = fixture_dir("adopt");
    let socket = dir.join("h.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("가짜 cored");
    let worker = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut conn, _) = listener.accept().expect("hello probe");
            let read = conn.try_clone().expect("read half");
            let mut line = String::new();
            std::io::BufReader::new(read).read_line(&mut line).expect("hello read");
            assert!(line.contains("system.hello"), "{line}");
            writeln!(
                conn,
                "{{\"id\":\"cored-probe\",\"ok\":true,\"role\":\"cored\",\"protocol\":1}}"
            )
            .expect("hello reply");
        }
    });
    // 바이너리는 아예 해소하지 않는다 — 채택은 스폰 준비보다 먼저 성립해야 한다.
    // 앱 번들 안에 sidecar 가 누락되어도 이미 서빙 중인 홈의 cored 를 잃어서는 안 된다.
    let cored = ensure_cored(
        &socket,
        &dir,
        "com.soksak.tauri.dev",
        None,
        Path::new("/h/data"),
        None,
        None,
    )
    .expect("채택");
    assert_eq!(cored.origin, Origin::Adopted);
    assert_eq!(cored.socket, socket);
    assert!(is_served(&socket), "받는 쪽이 있어서 채택했다");
    worker.join().expect("가짜 cored 종료");
}

#[test]
fn a_listener_that_accepts_but_cannot_answer_cored_hello_is_not_served() {
    let dir = fixture_dir("mute-listener");
    let socket = dir.join("h.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("유령 listener");
    let worker = std::thread::spawn(move || {
        let (_conn, _) = listener.accept().expect("probe connect");
        std::thread::sleep(std::time::Duration::from_millis(500));
    });
    assert!(
        !is_served(&socket),
        "connect만 받고 system.hello에 답하지 않는 listener는 cored가 아니다"
    );
    worker.join().expect("listener 종료");
}

/// 자리에 자국이 남아 있어도 **받는 쪽이 없으면 서빙이 아니다.**
///
/// 이것을 살아 있음으로 읽으면 아무도 없는 자리에 붙고, 그 실패는 붙은 다음에야 — 밖에서 부른
/// 명령이 답 없이 끝날 때에야 — 나타난다.
///
/// 죽은 자국을 이 프로세스에서 bind→close 로 만들지 않는다. 검사 프로세스는 다른 검사가
/// 자식을 띄우는 중이고, 표준 라이브러리가 소켓을 만든 뒤 CLOEXEC 를 거는 사이에 포크가 끼면
/// 그 자식이 우리 listener 를 물려받아 **닫은 뒤에도 살아 있는 것처럼 보인다**(실측: 그 경주로
/// 이 단언이 전체 스위트에서만 무작위로 뒤집혔다 — 단독으로는 100번 통과했다). 판정이 보는
/// 것은 "연결이 되는가" 하나뿐이라 자국의 종류는 판정을 가르지 않는다.
#[test]
fn a_seat_nobody_answers_is_not_served() {
    let dir = fixture_dir("dead-seat");
    let socket = dir.join("h.sock");
    std::fs::write(&socket, b"").expect("죽은 자국");
    assert!(socket.exists(), "자국은 남아 있다");
    assert!(!is_served(&socket), "파일이 있다고 서빙이 아니다");
    // 그래서 채택하지 않는다 — 띄울 것도 없으면 이름을 달고 실패한다.
    let e = ensure_cored(
        &socket,
        &dir,
        "com.soksak.tauri.dev",
        Some(&dir.join("없는-cored")),
        Path::new("/h/data"),
        None,
        None,
    )
    .unwrap_err();
    assert!(e.contains("없는-cored"), "{e}");
}

/// 세울 것도 채택할 것도 없으면 **이름을 달고** 실패한다. 지어낸 경로로 spawn 하면 사유가
/// "ENOENT" 한 줄로 남고, 무엇을 어디서 찾았는지는 사라진다.
#[test]
fn a_missing_binary_fails_by_name() {
    let dir = fixture_dir("no-binary");
    let e = ensure_cored(
        &dir.join("h.sock"),
        &dir,
        "com.soksak.tauri.dev",
        None,
        Path::new("/h/data"),
        None,
        None,
    )
    .unwrap_err();
    assert!(e.contains(CORED_BIN_ENV), "{e}");
}

/// 아무 말 없이 끝났고 그 자리를 서빙하는 것도 없다 — 성공으로 넘기면 붙을 곳 없는 소켓에
/// 붙으려다 부팅이 조용히 반쪽이 된다.
#[test]
fn a_helper_that_says_nothing_and_dies_is_a_failure() {
    let dir = fixture_dir("silent");
    let bin = fake_binary(&dir, "silent-cored", "exit 0");
    let e = ensure_cored(
        &dir.join("h.sock"),
        &dir,
        "com.soksak.tauri.dev",
        Some(&bin),
        Path::new("/h/data"),
        None,
        None,
    )
    .unwrap_err();
    assert!(e.contains("준비 완료"), "{e}");
}

/// 준비 완료 줄이 다른 자리를 말하면 거둔다. 그 줄을 믿으면 우리가 지목한 자리에는 아무도
/// 없는데 "섰다"고 읽는다.
#[test]
fn a_helper_that_names_another_socket_is_reaped_and_refused() {
    let dir = fixture_dir("wrong-seat");
    let bin = fake_binary(
        &dir,
        "wrong-cored",
        "echo 'listening /elsewhere/cored.sock'; exec sleep 30",
    );
    let e = ensure_cored(
        &dir.join("h.sock"),
        &dir,
        "com.soksak.tauri.dev",
        Some(&bin),
        Path::new("/h/data"),
        None,
        None,
    )
    .unwrap_err();
    assert!(e.contains("/elsewhere/cored.sock"), "{e}");
}

/// 우리가 띄운 것은 우리가 거둔다(멱등). 채택한 것은 건드리지 않는다 — 남의 프로세스를
/// 거두면 거기 붙어 있던 다른 프레임워크의 창이 통째로 주소를 잃는다.
#[test]
fn we_reap_only_what_we_spawned() {
    let dir = fixture_dir("reap");
    let socket = dir.join("h.sock");
    let bin = fake_binary(
        &dir,
        "slow-cored",
        &format!("echo 'listening {}'; exec sleep 30", socket.display()),
    );
    let mut cored = ensure_cored(
        &socket,
        &dir,
        "com.soksak.tauri.dev",
        Some(&bin),
        Path::new("/h/data"),
        None,
        None,
    )
    .expect("띄움");
    assert_eq!(cored.origin, Origin::Spawned);
    assert!(cored.spawned_alive());
    cored.stop();
    assert!(!cored.spawned_alive());
    cored.stop(); // 멱등 — 두 번 거둬도 남의 pid 를 죽이지 않는다
}

// ── 값을 받는 요청 ────────────────────────────────────────────────────────────
//
// 지금 이 호스트는 보내고 **성패만** 받는다(등록·창 보고가 그것만 필요했다). 그런데 앱이
// 자기 DB 커넥션을 놓으려면 `data_get` 의 **답**을 받아야 한다 — 성패로는 값을 못 나른다.
//
// 답의 `data` 를 버리는 한 앱은 계속 자기가 저장소를 연다. 그러면 저장소를 쓰는 주인이 둘이고,
// SQLite 는 막지 않고 직렬화만 한다 — 그 잠금이 시끄럽게 만들려던 바로 그 조용한 경우다.

/// 답 봉투에서 값을 꺼낸다. 성패만 보면 `data` 가 사라진다.
#[test]
fn an_answer_carries_its_value_not_just_a_verdict() {
    let line = serde_json::json!({
        "id": "req-1", "ok": true, "data": { "a": 1 }
    })
    .to_string();
    match classify(&line).expect("분류") {
        Incoming::Answer { data, .. } => {
            assert_eq!(data["a"], 1, "답의 값이 사라졌다");
        }
        other => panic!("답이 아니다: {other:?}"),
    }
}

/// 실패한 답은 값 대신 사유를 지고 온다 — 둘을 같은 자리에 담으면 부른 쪽이 구분을 못 한다.
#[test]
fn a_failed_answer_carries_its_reason() {
    let line = serde_json::json!({
        "id": "req-2", "ok": false, "code": "NO_HOST", "message": "붙은 곳이 없다"
    })
    .to_string();
    match classify(&line).expect("분류") {
        Incoming::Answer { ok, code, message, .. } => {
            assert!(!ok);
            assert_eq!(code, "NO_HOST");
            assert!(message.contains("붙은 곳"));
        }
        other => panic!("답이 아니다: {other:?}"),
    }
}

/// 이 호스트가 cored 에 **묻고 값을 받는** 표면을 갖는다.
///
/// 없으면 앱은 저장소 값을 못 받아 자기 커넥션을 계속 든다 — 그것이 쓰기 주인이 둘이라는
/// 뜻이고, 두 프레임워크를 동시에 못 켜는 유일한 이유다.
///
/// 봉투는 밖에서 오는 요청과 같은 모양이다: `{id, method, params}`. 모양이 갈리면 cored 가
/// 같은 이름을 두 가지로 받게 되고, 그 차이는 인자 거절 한 줄로만 나타난다.
#[test]
fn a_request_envelope_carries_the_method_and_its_params() {
    let v = request_envelope("r-7", "data_get", &serde_json::json!({ "ns": "n", "coll": "c" }));
    assert_eq!(v["id"], "r-7");
    assert_eq!(v["method"], "data_get");
    assert_eq!(v["params"]["ns"], "n");
    // 창을 지목하지 않는다 — 이 요청은 창이 아니라 저장소로 간다. 지목하면 cored 가 그것을
    // 창으로 배달하려 하고, 그러면 자기 창에 물어 상한까지 침묵한다.
    assert!(v.get("window").is_none(), "저장소 요청에 창이 실렸다: {v}");
}

// ── 명령이 호스트에 닿는다 ────────────────────────────────────────────────────
//
// 부팅이 호스트를 세우고 그것을 아무 데도 안 실으면, 저장소를 위임한 프로세스의 명령은
// 물을 곳이 없어 그대로 거절된다 — 둘째 앱은 뜨지만 쓰지 못한다.
//
// 프로세스에 하나다: 이 프레임워크는 cored 에 **한 번** 붙는다. 여럿을 두면 같은 창을 든
// 호스트가 둘이 되고, cored 는 그것을 AMBIGUOUS_HOST 로 거절한다(우리가 만든 겹침이다).

/// 세우기 전에는 없다 — 없는 것을 있는 척하면 부른 쪽이 상한까지 기다린다.
#[test]
fn there_is_no_host_before_boot_stands_one_up() {
    // 이 검사는 부팅을 안 지난다. 그 상태에서 물으면 "없다"가 나와야 한다.
    assert!(current().is_none(), "부팅 전인데 호스트가 있다");
}

/// 물을 곳이 없으면 **이름을 달고** 실패한다. 조용한 실패는 "명령이 사라진다"로만 보인다.
#[test]
fn asking_without_a_host_fails_by_name() {
    let e = ask_owner("data_get", &serde_json::json!({})).expect_err("호스트가 없다");
    assert!(e.contains("cored"), "사유가 어디에 못 물었는지 말하지 않는다: {e}");
}

// ── 자리는 갈아탈 수 있어야 한다 ─────────────────────────────────────────────
//
// 자리의 규칙(한 번에 하나·죽으면 비운다·비면 요구가 다시 세운다)은 **코어가 진다** —
// 그 검사는 crates/soksak-core/src/host_slot_tests.rs 에 있다. 여기서 재는 것은 이 프레임워크가
// 그 자리에 끼우는 사실 하나뿐이다: **이 연결이 아직 살아 있는가.**
//
// RED 근거(실측 2026-08-01): cored 가 죽어도 이 호스트는 자기 죽음을 몰랐고, 죽은 연결을 든
// 채로 건네졌다. 저장소 읽기가 전부 실패했고, 그 실패를 "비어 있음"으로 적는 소비자가 사용자
// 워크스페이스를 덮었다.

use soksak_core::host_slot::Attachment;

/// 가짜 cored 하나를 세우고 그것에 붙은 호스트를 돌린다. 연결을 쥔 쪽도 함께 돌린다 —
/// 놓으면 그 순간 EOF 라 "붙어 있다"를 잴 수 없다.
fn attached_host(name: &str) -> (CoredHost, std::os::unix::net::UnixStream) {
    let dir = fixture_dir(name);
    let socket = dir.join("h.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("가짜 cored");
    let accepted = std::thread::spawn(move || listener.accept().map(|(c, _)| c).expect("연결"));
    let host = CoredHost::attach(&socket, Arc::new(SilentFacts), Arc::new(SilentExec)).expect("붙는다");
    (host, accepted.join().expect("가짜 cored 연결"))
}

/// 붙어 있는 동안은 살아 있다고 답한다.
#[test]
fn a_live_connection_says_it_is_open() {
    let (host, held) = attached_host("open-live");
    assert!(host.is_open(), "붙어 있는데 끝났다고 한다");
    drop(held);
}

/// 상대가 죽으면 **그 사실을 값으로 안다.** 모르면 죽은 연결이 산 것처럼 건네지고, 부른 쪽은
/// 매번 상한까지 기다린 뒤 사유 없이 실패한다.
#[test]
fn a_closed_connection_says_it_is_closed() {
    let (host, held) = attached_host("open-dead");
    drop(held); // cored 가 죽었다 — 받는 스레드가 EOF 를 만난다
    // 받는 스레드가 끝났다는 사실을 세울 때까지가 유일한 대기다(상한 안에서 끝나야 한다).
    let until = std::time::Instant::now() + Duration::from_secs(2);
    while host.is_open() && std::time::Instant::now() < until {
        std::thread::yield_now();
    }
    assert!(!host.is_open(), "연결이 끝났는데 살아 있다고 한다");
}

/// 규칙 — 답이 필요 없는 통보는 답을 기다리지 않는다.
///
/// 이 연결은 양방향이다: cored 가 명령을 밀고 이 프로세스가 답을 돌려준다. 그 배달을 처리하는
/// 중에 이쪽에서 답을 기다리면 서로를 기다린다 — 이 파일의 `tell` 주석이 그 사실을 이미 적어
/// 두었다("기다리면 교착한다").
///
/// `control_owner_answered` 는 부르는 쪽이 답을 안 쓴다(catalog.ts 는 `void invoke`). 그런데
/// `ask` 로 보내 상한 10 초를 기다릴 수 있었다 — 기다리면 그 시간만큼 그 창이 붙잡힌다.
mod 통보는_기다리지_않는다 {
    #[test]
    fn 주인_목록_전달은_tell_로_보낸다() {
        let source = include_str!("cored_host.rs");
        let at = source
            .find("pub fn control_owner_answered")
            .expect("control_owner_answered");
        let body = &source[at..at + 600];
        assert!(
            body.contains("tell_owner("),
            "답이 필요 없는 통보는 tell 로 보낸다 — ask 는 상한까지 기다린다"
        );
        assert!(!body.contains("ask_owner("), "이 자리는 답을 기다리지 않는다");
    }
}
