// PTY 출력의 전달 단위를 소유한다 — 계약은 soksak_spec_pty(DELIVERY_BATCH_BYTES,
// OutputBatcher), 이 파일은 그 계약을 webview 크로싱에 적용하는 한 지점이다.
// 인프로세스 백엔드와 데몬 릴레이가 같은 함수를 쓴다(사본 금지).
use soksak_spec_pty::{self as proto, OutputBatcher};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Turns reads into delivery units on their way to the webview.
///
/// Both PTY backends end at the same crossing — `Channel<InvokeResponseBody>` —
/// and that crossing is what costs: a payload at or above tauri's 1024-byte
/// direct-execute guard takes a script eval plus an ipc:// round trip. A pty
/// master read returns ~1 KB, so delivering per read pinned the crossing count
/// at bytes/1KB. The delivery unit belongs to the crossing, not to the source.
///
/// Only this crossing batches. The daemon's socket write is left alone on
/// purpose — one owner per crossing is the whole point.
///
/// The thread blocks for the first read, then takes everything already queued.
/// When the queue runs dry the open batch decides for itself whether to wait:
/// below `DELIVERY_MIN_HOLD_BYTES` it is smaller than a single pty read and so
/// cannot be stream output — an echo, a prompt — and it goes now; at or above
/// it, the batch waits up to `DELIVERY_DEADLINE` for the next read.
///
/// An earlier cut had no wait at all and read an empty queue as "nothing more
/// is coming". The rig refuted it: written/ackSent stayed at 5,428 B, a ~1,086 B
/// unit, unchanged. Delivering costs the webview and not this side, so this
/// thread simply outruns the reader and the queue is empty on every pass.
///
/// Returns the sender a reader thread feeds, and the handle to join before
/// declaring the stream over — the final partial batch is delivered on drop of
/// the sender, and a caller that signals end-of-stream first would truncate it.
pub(crate) fn spawn_delivery(
    on_output: Channel<InvokeResponseBody>,
) -> (
    std::sync::mpsc::Sender<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let handle = std::thread::spawn(move || {
        let mut batcher = OutputBatcher::new();
        let emit = |batch: Vec<u8>| on_output.send(InvokeResponseBody::Raw(batch)).is_ok();
        'stream: loop {
            // 조용한 pty 에서는 여기서 블록한다 — 유휴 비용 0.
            let Ok(first) = rx.recv() else { break };
            let mut open = batcher.push(&first);
            loop {
                if let Some(batch) = open.take() {
                    if !emit(batch) {
                        return; // 프론트 사라짐
                    }
                    continue 'stream;
                }
                // 이미 쌓인 것은 기다릴 것 없이 흡수한다.
                match rx.try_recv() {
                    Ok(more) => {
                        open = batcher.push(&more);
                        continue;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'stream,
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                }
                // 큐가 비었다 ≠ 더 올 게 없다(리그 실측). 붙들지 말지는 배치 자신의
                // 크기가 정한다 — read 한 번보다 작으면 스트림일 수 없다(에코·프롬프트).
                if batcher.len() < proto::DELIVERY_MIN_HOLD_BYTES {
                    break;
                }
                match rx.recv_timeout(proto::DELIVERY_DEADLINE) {
                    Ok(more) => open = batcher.push(&more),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'stream,
                }
            }
            if let Some(batch) = batcher.take() {
                if !emit(batch) {
                    return;
                }
            }
        }
        if let Some(tail) = batcher.take() {
            emit(tail);
        }
    });
    (tx, handle)
}

