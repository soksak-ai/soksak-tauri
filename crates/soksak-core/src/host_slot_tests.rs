// 자리는 갈아탈 수 있어야 한다.
//
// RED 근거(실측 2026-08-01): Tauri 앱이 cored 를 `OnceLock` 에 담고 있었다. cored 가 죽자 그 앱은
// 죽은 연결을 든 채 남았고, 저장소 읽기가 전부 2ms 만에 실패했다(타임아웃이 아니라 즉시 실패).
// 그 실패를 "비어 있음"으로 적는 소비자가 하나 있었고, 그 빈 값이 사용자 워크스페이스를 덮었다.
//
// 여기서 재는 것은 자리의 규칙뿐이다 — 무엇에 붙었는지는 자리가 모른다.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 살았는지 껐다 켤 수 있는 가짜 붙음.
struct Fake {
    open: AtomicBool,
}

impl Fake {
    fn live() -> Arc<Self> {
        Arc::new(Self { open: AtomicBool::new(true) })
    }
    fn die(&self) {
        self.open.store(false, Ordering::Release);
    }
}

impl Attachment for Fake {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
}

fn slot() -> HostSlot<Fake> {
    HostSlot::with_floor(Duration::from_secs(1))
}

/// 세우기 전에는 없다 — 없는 것을 있는 척하면 부른 쪽이 상한까지 기다린다.
#[test]
fn an_empty_seat_is_empty() {
    assert!(slot().current().is_none());
}

/// 붙어 있는 동안은 그대로 건넨다.
#[test]
fn a_live_host_is_handed_out() {
    let s = slot();
    s.install(Fake::live());
    assert!(s.current().is_some(), "붙어 있는데 없다고 한다");
}

/// 연결이 끝나면 그 자리는 **비어 있는 것으로 답한다.**
#[test]
fn a_dead_host_is_not_handed_out() {
    let s = slot();
    let h = Fake::live();
    s.install(Arc::clone(&h));
    h.die();
    assert!(s.current().is_none(), "죽은 연결을 든 것을 산 것처럼 건넨다");
}

/// 다시 세운 것이 자리를 **가져간다.** 첫 등록을 지키면 산 것을 두고 죽은 것을 계속 든다.
#[test]
fn a_new_host_takes_the_seat() {
    let s = slot();
    let first = Fake::live();
    let second = Fake::live();
    s.install(Arc::clone(&first));
    s.install(Arc::clone(&second));
    let now = s.current().expect("자리에 있다");
    assert!(Arc::ptr_eq(&now, &second), "첫 등록이 자리를 붙잡고 있다");
}

/// 자리가 비면 **부를 일이 있을 때** 다시 세운다. 폴링이 아니다 — 시도는 요구가 부른다.
#[test]
fn an_empty_seat_is_rebuilt_on_demand() {
    let s = slot();
    let tries = Arc::new(AtomicU64::new(0));
    let t = Arc::clone(&tries);
    s.rebuild_with(Box::new(move || {
        t.fetch_add(1, Ordering::Relaxed);
        Ok(Fake::live())
    }));
    assert!(s.current().is_none(), "세운 적 없는데 있다고 한다");
    assert!(s.live().is_some(), "다시 세우지 않았다");
    assert_eq!(tries.load(Ordering::Relaxed), 1);
    // 이미 붙었으면 다시 세우지 않는다.
    assert!(s.live().is_some());
    assert_eq!(tries.load(Ordering::Relaxed), 1, "붙어 있는데 또 세웠다");
}

/// 재건이 실패해도 부르는 쪽마다 세우려 들지 않는다 — 실패가 스폰을 부르면 몰린다.
#[test]
fn a_failing_rebuild_is_not_retried_on_every_call() {
    let s = slot();
    let tries = Arc::new(AtomicU64::new(0));
    let t = Arc::clone(&tries);
    s.rebuild_with(Box::new(move || {
        t.fetch_add(1, Ordering::Relaxed);
        Err("못 세운다".into())
    }));
    for _ in 0..5 {
        assert!(s.live().is_none(), "실패했는데 건넨다");
    }
    assert_eq!(tries.load(Ordering::Relaxed), 1, "부를 때마다 다시 세우려 든다");
}

/// 바닥이 지나면 다시 시도한다 — 한 번 실패했다고 영영 안 세우면 그것도 잃는 길이다.
#[test]
fn the_floor_expires_and_the_next_call_tries_again() {
    let s: HostSlot<Fake> = HostSlot::with_floor(Duration::ZERO);
    let tries = Arc::new(AtomicU64::new(0));
    let t = Arc::clone(&tries);
    s.rebuild_with(Box::new(move || {
        t.fetch_add(1, Ordering::Relaxed);
        Err("아직이다".into())
    }));
    assert!(s.live().is_none());
    assert!(s.live().is_none());
    assert_eq!(tries.load(Ordering::Relaxed), 2, "바닥이 지났는데 다시 안 세운다");
}

/// 세우는 법을 안 넣었으면 조용히 성공하지 않는다.
#[test]
fn a_seat_without_a_rebuild_stays_empty() {
    assert!(slot().live().is_none());
}
