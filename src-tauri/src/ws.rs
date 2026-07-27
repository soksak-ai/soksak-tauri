// 범용 WebSocket capability — Origin 헤더를 보내지 않는 클라이언트(ws:// 평문).
// 브라우저/webview 의 WebSocket 은 Origin 을 강제로 붙이고 변경할 수 없어, Origin 을 검사하는
// 서버(webOS TV SSAP 등)가 "invalid origin"(close 1008)으로 거부한다. tokio-tungstenite 는
// Origin 을 보내지 않으므로 그런 서버에 연결된다. 특정 용도 락인 0 — 임의 ws 서버에 범용.
//
// 양방향: connect 후 sink/stream 으로 split. read task 가 텍스트 프레임을 메시지 출구로
// 스트리밍하고, write 는 mpsc 로 받아 sink 에 보낸다. close 시 session 제거(tx drop →
// write task 종료) + read task 끊기.
//
// 출구는 `StreamSink` 계약이다(stream_sink.rs). 그래서 읽기 루프는 셸 타입을 이름으로 모르고,
// 서버 없이 프레임 스트림만으로 검증된다. 벤더 크로싱(Channel)은 이 파일의 커맨드 가장자리에만
// 있다.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message};

use crate::stream_sink::{Delivered, StreamSink};

// 세션 원장 항목. 읽기 태스크는 핸들 타입이 아니라 **끊는다는 행위**로 쥔다 — 원장이 벤더
// 핸들을 이름으로 알면 원장 자체가 그 런타임에 묶인다.
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
    // 세션 등재 — 핸들 발급은 매니저의 것이다. 반환값이 웹뷰가 쥐는 핸들.
    fn register(&self, tx: mpsc::UnboundedSender<String>, abort_read: Box<dyn Fn() + Send>) -> u32 {
        let id = {
            let mut n = self.next_id.lock().unwrap();
            *n += 1;
            *n
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(id, WsSession { tx, abort_read });
        id
    }

    // 전송 — 없는 핸들은 이름을 달고 실패한다(조용한 성공 금지).
    fn send_text(&self, id: u32, text: String) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let sess = sessions.get(&id).ok_or("no such websocket")?;
        sess.tx.send(text).map_err(|e| e.to_string())
    }

    // 세션 제거 → tx drop(write task 종료) + 읽기 태스크 끊기. 없는 핸들은 무해(멱등).
    fn close(&self, id: u32) {
        if let Some(sess) = self.sessions.lock().unwrap().remove(&id) {
            (sess.abort_read)();
        }
    }

    // 앱 종료 시: 모든 연결 정리.
    pub fn close_all(&self) {
        if let Ok(mut s) = self.sessions.lock() {
            for (_, sess) in s.drain() {
                (sess.abort_read)();
            }
        }
    }
}

// 읽기 루프 — 텍스트 프레임을 메시지 출구로, 스트림이 끝나면 닫힘 출구로 한 번.
// 셸 타입 0: 입력은 ws 프레임 스트림이고 출구는 계약이다.
async fn pump_reads<S, M, C>(mut read: S, on_message: M, on_close: C)
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
            _ => {} // binary/ping/pong 무시(SSAP 는 텍스트)
        }
    }
    // 닫힘은 배치가 아니라 한 번의 신호다 — 실을 내용이 없어 빈 배치로 건넨다. 메시지 출구와
    // **다른 객체**라 "빈 텍스트 프레임"과 섞일 여지가 없다.
    let _ = on_close.deliver(Vec::new());
}

// 텍스트 크로싱의 Tauri 구현. 계약은 바이트로 나르고 여기서 문자열로 되돌린다 —
// `Channel<InvokeResponseBody>::Raw` 로 바꾸면 같은 웹뷰 콜백이 문자열 대신 ArrayBuffer 를
// 받게 되어 소비자가 보는 답이 달라진다(app.ws 의 onMessage 는 string 이다).
struct TextChannel(Channel<String>);

