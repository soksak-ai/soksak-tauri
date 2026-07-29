// 명령 중개 계약 — "registry 명령 하나를 부르고 답을 받는다".
//
// 창 사실(WindowOracle)·활동 원장(ActivitySink)에 한 것과 같은 이유로 이것도 계약 뒤에 둔다.
// 지금 이 능력은 `ipc::{request_command, open_request, close_request}` 세 함수이고 셋 다
// `&AppHandle` 을 받는다. 그래서 명령 하나를 부르고 싶을 뿐인 발화기(스케줄러)까지 AppHandle
// 을 인자로 쥐게 되고, 쥐는 순간 그 코드는 앱 프로세스를 떠날 수 없다.
//
// 이 계약은 창을 모른다. 어느 창으로 갈지(폴백 사다리)는 ipc 의 것이고 부르는 쪽은 명령과
// 답만 안다 — 창 사실이 필요한 호출자는 WindowOracle 을 따로 받는다. 여기 끼워 넣으면 중개
// 계약이 라우팅 정책까지 쥐고, 구현마다 사다리가 갈라진다.
//
// 계약은 세 줄이다:
//   ① 한 번의 요청-응답 — 상한(ms)까지 기다리고 봉투를 돌린다.
//   ② 답을 호출자가 직접 기다리는 발화 — 배달 실패는 None 으로 말한다(삼키면 호출자가
//      오지 않을 답을 기다린다).
//   ③ 대기 자리 회수(멱등) — 빼먹으면 그 자리는 영영 남는다.

use serde_json::Value;
use std::sync::mpsc::Receiver;

/// registry 명령의 중개자. 구현은 호스트마다 하나다.
pub(crate) trait CommandDispatch: Send + Sync {
    /// 한 번의 요청-응답. 상한 안에 답이 없으면 구현이 그 사실을 봉투로 말한다(무한대기 금지).
    fn request(
        &self,
        method: String,
        params: Value,
        timeout_ms: u64,
        origin: Option<&str>,
        key: Option<String>,
    ) -> Value;

    /// 대기를 호출자가 소유하는 발화 — (seq, 답 채널). 배달 실패면 None.
    /// 호출자는 끝날 때 반드시 `close(seq)` 로 자리를 회수한다.
    fn open(&self, method: String, params: Value, origin: Option<&str>)
        -> Option<(u64, Receiver<Value>)>;

    /// 대기 자리 회수(멱등) — 정상 완료·포기·취소 공용.
    fn close(&self, seq: u64);
}

/// Tauri 호스트 — 현 정본 구현. 창 라우팅과 pending 장부는 ipc 가 그대로 소유한다.
impl CommandDispatch for tauri::AppHandle {
    fn request(
        &self,
        method: String,
        params: Value,
        timeout_ms: u64,
        origin: Option<&str>,
        key: Option<String>,
    ) -> Value {
        crate::ipc::request_command(self, method, params, timeout_ms, origin, key)
    }

    fn open(
        &self,
        method: String,
        params: Value,
        origin: Option<&str>,
    ) -> Option<(u64, Receiver<Value>)> {
        crate::ipc::open_request(self, method, params, origin)
    }

    fn close(&self, seq: u64) {
        crate::ipc::close_request(self, seq)
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
