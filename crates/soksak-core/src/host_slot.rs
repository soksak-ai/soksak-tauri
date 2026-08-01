// 붙어 있는 것을 담는 자리 — **한 번에 하나지, 한 번뿐이 아니다.**
//
// 프로세스가 어딘가에 붙어 산다면(저장소 주인·데몬·사이드카) 그 상대는 죽을 수 있다. 판올림,
// 강제종료, 크래시. 그때 이 프로세스가 든 것은 **죽은 연결을 든 껍데기**가 된다.
//
// 갈아탈 수 없는 자리(`OnceLock`)에 두면 그 앱은 남은 수명 내내 그 상대를 잃는다. 실측
// 2026-08-01: Tauri 앱이 cored 를 그렇게 잃었고, 저장소 읽기가 전부 실패했다. 그 실패를
// "비어 있음"으로 적는 소비자가 하나 있었고(빈 스냅샷), 그 빈 값이 사용자 워크스페이스를
// 덮었다 — 연결 하나가 못 갈아탄 결과가 데이터 소실이었다.
//
// 그래서 이 자리가 지는 규칙은 셋이다.
//   ① **죽은 것은 건네지 않는다.** 산 척하면 부른 쪽은 매번 상한까지 기다린 뒤 사유 없이 실패한다.
//   ② **새것이 자리를 가져간다.** 첫 등록을 지키면 산 것을 두고 죽은 것을 계속 든다.
//   ③ **비면 요구가 다시 세운다.** 폴링이 아니다 — 시도는 부를 일이 있을 때만 일어나고,
//      연속 실패는 바닥(`floor`)이 몰림을 막는다.
//
// 규칙은 전역이 아니라 **타입**에 있다. 전역에 두면 그 규칙을 검사할 자리가 프로세스에
// 하나뿐이라 검사끼리 서로를 밟는다.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 이 자리에 담기는 것 — 살아 있는지 스스로 답한다.
///
/// 자리는 무엇에 붙었는지 모른다. 아는 것은 하나다: **아직 붙어 있는가.**
pub trait Attachment: Send + Sync + 'static {
    fn is_open(&self) -> bool;
}

/// 자리가 비었을 때 다시 세우는 법.
pub type Rebuild<T> = Box<dyn Fn() -> Result<Arc<T>, String> + Send + Sync>;

/// 붙어 있는 것을 담는 자리.
pub struct HostSlot<T: Attachment> {
    inner: Mutex<Option<Arc<T>>>,
    rebuild: Mutex<Option<Rebuild<T>>>,
    /// 마지막 재건 시도. 실패가 이어질 때 부르는 쪽마다 다시 세우려 들지 않기 위한 바닥이다.
    last_try: Mutex<Option<Instant>>,
    floor: Duration,
}

impl<T: Attachment> HostSlot<T> {
    /// 재건 시도 사이의 최소 간격을 정해 자리를 만든다. `const` 라 전역으로 둘 수 있다.
    pub const fn with_floor(floor: Duration) -> Self {
        Self {
            inner: Mutex::new(None),
            rebuild: Mutex::new(None),
            last_try: Mutex::new(None),
            floor,
        }
    }

    /// 세운 것을 이 자리에 둔다. **갈아탄다** — 앞엣것이 죽어서 다시 세운 것이므로 첫 등록을
    /// 지키면 산 것을 두고 죽은 것을 계속 든다.
    pub fn install(&self, host: Arc<T>) {
        *self.inner.lock().unwrap_or_else(|e| e.into_inner()) = Some(host);
    }

    /// 자리가 비면 다시 세우는 법을 등록한다.
    pub fn rebuild_with(&self, f: Rebuild<T>) {
        *self.rebuild.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }

    /// 지금 **붙어 있는** 것. 세우기 전이면 없고, 연결이 끝났으면 없다 — 죽은 연결을 든
    /// 껍데기를 건네면 부른 쪽은 그것을 산 것으로 여기고 상한까지 기다린다.
    pub fn current(&self) -> Option<Arc<T>> {
        let mut slot = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some(h) if h.is_open() => Some(Arc::clone(h)),
            Some(_) => {
                *slot = None; // 끝난 연결은 자리에서 내린다
                None
            }
            None => None,
        }
    }

    /// 붙어 있으면 그것을, 아니면 **한 번 다시 세워** 돌려준다.
    pub fn live(&self) -> Option<Arc<T>> {
        if let Some(h) = self.current() {
            return Some(h);
        }
        {
            let mut last = self.last_try.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|t| t.elapsed() < self.floor) {
                return None;
            }
            *last = Some(Instant::now());
        }
        let made = {
            let guard = self.rebuild.lock().unwrap_or_else(|e| e.into_inner());
            let f = guard.as_ref()?;
            f()
        };
        match made {
            Ok(h) => {
                self.install(Arc::clone(&h));
                Some(h)
            }
            Err(why) => {
                // 못 세운 것은 이름을 달고 남는다 — 조용히 비면 "명령이 사라진다"로만 보인다.
                eprintln!("[host-slot] 다시 붙지 못했다: {why}");
                None
            }
        }
    }
}

#[cfg(test)]
#[path = "host_slot_tests.rs"]
mod tests;
