// 명령 중개의 **이 프레임워크 구현** — 계약은 코어가 소유한다(soksak_core::command_dispatch).

use serde_json::Value;
use std::sync::mpsc::Receiver;

pub(crate) use soksak_core::command_dispatch::CommandDispatch;

/// 앱 핸들에 계약을 두르는 껍질.
///
/// 벤더 타입에 코어 트레이트를 직접 달 수 없다(고아 규칙: 남의 트레이트를 남의 타입에).
/// 껍질은 값을 나르기만 하고 정책을 갖지 않는다 — stream_sink 와 같은 선례다.
#[derive(Clone)]
pub(crate) struct AppDispatch(pub tauri::AppHandle);

/// 창 라우팅과 pending 장부는 ipc 가 그대로 소유한다.
impl CommandDispatch for AppDispatch {
    fn request(
        &self,
        method: String,
        params: Value,
        timeout_ms: u64,
        origin: Option<&str>,
        key: Option<String>,
    ) -> Value {
        crate::ipc::request_command(&self.0, method, params, timeout_ms, origin, key)
    }

    fn open(
        &self,
        method: String,
        params: Value,
        origin: Option<&str>,
    ) -> Option<(u64, Receiver<Value>)> {
        crate::ipc::open_request(&self.0, method, params, origin)
    }

    fn close(&self, seq: u64) {
        crate::ipc::close_request(&self.0, seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use std::sync::Mutex;

    /// 계약만 구현한 테스트 중개자 — Tauri 없이 발화를 검증할 수 있어야 한다.
    /// (이 테스트가 컴파일된다는 사실 자체가 "중개는 벤더 타입이 아니다"의 증명이다.)
    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<String>>,
        deliverable: bool,
    }

    impl CommandDispatch for Recorder {
        fn request(
            &self,
            method: String,
            _params: Value,
            timeout_ms: u64,
            _origin: Option<&str>,
            _key: Option<String>,
        ) -> Value {
            self.calls
                .lock()
                .unwrap()
                .push(format!("request:{method}:{timeout_ms}"));
            json!({ "ok": true })
        }
        fn open(
            &self,
            method: String,
            _params: Value,
            _origin: Option<&str>,
        ) -> Option<(u64, Receiver<Value>)> {
            self.calls.lock().unwrap().push(format!("open:{method}"));
            if !self.deliverable {
                return None;
            }
            let (tx, rx) = mpsc::sync_channel::<Value>(1);
            let _ = tx.try_send(json!({ "ok": true }));
            Some((5, rx))
        }
        fn close(&self, seq: u64) {
            self.calls.lock().unwrap().push(format!("close:{seq}"));
        }
    }

    #[test]
    fn a_dispatch_needs_no_shell_type() {
        let d = Recorder {
            deliverable: true,
            ..Recorder::default()
        };
        assert_eq!(d.request("notify.show".into(), Value::Null, 30_000, None, None)["ok"], true);
        let (seq, rx) = d
            .open("plugin.x.run".into(), Value::Null, Some("schedule"))
            .expect("배달 성공");
        assert_eq!(rx.recv().unwrap()["ok"], true);
        d.close(seq);
        assert_eq!(
            *d.calls.lock().unwrap(),
            vec![
                "request:notify.show:30000".to_string(),
                "open:plugin.x.run".to_string(),
                "close:5".to_string(),
            ]
        );
    }

    #[test]
    fn an_undelivered_open_is_reported_not_swallowed() {
        // 삼키면 호출자가 오지 않을 답을 기다린다 — 배달 실패는 반드시 값으로 돌아온다.
        let d = Recorder::default();
        assert!(d.open("plugin.x.run".into(), Value::Null, None).is_none());
    }
}
