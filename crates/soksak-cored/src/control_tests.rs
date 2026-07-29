// 제어면 배선 — 규칙은 코어가 검증한다. 여기는 **배달과 회신**이 실제로 오가는지만 본다.
use super::*;
use std::io::BufRead;

use super::testing::{detach, fake_host, fake_host_id, lock as lock_serial, nothing_arrives};



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
    let (id, _h) = fake_host_id(&["main"], "main");
    assert!(update_windows(id, vec!["main".into(), "w-9".into()], "w-9".into()));
    let r = answer(r#"{"id":6,"method":"x","window":"w-9","timeoutMs":50}"#);
    // 배달까지 갔다는 뜻 — 없는 창이었다면 WINDOW_NOT_FOUND 였다.
    assert_eq!(r["code"], "TIMEOUT");
    detach();
}

/// 붙지 않은 연결의 창 보고는 받지 않는다 — 받으면 장부에 주인 없는 창이 생기고, 그 창으로
/// 간 배달은 밀 곳이 없어 DELIVER_FAILED 가 된다.
#[test]
fn a_report_from_a_connection_that_is_not_a_host_is_refused() {
    let _serial = lock_serial();
    detach();
    assert!(!update_windows(0, vec!["main".into()], "main".into()));
}

// ── 창 호스트는 여럿이다 ───────────────────────────────────────────────────────
//
// 저장소를 쓰는 주인은 하나여야 한다(단일 쓰기). 그런데 프레임워크는 둘이 동시에 돈다.
// 그 둘을 세우는 방법은 하나뿐이다 — **같은 cored 에 창 호스트로 둘 다 붙는다**. 그러면
// 쓰기 주인은 여전히 하나고, 창을 가진 쪽만 둘이다.
//
// 호스트를 한 자리로 두면 둘째가 붙는 순간 첫째의 창이 장부에서 사라진다. 사라진 창은
// 오류를 내지 않는다 — 그냥 "창 없음"이 되어, 멀쩡히 떠 있는 창에 명령이 닿지 않는다.

/// 둘째가 붙어도 첫째의 창은 첫째에게 배달된다.
#[test]
fn a_second_host_does_not_evict_the_first() {
    let _serial = lock_serial();
    detach();
    let mut first = fake_host(&["w-t"], "w-t");
    let mut second = fake_host(&["w-e"], "w-e");

    std::thread::spawn(|| {
        let _ = answer(r#"{"id":11,"method":"x","window":"w-t","timeoutMs":300}"#);
    });
    let mut line = String::new();
    first.read_line(&mut line).expect("첫째 호스트가 자기 창의 배달을 받는다");
    let v: Value = serde_json::from_str(&line).expect("json");
    assert_eq!(v["deliver"]["window"], "w-t");

    // 남의 창 배달이 이쪽으로 새면 두 프레임워크가 서로의 명령을 실행한다.
    nothing_arrives(&mut second, "둘째 호스트");
    detach();
}

/// 창 목록은 호스트들의 **합집합**이다 — 어느 쪽 창이든 이름으로 지목된다.
#[test]
fn every_hosts_windows_are_addressable() {
    let _serial = lock_serial();
    detach();
    let _first = fake_host(&["w-t"], "w-t");
    let mut second = fake_host(&["w-e"], "w-e");

    std::thread::spawn(|| {
        let _ = answer(r#"{"id":12,"method":"x","window":"w-e","timeoutMs":300}"#);
    });
    let mut line = String::new();
    second.read_line(&mut line).expect("둘째 호스트의 창도 주소가 된다");
    let v: Value = serde_json::from_str(&line).expect("json");
    assert_eq!(v["deliver"]["window"], "w-e");
    detach();
}

/// 연결이 끝나면 그 호스트는 장부에서 나간다.
///
/// 회수가 없으면 죽은 호스트가 `has_host()` 를 참으로 유지한다. 그러면 서빙하지 않는 이름이
/// `UNKNOWN_COMMAND` 대신 배달로 가고, 배달은 죽은 소켓에서 상한까지 침묵한다 — 부른 쪽에는
/// "명령이 사라진다"로만 보인다. 호스트가 여럿이면 더 나쁘다: 죽은 행이 산 행을 가린다.
#[test]
fn a_closed_connection_takes_its_host_out_of_the_ledger() {
    let _serial = lock_serial();
    detach();
    let (id, _h) = fake_host_id(&["w-t"], "w-t");
    assert!(has_host(), "붙었다");

    detach_host(id);
    assert!(!has_host(), "연결이 끝나면 배달할 곳이 없다");
    // 창 사실도 함께 나간다 — 남으면 없는 창이 주소로 남는다.
    let r = answer(r#"{"id":13,"method":"x","window":"w-t","timeoutMs":50}"#);
    assert_eq!(r["code"], "NO_HOST");
}

/// 하나가 끊겨도 나머지는 계속 서빙한다.
#[test]
fn one_host_leaving_does_not_take_the_others_windows() {
    let _serial = lock_serial();
    detach();
    let (gone, _a) = fake_host_id(&["w-t"], "w-t");
    let mut stays = fake_host(&["w-e"], "w-e");

    detach_host(gone);
    assert!(has_host(), "남은 호스트가 있다");
    assert_eq!(
        answer(r#"{"id":14,"method":"x","window":"w-t","timeoutMs":50}"#)["code"],
        "WINDOW_NOT_FOUND",
        "떠난 호스트의 창은 주소가 아니다"
    );

    std::thread::spawn(|| {
        let _ = answer(r#"{"id":15,"method":"x","window":"w-e","timeoutMs":300}"#);
    });
    let mut line = String::new();
    stays.read_line(&mut line).expect("남은 호스트는 계속 받는다");
    let v: Value = serde_json::from_str(&line).expect("json");
    assert_eq!(v["deliver"]["window"], "w-e");
    detach();
}

/// 방송은 주인 없는 사실이다 — 창을 가진 쪽 **전부**가 받아야 한다. 하나만 받으면
/// 나머지 프레임워크의 창은 파일이 바뀐 줄 모르고 낡은 화면을 계속 보여 준다.
#[test]
fn a_broadcast_reaches_every_host() {
    let _serial = lock_serial();
    detach();
    let mut first = fake_host(&["w-t"], "w-t");
    let mut second = fake_host(&["w-e"], "w-e");

    assert!(broadcast("file.changed", json!({ "path": "/p" })));
    for (r, who) in [(&mut first, "첫째"), (&mut second, "둘째")] {
        let mut line = String::new();
        r.read_line(&mut line).unwrap_or_else(|e| panic!("{who} 호스트가 방송을 받는다: {e}"));
        let v: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(v["broadcast"]["event"], "file.changed", "{who}");
    }
    detach();
}