impl StreamSink for TextChannel {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        // 이 출구에 오는 배치는 pump_reads 가 Message::Text 에서 만든 것뿐이라 UTF-8 이다.
        // 그래도 실을 수 없는 배치를 조용히 버리지 않는다 — 나를 수 없으면 생산을 멈춘다.
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

// 닫힘 크로싱의 Tauri 구현 — 신호 1회라 배치 내용을 쓰지 않는다.
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
pub async fn ws_connect(
    url: String,
    on_message: Channel<String>,
    on_close: Channel<()>,
    manager: State<'_, WsManager>,
) -> Result<u32, String> {
    use tokio_tungstenite::connect_async;

    let (stream, _resp) = connect_async(&url).await.map_err(|e| e.to_string())?;
    let (mut write, read) = stream.split();

    // write task — mpsc 로 받은 텍스트를 sink 로. tx drop(세션 제거) 시 종료.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(t) = rx.recv().await {
            if write.send(Message::Text(t)).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    // read task — 스폰(런타임)은 셸의 몫이고 루프 자체는 셸을 모른다.
    let read_task = tauri::async_runtime::spawn(pump_reads(
        read,
        TextChannel(on_message),
        CloseChannel(on_close),
    ));

    Ok(manager.register(tx, Box::new(move || read_task.abort())))
}

#[tauri::command]
pub fn ws_send(id: u32, text: String, manager: State<'_, WsManager>) -> Result<(), String> {
    manager.send_text(id, text)
}

#[tauri::command]
pub fn ws_close(id: u32, manager: State<'_, WsManager>) -> Result<(), String> {
    manager.close(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    // 연결(connect_async)만 실 서버를 요구한다. 그 밖의 두 축 — 세션 원장과 읽기 루프 — 은
    // 셸 타입 없이 여기서 전부 돈다: 원장은 끊기 행위를 값으로 쥐고, 루프는 프레임 스트림과
    // 출구 계약만 안다.
    use super::*;
    use crate::stream_sink::Delivered;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 계약만 구현한 테스트 출구.
    struct Recorder {
        batches: Arc<Mutex<Vec<Vec<u8>>>>,
        alive: bool,
    }

    impl Recorder {
        fn new(alive: bool) -> (Self, Arc<Mutex<Vec<Vec<u8>>>>) {
            let batches = Arc::new(Mutex::new(Vec::new()));
            (
                Recorder {
                    batches: batches.clone(),
                    alive,
                },
                batches,
            )
        }
    }

    impl StreamSink for Recorder {
        fn deliver(&self, bytes: Vec<u8>) -> Delivered {
            if !self.alive {
                return Delivered::Gone;
            }
            self.batches.lock().unwrap().push(bytes);
            Delivered::Ok
        }
    }

    fn frames(
        items: Vec<Result<Message, tungstenite::Error>>,
    ) -> futures_util::stream::Iter<std::vec::IntoIter<Result<Message, tungstenite::Error>>> {
        futures_util::stream::iter(items)
    }

    #[test]
    fn close_all_on_empty_is_ok() {
        let m = WsManager::default();
        m.close_all(); // 빈 매니저에서도 패닉 없음
        assert!(m.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn a_session_is_registered_and_closed_without_a_shell_handle() {
        // 원장이 쥐는 것은 벤더 핸들이 아니라 "끊는다"는 행위다 — 그래서 여기서 돈다.
        let m = WsManager::default();
        let aborted = Arc::new(AtomicUsize::new(0));
        let a = aborted.clone();
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
        let id = m.register(tx, Box::new(move || {
            a.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(id, 1); // 핸들 발급은 매니저의 것이다
        m.close(id);
        assert_eq!(aborted.load(Ordering::SeqCst), 1);
        assert!(m.sessions.lock().unwrap().is_empty());
        m.close(id); // 두 번째 close 는 무해(멱등)
        assert_eq!(aborted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn close_all_cuts_every_reader() {
        let m = WsManager::default();
        let aborted = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let a = aborted.clone();
            let (tx, _rx) = mpsc::unbounded_channel::<String>();
            m.register(tx, Box::new(move || {
                a.fetch_add(1, Ordering::SeqCst);
            }));
        }
        m.close_all();
        assert_eq!(aborted.load(Ordering::SeqCst), 2);
        assert!(m.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn sending_to_an_unknown_handle_is_named_not_swallowed() {
        let m = WsManager::default();
        assert_eq!(m.send_text(7, "x".into()), Err("no such websocket".into()));
    }

    #[tokio::test]
    async fn text_frames_cross_to_the_message_sink() {
        let (msg, got) = Recorder::new(true);
        let (close, closed) = Recorder::new(true);
        pump_reads(
            frames(vec![
                Ok(Message::Text("hello".into())),
                Ok(Message::Text("한글".into())),
            ]),
            msg,
            close,
        )
        .await;
        let got = got.lock().unwrap();
        // 크로싱은 바이트로 나르지만 소비자가 보는 텍스트는 원본 그대로여야 한다.
        let seen: Vec<String> = got
            .iter()
            .map(|b| String::from_utf8(b.clone()).unwrap())
            .collect();
        assert_eq!(seen, vec!["hello".to_string(), "한글".to_string()]);
        assert_eq!(closed.lock().unwrap().len(), 1); // 스트림 끝 = 닫힘 1회
    }

    #[tokio::test]
    async fn a_close_frame_ends_the_stream() {
        let (msg, got) = Recorder::new(true);
        let (close, closed) = Recorder::new(true);
        pump_reads(
            frames(vec![
                Ok(Message::Text("a".into())),
                Ok(Message::Close(None)),
                Ok(Message::Text("after".into())),
            ]),
            msg,
            close,
        )
        .await;
        assert_eq!(got.lock().unwrap().len(), 1); // Close 뒤 프레임은 건너오지 않는다
        assert_eq!(closed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_transport_error_ends_the_stream() {
        let (msg, got) = Recorder::new(true);
        let (close, closed) = Recorder::new(true);
        pump_reads(
            frames(vec![
                Err(tungstenite::Error::ConnectionClosed),
                Ok(Message::Text("after".into())),
            ]),
            msg,
            close,
        )
        .await;
        assert!(got.lock().unwrap().is_empty());
        assert_eq!(closed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_departed_consumer_stops_the_loop_and_still_reports_close() {
        // 조용히 버리면 소켓을 영원히 읽는다 — 사라짐은 값으로 돌아와 루프를 끝낸다.
        let (msg, got) = Recorder::new(false);
        let (close, closed) = Recorder::new(true);
        pump_reads(
            frames(vec![
                Ok(Message::Text("a".into())),
                Ok(Message::Text("b".into())),
            ]),
            msg,
            close,
        )
        .await;
        assert!(got.lock().unwrap().is_empty());
        assert_eq!(closed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn binary_and_control_frames_are_ignored() {
        let (msg, got) = Recorder::new(true);
        let (close, _closed) = Recorder::new(true);
        pump_reads(
            frames(vec![
                Ok(Message::Binary(vec![1, 2, 3])),
                Ok(Message::Ping(vec![])),
                Ok(Message::Pong(vec![])),
                Ok(Message::Text("t".into())),
            ]),
            msg,
            close,
        )
        .await;
        assert_eq!(got.lock().unwrap().len(), 1);
    }
}
