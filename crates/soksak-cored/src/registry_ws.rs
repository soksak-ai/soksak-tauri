//! WebSocket 명령의 몸 — 표는 registry_table.rs 가, 판정과 연결은 soksak-net 이 진다.
//!
//! 여기 있는 것은 출구 배선뿐이다. 프레임워크의 웹뷰 채널 대신 이 프로세스의 **스트림 토큰**
//! 통로로 프레임을 민다 — 부른 쪽 연결에 이미 매여 있는 그 토큰이다(wire 가 bind 한다).

use serde_json::Value;

use soksak_core::stream_sink::{Delivered, StreamSink};

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

/// 토큰 하나로 프레임을 미는 출구 — 스트림이 끝났으면 생산을 멈춘다.
struct TokenSink(String);

impl StreamSink for TokenSink {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        // 텍스트 프레임에서 온 배치라 UTF-8 이다. 실을 수 없는 배치를 조용히 버리지 않는다.
        let Ok(text) = String::from_utf8(bytes) else {
            return Delivered::Gone;
        };
        if crate::streams::push(&self.0, Value::String(text)) {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

/// 닫힘 신호 하나 — 배치 내용을 쓰지 않는다. 메시지 출구와 **다른 객체**라 빈 텍스트 프레임과
/// 섞일 여지가 없다.
struct CloseTokenSink(String);

impl StreamSink for CloseTokenSink {
    fn deliver(&self, _bytes: Vec<u8>) -> Delivered {
        if crate::streams::push(&self.0, Value::Null) {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

pub(crate) fn run_ws_connect(_ctx: &Ctx, params: &Value) -> Outcome {
    let Some(url) = params.get("url").and_then(Value::as_str) else {
        return Outcome::InvalidParams("url 이 없다".into());
    };
    let (Some(msg_tok), Some(close_tok)) = (
        params
            .get("onMessage")
            .and_then(soksak_core::stream::token_of),
        params.get("onClose").and_then(soksak_core::stream::token_of),
    ) else {
        return Outcome::InvalidParams("onMessage·onClose 스트림 토큰이 없다".into());
    };
    match soksak_net::ws::connect(
        url,
        std::sync::Arc::new(TokenSink(msg_tok)),
        std::sync::Arc::new(CloseTokenSink(close_tok)),
    ) {
        Ok(id) => Outcome::Ok(Value::from(id)),
        Err(e) => Outcome::Failed(e),
    }
}

#[derive(serde::Deserialize)]
struct WsSend {
    id: u32,
    text: String,
}

pub(crate) fn run_ws_send(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WsSend| soksak_net::ws::send(a.id, a.text))
}

#[derive(serde::Deserialize)]
struct WsClose {
    id: u32,
}

pub(crate) fn run_ws_close(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: WsClose| {
        soksak_net::ws::close(a.id);
        Ok(())
    })
}
