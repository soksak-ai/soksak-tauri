// WebSocket 몸의 검사 — 규칙은 ws.rs 가, 그 증명은 여기가 진다.
//
// 연결(connect_async)만 실 서버를 요구한다. 그 밖의 두 축 — 세션 원장과 읽기 루프 — 은
// 프레임워크 타입 없이 여기서 전부 돈다: 원장은 끊기 행위를 값으로 쥐고, 루프는 프레임
// 스트림과 출구 계약만 안다.
// 연결(connect_async)만 실 서버를 요구한다. 그 밖의 두 축 — 세션 원장과 읽기 루프 — 은
// 프레임워크 타입 없이 여기서 전부 돈다: 원장은 끊기 행위를 값으로 쥐고, 루프는 프레임 스트림과
// 출구 계약만 안다.
use super::*;
use soksak_core::stream_sink::Delivered;
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
