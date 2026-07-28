// 활동 발행 계약 — "무슨 일이 있었다"를 원장에 남기는 한 점.
//
// 프레임워크(AppFramework)·스트림 출구(StreamSink)·창 사실(WindowOracle)에 한 것과 같은 이유로
// 이것도 계약 뒤에 둔다. 지금 `activity::publish` 는 `&AppHandle` 을 받아 그 안에서
// `state::<ActivityHub>()` 로 허브를 꺼내고, `app.emit("activity", …)` 로 창에 밀고,
// `state::<DbState>()` 로 영속한다. 그래서 **원장에 한 줄 남기고 싶을 뿐인 함수까지
// AppHandle 을 인자로 받게 되고**, 받는 순간 그 함수는 앱 프로세스를 떠날 수 없다.
//
// 분리 분류(2026-07-27, 핸들러 160 전수)가 이것을 파급 1위로 짚었다: 네이티브로 분류된
// 몇몇 핸들러조차 AppHandle 을 쥔 이유가 오직 publish 였다. 호출 지점은 22곳(pty 8·
// webview 4·webview_health 4·service 3·lib 2·ipc 1)이다.
//
// 계약은 한 줄이다: 사건 하나를 발행하고 기록된 항목을 돌려준다. 어디로 부채질할지
// (창 emit·소켓 구독자·영속)는 구현의 몫이며, 발행자는 그것을 알지 않는다.

use serde_json::Value;

/// 활동 원장의 도착지. 구현은 호스트마다 하나다.
pub(crate) trait ActivitySink: Send + Sync {
    /// 사건 하나를 발행하고 기록된 항목(seq·ts 포함)을 돌려준다.
    fn publish(&self, kind: &str, source: &str, payload: Value) -> Value;
}

/// Tauri 호스트 — 현 정본 구현. 허브 적재·창 emit·영속을 그대로 위임한다.
impl ActivitySink for tauri::AppHandle {
    fn publish(&self, kind: &str, source: &str, payload: Value) -> Value {
        crate::activity::publish(self, kind, source, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// 계약만 구현한 테스트 원장 — Tauri 없이 발행을 검증할 수 있어야 한다.
    /// (이 테스트가 컴파일된다는 사실 자체가 "발행은 벤더 타입이 아니다"의 증명이다.)
    #[derive(Default)]
    struct Recorder {
        entries: Mutex<Vec<(String, String, Value)>>,
    }

    impl ActivitySink for Recorder {
        fn publish(&self, kind: &str, source: &str, payload: Value) -> Value {
            let mut e = self.entries.lock().unwrap();
            e.push((kind.to_string(), source.to_string(), payload.clone()));
            json!({ "seq": e.len(), "kind": kind, "source": source, "payload": payload })
        }
    }

    #[test]
    fn a_sink_needs_no_shell_type() {
        let r = Recorder::default();
        let out = r.publish("boot.step", "core", json!({ "step": "ready" }));
        assert_eq!(out["kind"], "boot.step");
        assert_eq!(out["seq"], 1);
        assert_eq!(r.entries.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_recorded_entry_comes_back_to_the_publisher() {
        // 발행자가 seq 를 받아야 자기 사건을 뒤에서 되짚을 수 있다 — 발행이 값을 돌려주는
        // 이유다(원장에 남겼다는 말만 하고 아무것도 안 돌려주면 추적이 끊긴다).
        let r = Recorder::default();
        let a = r.publish("a", "core", Value::Null);
        let b = r.publish("b", "core", Value::Null);
        assert_ne!(a["seq"], b["seq"]);
    }
}
