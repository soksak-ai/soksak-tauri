// 창 오라클 계약 — "지금 어떤 창이 살아 있는가"와 "그 창에 사건을 보낸다".
//
// 셸과 스트림 출구에 한 것과 같은 이유로 이것도 계약 뒤에 둔다. 지금 두 능력은
// `tauri::AppHandle` 의 메서드다(`windows()`, `emit_to()`). 그래서 이 둘만 필요한 로직도
// AppHandle 을 인자로 받게 되고, AppHandle 을 받는 순간 그 함수는 앱 프로세스를 떠날 수
// 없다 — 분리 분류(2026-07-27, 핸들러 160 전수)가 짚은 두 선결 seam 중 하나가 이것이다.
//
// 계약은 두 줄이다:
//   ① 살아 있는 창 라벨 목록. 폴백 사다리는 이 집합 **위에서만** 걷는다 — 죽은 포커스
//      기록으로 사다리를 걸으면 없는 창에 명령을 보내고 조용히 잃는다.
//   ② 라벨로 사건 배달. 성공 여부를 값으로 돌린다 — 배달 실패를 삼키면 호출자가
//      "보냈다"고 믿고 응답을 영원히 기다린다.
//
// 정책은 여기 없다. 어느 창을 고를지(폴백 사다리)는 호출자의 것이고, 오라클은 사실만
// 말한다. 오라클이 선택까지 하면 구현마다 사다리가 갈라지고, 갈라진 사다리는 창마다 다른
// 라우팅이 된다.

use serde_json::Value;

/// 창 사실의 출처. 구현은 호스트마다 하나다.
pub(crate) trait WindowOracle: Send + Sync {
    /// 살아 있는 창 라벨 — 순서는 보장하지 않는다.
    fn live_labels(&self) -> Vec<String>;
    /// 그 라벨의 창이 지금 살아 있는가.
    fn is_live(&self, label: &str) -> bool {
        self.live_labels().iter().any(|l| l == label)
    }
    /// 라벨로 사건 배달. 실패(창 없음·직렬화 실패)는 false 로 돌린다 — 삼키지 않는다.
    fn emit_to(&self, label: &str, event: &str, payload: Value) -> bool;
    /// 라벨을 고르지 않는 배달 — 활동 원장처럼 "누구에게"가 없는 사건. 기본은 살아 있는
    /// 창 전부로의 배달이고, 호스트가 한 번에 닿는 경로를 알면 그것으로 대체한다.
    /// 반환 = 전부에게 닿았는가. 일부만 닿은 것을 true 로 올리면 유실이 성공으로 위장된다.
    fn broadcast(&self, event: &str, payload: Value) -> bool {
        let mut all = true;
        for label in self.live_labels() {
            if !self.emit_to(&label, event, payload.clone()) {
                all = false;
            }
        }
        all
    }
}

/// Tauri 호스트 — 현 정본 구현.
impl WindowOracle for tauri::AppHandle {
    fn live_labels(&self) -> Vec<String> {
        tauri::Manager::windows(self).keys().cloned().collect()
    }

    fn is_live(&self, label: &str) -> bool {
        tauri::Manager::get_window(self, label).is_some()
    }

    fn emit_to(&self, label: &str, event: &str, payload: Value) -> bool {
        tauri::Emitter::emit_to(self, label, event, payload).is_ok()
    }

    fn broadcast(&self, event: &str, payload: Value) -> bool {
        // 창 목록을 걷지 않는다 — Tauri 의 emit 은 자식 웹뷰까지 닿는 한 번의 배달이라
        // 라벨 순회로 바꾸면 받는 쪽이 줄어든다.
        tauri::Emitter::emit(self, event, payload).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 계약만 구현한 테스트 오라클 — Tauri 없이 라우팅 로직을 검증할 수 있어야 한다.
    /// (이 테스트가 컴파일된다는 사실 자체가 "창 사실은 벤더 타입이 아니다"의 증명이다.)
    struct Fake {
        labels: Vec<String>,
        sent: Mutex<Vec<(String, String)>>,
    }

    impl WindowOracle for Fake {
        fn live_labels(&self) -> Vec<String> {
            self.labels.clone()
        }
        fn emit_to(&self, label: &str, event: &str, _payload: Value) -> bool {
            if !self.is_live(label) {
                return false; // 없는 창으로의 배달은 실패다 — 성공으로 위장하지 않는다
            }
            self.sent
                .lock()
                .unwrap()
                .push((label.to_string(), event.to_string()));
            true
        }
    }

    fn fake(labels: &[&str]) -> Fake {
        Fake {
            labels: labels.iter().map(|s| s.to_string()).collect(),
            sent: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn is_live_defaults_to_the_label_set() {
        let o = fake(&["main", "w-1"]);
        assert!(o.is_live("w-1"));
        assert!(!o.is_live("w-2"));
    }

    #[test]
    fn delivery_to_a_dead_window_reports_failure() {
        let o = fake(&["main"]);
        assert!(o.emit_to("main", "cmd-request", Value::Null));
        // 삼키면 호출자가 응답을 영원히 기다린다.
        assert!(!o.emit_to("w-gone", "cmd-request", Value::Null));
        assert_eq!(o.sent.lock().unwrap().len(), 1);
    }

    /// 배달이 전부 실패하는 창 — 부분 실패가 성공으로 위장되지 않는지 본다.
    struct Deaf;
    impl WindowOracle for Deaf {
        fn live_labels(&self) -> Vec<String> {
            vec!["main".to_string()]
        }
        fn emit_to(&self, _label: &str, _event: &str, _payload: Value) -> bool {
            false
        }
    }

    #[test]
    fn a_broadcast_defaults_to_every_live_window() {
        let o = fake(&["main", "w-a"]);
        assert!(o.broadcast("activity", Value::Null));
        let sent = o.sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|(_, e)| e == "activity"));
    }

    #[test]
    fn a_broadcast_that_missed_a_window_reports_failure() {
        assert!(!Deaf.broadcast("activity", Value::Null));
    }

    #[test]
    fn an_oracle_needs_no_shell_type() {
        // 라우팅을 오라클 하나로 검증한다 — AppHandle 없이.
        let o = fake(&["main", "w-a", "w-b"]);
        let live = o.live_labels();
        assert_eq!(live.len(), 3);
        assert!(live.contains(&"w-a".to_string()));
    }
}
