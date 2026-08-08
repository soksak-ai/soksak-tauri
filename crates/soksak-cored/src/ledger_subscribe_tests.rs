// 원장 구독 — **적힌 순간에** 흘려보낸다.
//
// 부팅 뒤에 적히는 사실을 밖에서 읽으려면 그때까지 기다려야 한다. 되물어 확인하면 그 주기가
// 곧 오차이고, 부팅을 재는 자리에서는 재는 대상만큼 큰 오차다.
//
// 실측 2026-08-08: CLI 는 이 통로를 이미 광고하고 있었는데(`sok events`, 도움말에 JSONL 푸시
// 스트림이라고 적혀 있다) 데몬이 그 이름을 몰라 구독 요청이 UNKNOWN_COMMAND 로 돌아왔다.
// 광고된 기능이 한 번도 동작하지 않았고, 그래서 하니스마다 되묻기를 다시 지었다.
use super::ledger;
use std::sync::{Arc, Mutex};

/// 원장에 항목 하나가 적힌 상황. 여기서 재는 것은 **구독 명부**다 — 디스크 쓰기는 저장소가
/// 소유하고, 그것이 실패하면 이 자리에 오지도 못한다(`persist(...)?` 가 먼저 돌아간다).
fn admitted(kind: &str) {
    ledger::fan_out(&serde_json::json!({
        "seq": 1, "ts": 0, "kind": kind, "source": "boot", "payload": { "step": "x" },
    }));
}

fn sink() -> (Arc<Mutex<Vec<String>>>, Box<dyn Fn(&str) -> bool + Send + Sync>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mine = Arc::clone(&seen);
    (seen, Box::new(move |line: &str| {
        mine.lock().unwrap().push(line.to_string());
        true
    }))
}

#[test]
fn 구독자는_적힌_항목을_받는다() {
    let (seen, write) = sink();
    ledger::subscribe(9001, Vec::new(), write);
    admitted("boot.step");
    let lines = seen.lock().unwrap().clone();
    ledger::unsubscribe(9001);
    assert_eq!(lines.len(), 1, "적힌 항목이 구독자에게 안 갔다");
    assert!(lines[0].contains("boot.step"), "{}", lines[0]);
}

#[test]
fn 종류를_고른_구독자는_그것만_받는다() {
    let (seen, write) = sink();
    ledger::subscribe(9002, vec!["boot.step".to_string()], write);
    admitted("command.executed");
    admitted("boot.step");
    let lines = seen.lock().unwrap().clone();
    ledger::unsubscribe(9002);
    assert_eq!(lines.len(), 1, "고르지 않은 종류까지 갔다: {lines:?}");
    assert!(lines[0].contains("boot.step"));
}

// 죽은 소켓에 계속 쓰면 그 실패가 매 항목마다 반복되고, 아무도 그것을 안 본다.
#[test]
fn 쓰기가_실패한_구독자는_명부에서_빠진다() {
    ledger::subscribe(9003, Vec::new(), Box::new(|_| false));
    let before = ledger::subscriber_count();
    admitted("boot.step");
    assert!(ledger::subscriber_count() < before, "실패한 구독자가 남아 있다");
}

// 같은 연결이 다시 구독하면 조건을 갈아끼운다 — 두 벌이 되면 같은 줄이 두 번 간다.
#[test]
fn 같은_연결의_재구독은_두_벌이_되지_않는다() {
    let (seen, write) = sink();
    ledger::subscribe(9004, Vec::new(), write);
    let (_, again) = sink();
    ledger::subscribe(9004, Vec::new(), again);
    admitted("boot.step");
    let first = seen.lock().unwrap().len();
    ledger::unsubscribe(9004);
    assert_eq!(first, 0, "옛 구독이 살아남아 같은 줄을 또 받았다");
}
