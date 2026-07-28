// 스트림 출구의 **이 프레임워크 구현** — 계약은 코어가 소유한다(soksak_core::stream_sink).
//
// 벤더 타입에 코어 트레이트를 직접 달 수 없다(고아 규칙: 남의 트레이트를 남의 타입에).
// 그래서 얇은 껍질을 두른다 — 껍질은 값을 나르기만 하고 정책을 갖지 않는다.

pub(crate) use soksak_core::stream_sink::{Delivered, ExitSink, StreamSink};

/// Tauri 웹뷰 크로싱 — 바이트 배치.
#[derive(Clone)]
pub(crate) struct ChannelSink(pub tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>);

impl StreamSink for ChannelSink {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        match self.0.send(tauri::ipc::InvokeResponseBody::Raw(bytes)) {
            Ok(()) => Delivered::Ok,
            Err(_) => Delivered::Gone,
        }
    }
}

/// Tauri 웹뷰 크로싱 — 종료 코드 하나.
#[derive(Clone)]
pub(crate) struct ExitChannelSink(pub tauri::ipc::Channel<i32>);

impl ExitSink for ExitChannelSink {
    fn deliver(&self, code: i32) -> Delivered {
        match self.0.send(code) {
            Ok(()) => Delivered::Ok,
            Err(_) => Delivered::Gone,
        }
    }
}
