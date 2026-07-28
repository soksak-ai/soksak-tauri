// 활동 원장의 **이 프레임워크 구현** — 계약은 코어가 소유한다(soksak_core::activity_sink).
//
// 벤더 타입에 코어 트레이트를 직접 달 수 없다(고아 규칙). 얇은 껍질만 두른다 — 껍질은
// 위임만 하고 정책을 갖지 않는다.

use serde_json::Value;

pub(crate) use soksak_core::activity_sink::ActivitySink;

/// Tauri 호스트 — 허브 적재·창 emit·영속을 그대로 위임한다.
#[derive(Clone)]
pub(crate) struct AppSink(pub tauri::AppHandle);

impl ActivitySink for AppSink {
    fn publish(&self, kind: &str, source: &str, payload: Value) -> Value {
        crate::activity::publish(&self.0, kind, source, payload)
    }
}
