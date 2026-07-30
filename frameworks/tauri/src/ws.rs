// WebSocket 의 **프레임워크 몫** — 웹뷰 크로싱과 커맨드 진입점뿐이다.
//
// 몸(세션 원장·읽기 루프·연결·런타임)은 soksak-net 이 진다. 한때 그 몸이 여기 살았고, 그
// 배치 때문에 "전송기가 런타임을 끌고 온다"가 이식 불가 사유로 적혀 있었다 — 런타임은
// 자원이지 프레임워크가 아니다.
//
// 여기 남은 것은 계약(StreamSink)을 이 프레임워크의 채널로 잇는 껍질 둘과 커맨드 셋이다.

use std::sync::Arc;

use soksak_core::stream_sink::{Delivered, StreamSink};
use tauri::ipc::Channel;

/// 텍스트 크로싱 — 계약은 바이트로 나르고 여기서 문자열로 되돌린다. `Raw` 로 바꾸면 같은
/// 웹뷰 콜백이 문자열 대신 ArrayBuffer 를 받게 되어 소비자가 보는 답이 달라진다.
struct TextChannel(Channel<String>);

impl StreamSink for TextChannel {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        // 이 출구에 오는 배치는 텍스트 프레임에서 온 것뿐이라 UTF-8 이다. 그래도 실을 수 없는
        // 배치를 조용히 버리지 않는다 — 나를 수 없으면 생산을 멈춘다.
        let Ok(text) = String::from_utf8(bytes) else {
            return Delivered::Gone;
        };
        if self.0.send(text).is_ok() {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

/// 닫힘 크로싱 — 신호 1회라 배치 내용을 쓰지 않는다.
struct CloseChannel(Channel<()>);

impl StreamSink for CloseChannel {
    fn deliver(&self, _bytes: Vec<u8>) -> Delivered {
        if self.0.send(()).is_ok() {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

#[tauri::command]
pub fn ws_connect(
    url: String,
    on_message: Channel<String>,
    on_close: Channel<()>,
) -> Result<u32, String> {
    soksak_net::ws::connect(
        &url,
        Arc::new(TextChannel(on_message)),
        Arc::new(CloseChannel(on_close)),
    )
}

#[tauri::command]
pub fn ws_send(id: u32, text: String) -> Result<(), String> {
    soksak_net::ws::send(id, text)
}

#[tauri::command]
pub fn ws_close(id: u32) -> Result<(), String> {
    soksak_net::ws::close(id);
    Ok(())
}
