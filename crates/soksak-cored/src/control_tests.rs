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

/// 답이 **주인의 것이면 한 곳에만** 간다.
///
/// 오케스트레이터는 앱마다 하나라 같은 이름을 둘이 드는 것이 정상이고, 창-지역 명령은 둘 다
/// 돌아야 한다. 그러나 주인이 답하는 명령까지 전부에게 가면 **같은 일이 두 번 돈다** — 실측
/// 2026-08-01: `data.kv.set` 이 두 프로세스에서 각각 실행됐다. 어느 쪽인지는 명령 자신이 알고
/// (`CommandSpec.windowScoped`), 창이 그것을 신고한다.
#[test]
fn an_owner_answered_command_runs_once() {
    let _serial = lock_serial();
    detach();
    let mut first = fake_host(&["main"], "main");
    let mut second = fake_host(&["main"], "main");
    note_owner_answered(&["data.kv.set".to_string()]);

    let _ = answer(r#"{"id":41,"method":"data.kv.set","window":"main","timeoutMs":150}"#);
    // 한 쪽만 받는다. 어느 쪽인지는 정하지 않는다 — 답이 같으므로 고르는 것이 규칙이 아니다.
    // 한 쪽만 받는다. 어느 쪽이 받았는지는 정하지 않는다 — 답이 같으므로 고르는 것이 규칙이
    // 아니다. 그래서 "첫째가 받았으면 둘째는 못 받는다"로 잰다.
    let mut line = String::new();
    first.read_line(&mut line).expect("한 쪽은 받는다");
    nothing_arrives(&mut second, "둘째 호스트");
    detach();
}

/// 신고받지 않은 이름은 **창의 것**으로 본다 — 안전한 쪽이 기본이다.
#[test]
fn an_unreported_command_still_goes_to_both() {
    let _serial = lock_serial();
    detach();
    let mut first = fake_host(&["main"], "main");
    let mut second = fake_host(&["main"], "main");

    let _ = answer(r#"{"id":42,"method":"ui.something","window":"main","timeoutMs":150}"#);
    for (h, who) in [(&mut first, "첫째"), (&mut second, "둘째")] {
        let mut line = String::new();
        h.read_line(&mut line).unwrap_or_else(|e| panic!("{who} 호스트가 못 받았다: {e}"));
    }
    detach();
}

/// 같은 이름을 둘이 들면 **둘 다에게 간다.**
///
/// `main` 은 오케스트레이터 역할이라 앱 프로세스마다 하나씩 있다 — 겹치는 것이 정상이다.
/// 그때 거절하면 두 앱을 함께 켠 순간 **어느 쪽 오케스트레이터도 밖에서 부를 수 없다**
/// (실측 2026-08-01: Tauri·Electron 을 같은 홈에 함께 띄우자 저장소 조회조차 막혔다).
///
/// 고르지 않는다는 판단은 옳았지만 결론이 틀렸다: 고를 수 없으면 **전부에게 보내고 전부의
/// 답을 돌린다.** 하나만 원하는 부름은 유일한 주소(`w-<uuid>`)를 쓰면 된다.
#[test]
fn a_label_two_hosts_both_claim_goes_to_both() {
    let _serial = lock_serial();
    detach();
    let mut first = fake_host(&["main"], "main");
    let mut second = fake_host(&["main"], "main");

    // 답은 안 온다(가짜 호스트는 회신하지 않는다) — 재는 것은 **어디로 갔는가**다.
    let _ = answer(r#"{"id":31,"method":"x","window":"main","timeoutMs":150}"#);
    for (h, who) in [(&mut first, "첫째"), (&mut second, "둘째")] {
        let mut line = String::new();
        h.read_line(&mut line).unwrap_or_else(|e| panic!("{who} 호스트가 못 받았다: {e}"));
        let v: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(v["deliver"]["window"], "main", "{who}");
    }
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


/// 같은 라벨을 두 호스트가 들면 **둘로 보여야 한다.** 합쳐서 하나로 답하면 부른 쪽은 창이
/// 하나라고 읽고, 그 위에 세운 판단이 전부 틀린다(어느 창인지 못 고르는 것과, 창이 하나인
/// 것은 다른 사실이다).
///
/// 실측 배경: 창 복원은 라벨을 새로 만들지 않고 저장된 `w-<uuid>` 를 되쓴다. 한 홈을 두
/// 프레임워크가 보면 같은 슬롯을 각자 되살려 라벨이 겹친다.
#[test]
fn a_label_two_hosts_hold_is_reported_as_two() {
    let _serial = lock_serial();
    detach();
    let a = fake_host(&["w-shared", "w-only-a"], "w-shared");
    let b = fake_host(&["w-shared"], "w-shared");

    let seen = super::window_census();
    let shared = seen
        .iter()
        .find(|w| w.label == "w-shared")
        .expect("겹친 라벨이 목록에 있다");
    assert_eq!(shared.hosts, 2, "겹침이 수로 보여야 한다: {shared:?}");

    let only = seen.iter().find(|w| w.label == "w-only-a").expect("단독 라벨");
    assert_eq!(only.hosts, 1, "{only:?}");

    drop((a, b));
    detach();
}

/// 저장소 변경은 **붙은 호스트 전부**에 간다 — 알림의 주인은 저장소의 주인과 같다(A22).
///
/// RED 근거(실측 2026-08-01): 저장소 소유는 cored 로 옮겼는데 알림은 프레임워크가 자기 창에만
/// 뿌리고 있었다(`app.emit("data-change")`). 그러면 같은 홈을 보는 다른 프레임워크는 자기가 든
/// 옛 값을 진실로 알고, 다음 저장에서 상대의 변경을 **덮는다** — 그 손실은 오류로 보이지 않는다.
/// Electron 쪽에는 뿌리는 코드가 아예 없었다.
///
/// 쓰기 자체는 저장소를 열어야 하므로 여기서는 그 사실을 담는 값(`Changed`)으로 잰다 — 쓴 쪽이
/// 어디든 그 사실이 이 자리를 지나 모든 호스트에 닿는지가 이 검사의 축이다. 값을 안 내놓는
/// 길은 `with_write` 의 시그니처가 막고, 그 문을 안 지나는 쓰기는 게이트가 센다.
#[test]
fn a_data_change_reaches_every_host() {
    let _serial = lock_serial();
    detach();
    let mut tauri_like = fake_host(&["w-t"], "w-t");
    let mut electron_like = fake_host(&["w-e"], "w-e");

    crate::ctx::Changed::one("core", None, None, "kv-set", Some("settings".into())).announce();

    for (r, who) in [(&mut tauri_like, "첫째"), (&mut electron_like, "둘째")] {
        let mut line = String::new();
        r.read_line(&mut line)
            .unwrap_or_else(|e| panic!("{who} 호스트가 데이터 변경을 받는다: {e}"));
        let v: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(v["broadcast"]["event"], "data-change", "{who}");
        // 페이로드 모양은 프레임워크가 뿌리는 것과 같아야 한다 — 구독자는 출처를 모른다.
        assert_eq!(v["broadcast"]["payload"]["ns"], "core", "{who}");
        assert_eq!(v["broadcast"]["payload"]["op"], "kv-set", "{who}");
        assert_eq!(v["broadcast"]["payload"]["id"], "settings", "{who}");
    }
    detach();
}

/// 규칙 — 붙음은 기다릴 수 있어야 한다.
///
/// cored 는 호스트 등록부를 갖고 있어 "붙었는가" 를 안다. 그런데 그 사실이 바뀔 때를 기다릴
/// 자리가 없어서, 부르는 쪽이 0.1 초마다 되묻는 폴링밖에 못 했다 — 실측 2026-08-08: 재시작
/// 대기가 활동 로그를 그 질문으로 도배했다.
///
/// 아는 쪽이 알려준다. 이 스위트는 대기 자체만 잰다 — 진짜 연결을 지어내면 등록부가 그 가짜를
/// 배달 대상으로 들게 되므로, 등록은 실제 경로(attach_host)가 소유한다.
mod 붙음_대기 {
    use super::super::*;
    use std::time::{Duration, Instant};

    /// 이 스위트는 **대기 자체**만 잰다. 등록부는 프로세스 전역이라 다른 테스트가 호스트를
    /// 붙여 두면 "안 붙음" 을 전제할 수 없다 — 그 전제를 쓰면 단독 실행과 전체 실행이 다른
    /// 답을 낸다(실측 2026-08-08: 내가 그 전제를 써서 전체 실행에서만 두 건이 깨졌다).
    /// 그래서 붙은 상태에서도 참인 사실만 단언한다.
    #[test]
    fn 이미_붙었으면_기다리지_않는다() {
        if !has_host() {
            return; // 붙은 게 없으면 이 사실은 이 실행에서 잴 수 없다.
        }
        let started = Instant::now();
        assert!(wait_for_host(Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_millis(200), "이미 붙었으면 기다리지 않는다");
    }

    #[test]
    fn 상한을_넘겨_기다리지_않는다() {
        let started = Instant::now();
        let attached = wait_for_host(Duration::from_millis(150));
        // 붙었으면 즉시, 안 붙었으면 상한까지 — 어느 쪽이든 상한을 넘기지 않는다.
        assert!(started.elapsed() < Duration::from_secs(2));
        if !attached {
            assert!(started.elapsed() >= Duration::from_millis(150), "상한 전에 포기하지 않는다");
        }
    }

    #[test]
    fn 상한이_0_이면_지금_사실만_답한다() {
        let started = Instant::now();
        let attached = wait_for_host(Duration::from_millis(0));
        assert_eq!(attached, has_host(), "0 은 기다리지 않고 지금 사실을 답한다");
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}

/// 붙음 대기는 명령으로 노출된다 — 부르는 쪽(하니스·Makefile)이 폴링 대신 그것을 기다린다.
mod 붙음_대기_명령 {
    use crate::registry;

    #[test]
    fn 이름이_서빙_목록에_있다() {
        assert!(registry::find("host_wait").is_some(), "cored 가 host_wait 를 서빙한다");
    }

    #[test]
    fn 상한을_인자로_받는다() {
        let spec = registry::find("host_wait").expect("host_wait");
        assert!(spec.args.iter().any(|a| a.name == "timeoutMs"), "상한은 부르는 쪽이 정한다");
    }
}