#[cfg(test)]
mod tests {
    use super::spawn_delivery;
    use soksak_spec_pty::DELIVERY_BATCH_BYTES;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};

    /// 크로싱을 세는 Channel — 전달 단위가 바뀌었는지는 send 횟수로만 증명된다.
    fn counting_channel() -> (Channel<InvokeResponseBody>, Arc<AtomicUsize>, Arc<Mutex<Vec<u8>>>) {
        let crossings = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (c, b) = (crossings.clone(), bytes.clone());
        let channel = Channel::new(move |body| {
            // 바이트를 먼저 적고 카운터를 나중에 올린다 — 관측자가 카운터를 보고
            // 바이트를 읽으므로 순서가 뒤집히면 테스트가 빈 버퍼를 본다.
            if let InvokeResponseBody::Raw(raw) = body {
                b.lock().unwrap().extend_from_slice(&raw);
            }
            c.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        (channel, crossings, bytes)
    }

    /// 결함: 전달 단위가 read 단위였다. macOS pty master read 는 ~1 KB 를 돌려주므로
    /// 크로싱 수가 bytes/1KB 로 못박혔다 — 4 MB 면 약 4000 회. 배치가 그 고리를 끊는지
    /// 실제 크로싱을 세어 확인한다(바이트는 하나도 잃지 않으면서).
    #[test]
    fn the_crossing_count_is_not_the_read_count() {
        let (channel, crossings, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);

        let chunk = vec![b'x'; 1030]; // 실측된 pty master read 크기
        let total = 4 * 1024 * 1024;
        let reads = total / chunk.len();
        for _ in 0..reads {
            deliver.send(chunk.clone()).expect("delivery thread alive");
        }
        drop(deliver);
        delivery.join().expect("delivery thread joins");

        let sent = crossings.load(Ordering::SeqCst);
        let bytes = reads * chunk.len();
        assert_eq!(got.lock().unwrap().len(), bytes, "배치가 바이트를 잃으면 안 된다");
        // 데드라인이 중간에 배치를 끊을 수 있으므로 상한은 넉넉히 잡는다 — 그래도
        // read 당 1회(= reads)와는 자릿수가 다르다.
        let ceiling = bytes.div_ceil(DELIVERY_BATCH_BYTES) * 4 + 1;
        eprintln!("  전달: {bytes} B / read {reads}회 → 크로싱 {sent}회 (감소 {:.0}배)", reads as f64 / sent as f64);
        assert!(
            sent <= ceiling,
            "크로싱 {sent}회 / read {reads}회 — 전달 단위가 아직 read 단위다(상한 {ceiling})",
        );
    }

    /// 배치가 에코 지연을 만들면 안 된다. 뒤에 쌓인 게 없으면 도착한 그 패스에
    /// 건너간다 — 스트림이 계속 열려 있어도(sender 살아 있음) 붙잡지 않는다.
    /// t2 는 median 1 ms 이고 예산은 4.5 ms 다. 데드라인을 두면 여기서 깨진다.
    #[test]
    fn a_lone_echo_crosses_without_waiting_for_a_batch() {
        let (channel, crossings, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);

        deliver.send(b"x".to_vec()).unwrap();
        // sender 는 살려 둔다 — 종료가 아니라 "쌓인 게 없다"가 방출 이유여야 한다.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while crossings.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        let waited = std::time::Instant::now();
        assert_eq!(crossings.load(Ordering::SeqCst), 1, "에코가 배치에 잡혀 있다");
        assert_eq!(&*got.lock().unwrap(), b"x");
        assert!(
            waited < deadline,
            "에코가 배치 데드라인만큼 지연됐다 — 인터랙티브 경로에 타이머를 두면 안 된다",
        );

        drop(deliver);
        delivery.join().unwrap();
    }

    /// 실측이 반증한 경우 — backlog 만으로는 배치가 서지 않는다.
    ///
    /// 리그 실측(20260726-001819, perf/release): 100 MB 를 흘렸는데 written/ackSent 가
    /// 5,428 B 였다. ack 임계가 5000 이므로 전달 단위는 여전히 ~1,086 B — 배칭 전과 같은
    /// 자릿수다. Rust 쪽 send 가 싸서 전달 스레드가 리더보다 빠르고, 그래서 매 패스마다
    /// 큐가 비어 있다. 큐가 비었다는 것이 "더 올 게 없다"는 뜻이 아니었다.
    ///
    /// 이 테스트는 그 도착 패턴을 그대로 만든다: 한 번에 한 read 씩, 사이를 띄워서
    /// 전달 스레드가 항상 빈 큐를 보게 한다.
    #[test]
    fn a_paced_bulk_stream_still_batches_even_though_the_queue_is_always_empty() {
        let (channel, crossings, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);

        let chunk = vec![b'x'; 1086]; // 리그에서 실측된 도착 단위
        let reads = 400;
        for _ in 0..reads {
            deliver.send(chunk.clone()).expect("delivery thread alive");
            std::thread::sleep(std::time::Duration::from_micros(130)); // 실측 도착 간격
        }
        drop(deliver);
        delivery.join().expect("delivery thread joins");

        let sent = crossings.load(Ordering::SeqCst);
        let bytes = reads * chunk.len();
        assert_eq!(got.lock().unwrap().len(), bytes, "배치가 바이트를 잃으면 안 된다");
        eprintln!("  페이스드: {bytes} B / read {reads}회 → 크로싱 {sent}회");
        assert!(
            sent * 4 <= reads,
            "크로싱 {sent}회 / read {reads}회 — 큐가 비어도 배치가 서야 한다",
        );
    }

    /// 그리고 그 대기가 인터랙티브 경로를 물어서는 안 된다. 에코는 read 한 번보다도
    /// 작으므로, 배치를 붙들 이유가 되는 크기에 미치지 못한다.
    #[test]
    fn a_stream_of_tiny_echoes_never_waits() {
        let (channel, crossings, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);

        let started = std::time::Instant::now();
        for i in 0..50u8 {
            deliver.send(vec![b'a' + (i % 26)]).unwrap();
            // 앞선 전달 직후에 오는 에코 — 왕복 50회(t2 와 같은 모양).
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while crossings.load(Ordering::SeqCst) <= i as usize
                && std::time::Instant::now() < deadline
            {
                std::thread::yield_now();
            }
        }
        let elapsed = started.elapsed();
        drop(deliver);
        delivery.join().unwrap();

        assert_eq!(got.lock().unwrap().len(), 50, "에코 바이트가 전부 건너가야 한다");
        assert_eq!(crossings.load(Ordering::SeqCst), 50, "에코는 하나씩 즉시 건너간다");
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "왕복 50회에 {elapsed:?} — 에코가 배치 대기를 물었다",
        );
    }

    /// 꼬리 손실 금지: 마지막 부분 배치는 스트림 종료를 고지하기 전에 나가야 한다.
    #[test]
    fn the_final_partial_batch_is_delivered_before_the_stream_ends() {
        let (channel, crossings, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);
        deliver.send(b"prompt$ ".to_vec()).unwrap();
        drop(deliver);
        delivery.join().unwrap();
        assert_eq!(&*got.lock().unwrap(), b"prompt$ ");
        assert_eq!(crossings.load(Ordering::SeqCst), 1);
    }

    /// 순서 보존 — 배치 경계가 바이트 순서를 바꾸면 VT 스트림이 깨진다.
    #[test]
    fn batching_preserves_byte_order_across_boundaries() {
        let (channel, _, got) = counting_channel();
        let (deliver, delivery) = spawn_delivery(channel);
        let mut expected = Vec::new();
        for i in 0..40_000u32 {
            let b = i.to_le_bytes();
            expected.extend_from_slice(&b);
            deliver.send(b.to_vec()).unwrap();
        }
        drop(deliver);
        delivery.join().unwrap();
        assert_eq!(&*got.lock().unwrap(), &expected);
    }
}
