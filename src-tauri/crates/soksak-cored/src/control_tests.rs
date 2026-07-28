// 제어면 배선 — 규칙은 코어가 검증한다. 여기는 **배달과 회신**이 실제로 오가는지만 본다.
use super::*;
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixStream;

use super::testing::{detach, lock as lock_serial};

/// 창 호스트를 흉내낸다 — 한쪽 끝을 cored 에 주고, 다른 끝에서 push 를 읽는다.
fn fake_host(live: &[&str], focused: &str) -> BufReader<UnixStream> {
    let (a, b) = UnixStream::pair().expect("소켓 쌍");
    attach_host(a, live.iter().map(|s| s.to_string()).collect(), focused.to_string());
    BufReader::new(b)
}


#[test]
fn without_a_host_there_is_nowhere_to_deliver() {
    let _serial = lock_serial();
    detach();
    let r = answer(r#"{"id":1,"method":"project.open"}"#);
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NO_HOST");
    assert_eq!(r["id"], 1, "상관 id 를 그대로 돌려준다");
}

#[test]
fn a_broken_line_is_answered_not_dropped() {
    let _serial = lock_serial();
    detach();
    let r = answer("{ 아니다");
    assert_eq!(r["code"], "BAD_REQUEST");
    assert!(r["message"].as_str().unwrap().contains("JSON"));
}

#[test]
fn a_named_window_that_is_not_alive_is_refused() {
    let _serial = lock_serial();
    let _h = fake_host(&["main", "w-1"], "main");
    let r = answer(r#"{"id":2,"method":"x","window":"nope"}"#);
    assert_eq!(r["code"], "WINDOW_NOT_FOUND");
    assert!(r["message"].as_str().unwrap().contains("nope"));
    detach();
}

/// 배달은 **밀린다** — 폴링이 아니다. 그리고 인자 모양이 그대로 간다(번역하지 않는다).
#[test]
fn a_request_is_pushed_to_the_host_with_the_resolved_target() {
    let _serial = lock_serial();
    let mut h = fake_host(&["main", "w-1", "w-2"], "w-2");
    std::thread::spawn(|| {
        let _ = answer(r#"{"id":3,"method":"project.open","params":{"root":"/p"},"timeoutMs":300}"#);
    });
    let mut line = String::new();
    h.read_line(&mut line).expect("push 를 받는다");
    let v: Value = serde_json::from_str(&line).expect("json");
    assert_eq!(v["deliver"]["method"], "project.open");
    assert_eq!(v["deliver"]["params"]["root"], "/p");
    // 포커스된 창이 답한다 — 코어 규칙 그대로.
    assert_eq!(v["deliver"]["window"], "w-2");
    detach();
}

/// 회신이 그 요청과 짝지어져 돌아온다.
#[test]
fn the_reply_travels_back_to_the_caller() {
    let _serial = lock_serial();
    let mut h = fake_host(&["main"], "main");
    let t = std::thread::spawn(|| answer(r#"{"id":4,"method":"x","timeoutMs":2000}"#));
    let mut line = String::new();
    h.read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    let id = v["deliver"]["id"].as_u64().expect("배달 id 는 앱과 같은 u64 축이다");

    assert!(deliver_result(id, json!({ "ok": true, "data": { "seen": true } })));
    let out = t.join().unwrap();
    assert_eq!(out["ok"], true);
    assert_eq!(out["data"]["seen"], true);
    assert_eq!(out["id"], 4, "하니스가 준 id 로 돌아온다");
    detach();
}

/// 상한이 없으면 답하지 않는 창 하나가 그 연결을 영원히 붙잡는다.
#[test]
fn no_reply_ends_with_a_named_timeout() {
    let _serial = lock_serial();
    let mut h = fake_host(&["main"], "main");
    let t = std::thread::spawn(|| answer(r#"{"id":5,"method":"x","timeoutMs":80}"#));
    let mut line = String::new();
    h.read_line(&mut line).unwrap(); // 밀린 것만 읽고 회신하지 않는다
    let out = t.join().unwrap();
    assert_eq!(out["code"], "TIMEOUT");
    assert!(out["message"].as_str().unwrap().contains("x"));
    detach();
}

/// 짝 없는 회신은 버린다 — 이미 상한에서 끝난 늦은 회신은 오류가 아니다.
#[test]
fn a_late_reply_is_dropped_not_an_error() {
    let _serial = lock_serial();
    detach();
    assert!(!deliver_result(9_999_999, json!({ "ok": true })));
}

/// 창 사실이 바뀌면 호스트가 알려 준다 — 낡은 목록으로 고르면 죽은 창에 배달한다.
#[test]
fn the_host_can_update_the_window_facts() {
    let _serial = lock_serial();
    let _h = fake_host(&["main"], "main");
    assert!(update_windows(vec!["main".into(), "w-9".into()], "w-9".into()));
    let r = answer(r#"{"id":6,"method":"x","window":"w-9","timeoutMs":50}"#);
    // 배달까지 갔다는 뜻 — 없는 창이었다면 WINDOW_NOT_FOUND 였다.
    assert_eq!(r["code"], "TIMEOUT");
    detach();
}

#[test]
fn updating_without_a_host_says_so() {
    let _serial = lock_serial();
    detach();
    assert!(!update_windows(vec!["main".into()], "main".into()));
}
