//! 범용 WebSocket — Origin 헤더를 보내지 않는 클라이언트(ws:// 평문).
//!
//! 브라우저·웹뷰의 WebSocket 은 Origin 을 강제로 붙이고 바꿀 수 없어, Origin 을 검사하는 서버
//! (webOS TV SSAP 등)가 "invalid origin"(close 1008)으로 거부한다. tokio-tungstenite 는 Origin 을
//! 보내지 않으므로 그런 서버에 붙는다. 특정 용도 락인 0 — 임의 ws 서버에 범용이다.
//!
//! 양방향: connect 후 sink/stream 으로 split. 읽기 태스크가 텍스트 프레임을 메시지 출구로
//! 흘리고, 쓰기는 mpsc 로 받아 sink 에 보낸다. close 시 세션 제거(tx drop → 쓰기 태스크 종료)
//! + 읽기 태스크 끊기.
//!
//! 출구는 `StreamSink` 계약이다 — 그래서 이 몸은 프레임워크 타입을 이름으로 모르고, 서버 없이
//! 프레임 스트림만으로 검증된다. 벤더 크로싱은 프레임워크의 커맨드 가장자리에만 있다.
//!
//! 런타임은 이 크레이트가 진다(transport.rs 의 rt). 한때 이 몸이 프레임워크 폴더에 살면서
//! `tauri::async_runtime` 으로 스폰했고, 그 한 줄 때문에 "전송기가 런타임을 끌고 온다"가
//! 이식 불가 사유로 적혀 있었다 — 런타임은 자원이지 프레임워크가 아니다.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message};

use soksak_core::stream_sink::{Delivered, StreamSink};

/// 세션 원장 항목. 읽기 태스크는 핸들 타입이 아니라 **끊는다는 행위**로 쥔다 — 원장이 벤더
/// 핸들을 이름으로 알면 원장 자체가 그 런타임에 묶인다.
struct WsSession {
    tx: mpsc::UnboundedSender<String>,
    abort_read: Box<dyn Fn() + Send>,
}

#[derive(Default)]
pub struct WsManager {
    sessions: Mutex<HashMap<u32, WsSession>>,
    next_id: Mutex<u32>,
}

impl WsManager {
    /// 세션 등재 — 핸들 발급은 원장의 것이다. 반환값이 부르는 쪽이 쥐는 핸들.
    fn register(&self, tx: mpsc::UnboundedSender<String>, abort_read: Box<dyn Fn() + Send>) -> u32 {
        let id = {
            let mut n = self.next_id.lock().unwrap_or_else(|e| e.into_inner());
            *n += 1;
            *n
        };
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, WsSession { tx, abort_read });
        id
    }

    /// 전송 — 없는 핸들은 이름을 달고 실패한다(조용한 성공 금지).
    fn send_text(&self, id: u32, text: String) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let sess = sessions.get(&id).ok_or("no such websocket")?;
        sess.tx.send(text).map_err(|e| e.to_string())
    }

    /// 세션 제거 → tx drop(쓰기 태스크 종료) + 읽기 태스크 끊기. 없는 핸들은 무해(멱등).
    fn close(&self, id: u32) {
        if let Some(sess) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            (sess.abort_read)();
        }
    }

    /// 종료 시: 모든 연결 정리.
    pub fn close_all(&self) {
        let mut s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for (_, sess) in s.drain() {
            (sess.abort_read)();
        }
    }
}

static MANAGER: LazyLock<WsManager> = LazyLock::new(WsManager::default);

/// 읽기 루프 — 텍스트 프레임을 메시지 출구로, 스트림이 끝나면 닫힘 출구로 한 번.
/// 프레임워크 타입 0: 입력은 ws 프레임 스트림이고 출구는 계약이다.
pub async fn pump_reads<S, M, C>(mut read: S, on_message: M, on_close: C)
where
    S: futures_util::stream::Stream<Item = Result<Message, tungstenite::Error>> + Unpin,
    M: StreamSink,
    C: StreamSink,
{
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(t)) => {
                // 텍스트 프레임은 정의상 UTF-8(RFC 6455 §5.6)이고 tungstenite 가 이미 검증했다 —
                // 바이트로 나르는 것이 무손실이다.
                if on_message.deliver(t.into_bytes()) == Delivered::Gone {
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {} // binary/ping/pong 무시
        }
    }
    // 닫힘은 배치가 아니라 한 번의 신호다 — 실을 내용이 없어 빈 배치로 건넨다. 메시지 출구와
    // **다른 객체**라 "빈 텍스트 프레임"과 섞일 여지가 없다.
    let _ = on_close.deliver(Vec::new());
}

/// 붙는다 — 반환은 이 연결의 핸들.
///
/// 출구 둘을 받는다: 텍스트 프레임이 가는 곳과 닫힘 신호가 가는 곳. 무엇으로 나르는지는
/// 부르는 쪽의 것이다(웹뷰 채널·소켓 스트림 …).
pub fn connect(
    url: &str,
    on_message: Arc<dyn StreamSink + Send + Sync>,
    on_close: Arc<dyn StreamSink + Send + Sync>,
) -> Result<u32, String> {
    let rt = crate::transport::rt().ok_or("ws runtime")?;
    let (stream, _resp) = rt
        .block_on(tokio_tungstenite::connect_async(url))
        .map_err(|e| e.to_string())?;
    let (mut write, read) = stream.split();

    // 쓰기 태스크 — mpsc 로 받은 텍스트를 sink 로. tx drop(세션 제거) 시 종료.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    rt.spawn(async move {
        while let Some(t) = rx.recv().await {
            if write.send(Message::Text(t)).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    let read_task = rt.spawn(pump_reads(read, ArcSink(on_message), ArcSink(on_close)));
    Ok(MANAGER.register(tx, Box::new(move || read_task.abort())))
}

/// 트레이트 객체를 값 계약에 얹는 껍질 — 계약은 값으로 받고, 소유는 부르는 쪽에 있다.
struct ArcSink(Arc<dyn StreamSink + Send + Sync>);

impl StreamSink for ArcSink {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        self.0.deliver(bytes)
    }
}

pub fn send(id: u32, text: String) -> Result<(), String> {
    MANAGER.send_text(id, text)
}

pub fn close(id: u32) {
    MANAGER.close(id);
}

pub fn close_all() {
    MANAGER.close_all();
}

#[cfg(test)]
#[path = "ws_tests.rs"]
mod tests;
