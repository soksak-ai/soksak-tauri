use super::*;
use serde_json::json;
use std::io::{BufRead, BufReader};

/// 토큰 표는 프로세스 전역이다 — 검사들이 서로를 덮지 않게 직렬로 돈다.
static SERIAL: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn pair() -> (UnixStream, BufReader<UnixStream>) {
    let (a, b) = UnixStream::pair().expect("소켓 쌍");
    (a, BufReader::new(b))
}

#[test]
fn a_frame_goes_to_the_connection_that_asked() {
    let _s = lock();
    let (a, mut rx) = pair();
    let bound = bind(&json!({ "cols": 80, "onOutput": { "__frameworkStream": "t-1" } }), &a);
    assert_eq!(bound, vec!["t-1".to_string()]);

    assert!(push("t-1", json!({ "bytes": [104, 105] })));
    let mut line = String::new();
    rx.read_line(&mut line).expect("프레임이 온다");
    let v: Value = serde_json::from_str(&line).unwrap();
    let (token, msg) = stream::read_frame(&v).expect("프레임");
    assert_eq!(token, "t-1");
    assert_eq!(msg["bytes"][1], 105);
    release_all(&bound);
}

/// 다른 연결로 밀면 토큰을 만든 쪽이 아니라 남이 받고, 받은 쪽은 버린다 — 조용한 유실.
#[test]
fn a_frame_never_goes_to_someone_elses_connection() {
    let _s = lock();
    let (a, _ra) = pair();
    let (b, mut rb) = pair();
    bind(&json!({ "on": { "__frameworkStream": "t-mine" } }), &a);
    bind(&json!({ "on": { "__frameworkStream": "t-theirs" } }), &b);

    assert!(push("t-theirs", json!(1)));
    let mut line = String::new();
    rb.read_line(&mut line).unwrap();
    assert!(line.contains("t-theirs"), "{line}");
    assert!(!line.contains("t-mine"));
    release_all(&["t-mine".into(), "t-theirs".into()]);
}

/// 짝 없는 토큰에 미는 것은 오류가 아니지만 참도 아니다 — 참이면 부른 쪽이 보냈다고 믿는다.
#[test]
fn pushing_to_an_unknown_token_is_false_not_a_panic() {
    let _s = lock();
    assert!(!push("t-none", json!(1)));
}

#[test]
fn a_call_without_a_token_binds_nothing() {
    let _s = lock();
    let (a, _r) = pair();
    assert!(bind(&json!({ "cols": 80 }), &a).is_empty());
}

/// 연결이 끝나면 그 토큰도 끝난다 — 남기면 죽은 소켓에 계속 쓴다.
#[test]
fn a_dead_connection_drops_its_token_on_the_first_failure() {
    let _s = lock();
    let (a, rx) = pair();
    bind(&json!({ "on": { "__frameworkStream": "t-dead" } }), &a);
    let before = live();
    drop(rx); // 받는 쪽이 사라졌다
    // 첫 쓰기는 성공할 수 있다(버퍼) — 실패하는 순간 놓는다는 것이 규칙이다.
    for _ in 0..200 {
        if !push("t-dead", json!({ "b": "x".repeat(4096) })) {
            assert!(live() < before, "실패한 토큰을 놓지 않았다");
            return;
        }
    }
    panic!("끊긴 연결인데 200 프레임이 전부 성공했다");
}

#[test]
fn releasing_a_token_is_idempotent() {
    let _s = lock();
    let (a, _r) = pair();
    bind(&json!({ "on": { "__frameworkStream": "t-rel" } }), &a);
    assert!(release("t-rel"));
    assert!(!release("t-rel"));
    assert!(!push("t-rel", json!(1)));
}
