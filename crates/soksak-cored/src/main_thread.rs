//! 메인스레드 — 엔진 모델이 요구하는 그 한 자리.
//!
//! 엔진 사이드카의 init·shutdown 은 **메인스레드 계약**이다(docs/SIDECARS.md §3). 그 계약은
//! 창을 요구하지 않는다: 요구하는 것은 "이 프로세스의 첫 스레드에서 돈다"는 사실 하나뿐이고,
//! 그것은 창이 없는 프로세스도 줄 수 있다.
//!
//! 그래서 메인스레드를 accept 루프에 내주지 않는다. accept 는 어느 스레드에서나 같은 답을
//! 내지만 엔진 init 은 그렇지 않다 — 자리를 잘못 주면 그 계약을 이 프로세스는 영영 못 지킨다.
//!
//! 표면은 여기 없다. `Framework::surface_alive` 가 기본구현으로 비어 있는 것이 그 뜻이다 —
//! 네이티브 자식 표면이 없는 호스트는 편입할 것이 없다. 표면이 필요한 엔진은 그 표면을 가진
//! 프로세스가 열어야 하고, 그 사실은 그쪽이 이름을 달고 말한다.

use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::OnceLock;

type Job = Box<dyn FnOnce() + Send>;

static QUEUE: OnceLock<SyncSender<Job>> = OnceLock::new();

/// 부팅에서 한 번 — 큐를 세우고 받는 쪽을 돌려준다. 두 번째 설치는 무시된다(메인스레드는 하나다).
pub fn install() -> Option<Receiver<Job>> {
    // 상한을 둔다. 무한 큐는 밀린 일을 숨기고, 숨은 밀림은 랑데부 상한으로만 드러난다.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(64);
    if QUEUE.set(tx).is_err() {
        return None;
    }
    Some(rx)
}

/// 메인스레드에서 돈다. 큐가 없으면(부팅이 안 세웠으면) 이름을 달고 실패한다 — 여기서 그냥
/// 부르면 부른 스레드에서 돌고, 엔진은 그 사실을 모른 채 계약이 지켜졌다고 믿는다.
pub fn run_on_main(job: Job) -> Result<(), String> {
    let Some(tx) = QUEUE.get() else {
        return Err("이 프로세스는 메인스레드 자리를 세우지 않았다 — 엔진 init 을 맡길 수 없다".into());
    };
    tx.send(job)
        .map_err(|_| "메인스레드가 이미 내려갔다".to_string())
}

/// 메인스레드의 몸 — 큐가 닫힐 때까지 일을 받아 돈다. **이 함수가 반환하면 프로세스가 끝난다.**
pub fn pump(rx: Receiver<Job>) {
    for job in rx {
        job();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 세우지 않은 자리에 맡기면 조용히 남의 스레드에서 돌지 않는다 — 이름을 달고 실패한다.
    #[test]
    fn without_the_seat_the_job_is_refused_not_silently_run() {
        // QUEUE 는 프로세스 전역이라 이 검사는 install 전에만 참이다. 설치 여부와 무관하게
        // **조용한 실행이 없다**는 것만 잰다: 성공했다면 그것은 큐에 올랐다는 뜻이다.
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let r = ran.clone();
        let out = run_on_main(Box::new(move || {
            r.store(true, std::sync::atomic::Ordering::SeqCst)
        }));
        if out.is_err() {
            assert!(
                !ran.load(std::sync::atomic::Ordering::SeqCst),
                "거절했는데 일이 돌았다 — 부른 스레드에서 돈 것이다"
            );
        }
    }
}
