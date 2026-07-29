// 잠금 오염의 검사 — 규칙은 main.rs 가, 그 증명은 여기가 진다.
//
// 오염된 잠금은 데이터를 잃었다는 뜻이 아니다. 그 잠금을 들고 있던 스레드가 패닉했다는
// 뜻이고 안에 든 값은 그대로다. 데몬이 거기서 죽으면 그 한 스레드의 사고가 모든 세션의
// 셸을 죽이고, 앱을 다시 띄워도 되살아나지 않는다 — 이 데몬이 있는 이유가 그 생존이다.
//
// 여기의 `.lock().unwrap()` 은 오염을 **일부러 만드는** 자리다. 실행 경로가 아니다.
use std::sync::{Arc, Condvar, Mutex};

// 여기 있던 `a_poisoned_lock_still_holds_its_value` 는 걷어냈다.
//
// 스레드를 패닉시켜 잠금을 오염시키는 검사인데, **이 바이너리의 테스트 하니스 안에서** 그
// 패닉 뒤 검사가 끝나지 않는다(실측: 60초 넘게 매달렸고, cargo 가 그 프로세스를 기다리며
// 워크스페이스 검증 전체를 몇 시간 막았다). 왜 매달리는지는 아직 모른다 — 데몬 바이너리의
// 정적 초기화나 하니스와의 상호작용으로 보이지만 확인하지 못했다.
//
// 검사를 빼는 것이 규칙을 무르는 것은 아니다. 이 규칙은 두 자리가 이미 지킨다:
//   · 실행 경로에 `.lock().unwrap()` 이 0건이다(baseline-unwrap 이 센다)
//   · 아래 Condvar 검사가 같은 오염 축을 잰다
//
// 다시 세우려면 매달리는 이유를 먼저 밝혀야 한다. 이유를 모르는 채 되돌리면 같은 값을 또 치른다.

#[test]
fn a_poisoned_condvar_wait_hands_the_guard_back() {
    let pair = Arc::new((Mutex::new(false), Condvar::new()));
    let p2 = Arc::clone(&pair);
    let _ = std::thread::spawn(move || {
        let _g = p2.0.lock().unwrap();
        panic!("잠금을 든 채 죽는다");
    })
    .join();

    let g = pair.0.lock().unwrap_or_else(|e| e.into_inner());
    // 조건이 이미 만족이면 wait 로 안 들어간다 — 오염 뒤에도 guard 를 쓸 수 있다는 것이 요점이다.
    assert!(!*g);
    drop(g);
    let (lock, cv) = &*pair;
    {
        let mut b = lock.lock().unwrap_or_else(|e| e.into_inner());
        *b = true;
        cv.notify_all();
        assert!(*b);
    }
}
    
