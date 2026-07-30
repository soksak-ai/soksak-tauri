// 데몬 몸의 검사 — 규칙은 lib.rs 가, 그 증명은 여기가 진다.
//
// 프레임워크를 안 띄운다: 스폰과 그룹 킬은 OS 의 일이고, 사건 통로는 주입이라 심은 싱크로 잰다.
use super::*;

#[test]
fn 링버퍼는_상한을_넘으면_앞에서_버린다() {
    let mut r = VecDeque::new();
    for i in 0..10 {
        ring_push(&mut r, format!("l{i}"), 3);
    }
    assert_eq!(r.len(), 3);
    assert_eq!(r.front().unwrap(), "l7");
    assert_eq!(r.back().unwrap(), "l9");
}

#[test]
fn 백오프는_지수이고_상한이_있다() {
    assert_eq!(backoff_secs(0), 1);
    assert_eq!(backoff_secs(1), 2);
    assert_eq!(backoff_secs(3), 8);
    assert_eq!(backoff_secs(4), 16);
    assert_eq!(backoff_secs(99), 16);
}

#[test]
fn reap_은_명령줄이_대조될_때만_참이다() {
    assert!(reap_matches("node /x/y/vite dev", "node server.js"));
    assert!(!reap_matches("vim", "node server.js"));
    assert!(!reap_matches("", "node server.js"));
    assert!(reap_matches(
        "docker compose up postgres",
        "docker compose up postgres"
    ));
}

// S2 — daemon_run_once is the spawn bridge the core release commands ride: the release summary
// is a multi-KB single line, and release.publish needs a token in the child env.
#[cfg(unix)]
#[test]
fn 대용량_단일_라인은_온전히_캡처된다() {
    // BufRead::lines has no per-line cap; RING_CAP bounds line COUNT (keeps the last 500), so
    // the trailing summary line survives intact — no truncation of a multi-KB release.json.
    let out = daemon_run_once(
        "/tmp".into(),
        "head -c 50000 /dev/zero | tr '\\0' X".into(),
        Some(10),
        None,
    )
    .expect("run");
    let lines = out["lines"].as_array().expect("lines");
    assert!(
        lines.iter().any(|l| l
            .as_str()
            .map(|s| s.len() == 50000 && s.bytes().all(|b| b == b'X'))
            .unwrap_or(false)),
        "a 50000-char single line must be captured intact"
    );
}

#[cfg(unix)]
#[test]
fn env_는_자식에만_주입된다() {
    // release.publish's GH_TOKEN path — injected into the child, never the parent/trace.
    let mut env = HashMap::new();
    env.insert("SOKSAK_TEST_ENV".to_string(), "injected-marker-xyz".to_string());
    let out = daemon_run_once(
        "/tmp".into(),
        "printf %s \"$SOKSAK_TEST_ENV\"".into(),
        Some(10),
        Some(env),
    )
    .expect("run");
    let lines = out["lines"].as_array().expect("lines");
    assert!(
        lines
            .iter()
            .any(|l| l.as_str().map(|s| s.contains("injected-marker-xyz")).unwrap_or(false)),
        "the injected env var must reach the child"
    );
    assert!(std::env::var("SOKSAK_TEST_ENV").is_err(), "must not leak into the parent env");
}

// 셸은 인자로 받은 경로다 — 프로세스 환경(SHELL)을 다시 읽지 않는다. 가짜 셸을 만들어
// 넘기고, 그 표식이 자식 출력에 찍히는지로 확인한다(환경에는 이 경로가 없다).
#[cfg(unix)]
#[test]
fn 셸은_인자로_받은_경로다() {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("soksak-daemon-spawn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let fake = dir.join("fake-shell");
    std::fs::write(&fake, "#!/bin/sh\nprintf FAKE-SHELL\nexec /bin/sh \"$@\"\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut child = spawn_shell(
        &fake.to_string_lossy(),
        "/tmp",
        "printf ' and the command'",
        None,
    )
    .expect("spawn");
    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(
        out, "FAKE-SHELL and the command",
        "주어진 셸이 명령을 돌려야 한다"
    );
}

#[cfg(unix)]
#[test]
fn 스폰_그룹킬_수명() {
    // 손자를 낳는 셸 명령 — 그룹 킬이 트리 전체를 회수하는지.
    let child = spawn_shell(&login_shell(), "/tmp", "sleep 30 & sleep 30", None).expect("spawn");
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    std::thread::sleep(std::time::Duration::from_millis(200));
    kill_group(&child, true);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let mut c = child.lock().unwrap();
    assert!(
        c.try_wait().expect("wait").is_some(),
        "본체가 종료되어야 한다"
    );
    // 그룹의 다른 구성원(sleep 손자)도 종료되었는지 — pgid 로 신호 0 확인.
    unsafe {
        assert_ne!(libc::killpg(pid as i32, 0), 0, "그룹이 비어야 한다");
    }
}
