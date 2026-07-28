// PTY 출력의 전달 단위를 소유한다 — 계약은 soksak_spec_pty(DELIVERY_BATCH_BYTES,
// OutputBatcher), 이 파일은 그 계약을 webview 크로싱에 적용하는 한 지점이다.
// 인프로세스 백엔드와 데몬 릴레이가 같은 함수를 쓴다(사본 금지).
use crate::stream_sink::{Delivered, StreamSink};
use soksak_spec_pty::{self as proto, OutputBatcher};

/// Turns reads into delivery units on their way to the webview.
///
/// Both PTY backends end at the same crossing — a `StreamSink` — and that
/// crossing is what costs: a payload at or above tauri's 1024-byte
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
pub fn spawn_delivery<S: StreamSink>(
    on_output: S,
) -> (
    std::sync::mpsc::Sender<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let handle = std::thread::spawn(move || {
        let mut batcher = OutputBatcher::new();
        let emit = |batch: Vec<u8>| on_output.deliver(batch) == Delivered::Ok;
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
#[path = "pty_delivery_tests.rs"]
mod tests;
