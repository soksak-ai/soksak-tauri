// 스트림 출구 계약 — 고volume 출력이 소비자에게 건너가는 **한 점**.
//
// 셸을 어댑터 뒤로 보낸 것과 같은 이유로 출구도 어댑터 뒤에 둔다. 지금 이 크로싱은
// `tauri::ipc::Channel` 하나이고, 그것은 호출 웹뷰의 IPC 문맥에서 역직렬화로 만들어지는
// 핸들이다 — Serialize 가 아니고, 라벨로 재구성할 수 없고, 프로세스 경계를 못 넘는다.
// 그래서 이 타입이 시그니처에 박혀 있는 한 그 핸들러는 앱 프로세스를 떠날 수 없다
// (실측 분류 2026-07-27: 라벨만 있으면 옮길 수 있는 7건 중 3건이 오직 이것 때문에 묶였다).
//
// 계약은 두 줄이다:
//   ① 배치 하나를 소비자에게 건넨다.
//   ② 소비자가 사라졌으면 그 사실을 알린다 — 조용히 버리지 않는다.
//
// 배압은 여기 없다. 워터마크(soksak_spec_pty::{HIGH,LOW}_WATERMARK)와 ack 는 세션이
// 소유하며, 출구가 바뀌어도 그 계약은 그대로다. 출구가 배압까지 쥐면 구현마다 정책이
// 갈라지고, 갈라진 정책은 곧 무한 버퍼다.

/// 전달 결과 — 소비자가 살아 있는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Delivered {
    Ok,
    /// 소비자가 사라졌다(창 리로드·프로세스 종료). 생산 측이 멈춰야 한다.
    Gone,
}

/// 출력 한 배치의 도착지. 구현은 크로싱마다 하나다.
pub(crate) trait StreamSink: Send + 'static {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered;
}

/// Tauri 웹뷰 크로싱 — 현 정본 구현.
impl StreamSink for tauri::ipc::Channel<tauri::ipc::InvokeResponseBody> {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        match self.send(tauri::ipc::InvokeResponseBody::Raw(bytes)) {
            Ok(()) => Delivered::Ok,
            Err(_) => Delivered::Gone,
        }
    }
}

/// 종료 사건의 도착지 — 스트림이 끝났다는 사실 하나(정수).
///
/// 바이트 계약(`StreamSink`)에 끼우지 않는다. 종료 코드는 스트림의 일부가 아니고, 소비자가
/// 받는 것도 raw 바이트가 아니라 수 하나다(`Channel<i32>` 는 JSON 수로 직렬화한다). 바이트로
/// 바꾸면 받는 쪽 페이로드 형태가 달라진다 — 그건 구조 이전이 아니라 동작 변경이다.
/// 그래서 모양은 같게(사라짐을 값으로) 두고 타입만 따로 세운다.
pub(crate) trait ExitSink: Send + 'static {
    fn deliver(&self, code: i32) -> Delivered;
}

/// Tauri 웹뷰 크로싱 — 현 정본 구현.
impl ExitSink for tauri::ipc::Channel<i32> {
    fn deliver(&self, code: i32) -> Delivered {
        match self.send(code) {
            Ok(()) => Delivered::Ok,
            Err(_) => Delivered::Gone,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 계약만 구현한 테스트 출구 — Tauri 없이도 전달 단위를 검증할 수 있어야 한다.
    /// (이 테스트가 컴파일된다는 사실 자체가 "출구는 벤더 타입이 아니다"의 증명이다.)
    struct Recorder {
        calls: Arc<AtomicUsize>,
        bytes: Arc<Mutex<Vec<u8>>>,
        alive: bool,
    }

    impl StreamSink for Recorder {
        fn deliver(&self, bytes: Vec<u8>) -> Delivered {
            if !self.alive {
                return Delivered::Gone;
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.bytes.lock().unwrap().extend_from_slice(&bytes);
            Delivered::Ok
        }
    }

    #[test]
    fn a_sink_needs_no_shell_type() {
        let calls = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let sink = Recorder { calls: calls.clone(), bytes: bytes.clone(), alive: true };
        assert_eq!(sink.deliver(b"ab".to_vec()), Delivered::Ok);
        assert_eq!(sink.deliver(b"c".to_vec()), Delivered::Ok);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(&*bytes.lock().unwrap(), b"abc");
    }

    /// 종료 출구도 벤더 타입을 요구하지 않는다 — 그리고 그것이 나르는 것은 수 하나다.
    struct ExitRecorder {
        code: Arc<Mutex<Option<i32>>>,
        alive: bool,
    }

    impl ExitSink for ExitRecorder {
        fn deliver(&self, code: i32) -> Delivered {
            if !self.alive {
                return Delivered::Gone;
            }
            *self.code.lock().unwrap() = Some(code);
            Delivered::Ok
        }
    }

    #[test]
    fn an_exit_crosses_as_a_number_not_as_bytes() {
        let code = Arc::new(Mutex::new(None));
        let sink = ExitRecorder { code: code.clone(), alive: true };
        assert_eq!(sink.deliver(7), Delivered::Ok);
        assert_eq!(*code.lock().unwrap(), Some(7));
    }

    #[test]
    fn a_departed_exit_consumer_is_reported_too() {
        let sink = ExitRecorder { code: Arc::new(Mutex::new(None)), alive: false };
        assert_eq!(sink.deliver(0), Delivered::Gone);
    }

    #[test]
    fn a_departed_consumer_is_reported_not_swallowed() {
        let sink = Recorder {
            calls: Arc::new(AtomicUsize::new(0)),
            bytes: Arc::new(Mutex::new(Vec::new())),
            alive: false,
        };
        // 조용히 버리면 생산 측이 영원히 읽는다 — 사라짐은 반드시 값으로 돌아온다.
        assert_eq!(sink.deliver(b"x".to_vec()), Delivered::Gone);
    }
}
