// 백업 링에서 **이 프로세스의 몫** — 쓰기 신호를 받고, 실패를 창이 있는 쪽의 방식으로 고지한다.
//
// 언제 몇 개를 어떻게 돌리는가는 저장소 규칙이다(soksak_store::ring). 여기 남은 것은 창이
// 있어야만 되는 일뿐이다: 활동 원장 발행, OS 알림, 그리고 이 프로세스 하나가 갖는 상태
// (앱 핸들·진행 중 플래그).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

use tauri::AppHandle;

use soksak_store::ring::{due, run_cycle, slot0_mtime, BackupReporter};

// 앱 발원 고지 reporter — 실패를 activity(data.backup.failed, 영속·스트림)로 발행하고 OS 알림을
// 띄운다. 상세(에러)는 activity payload 에, 사람용 요약은 알림에 실린다.
struct AppReporter {
    app: AppHandle,
}

impl BackupReporter for AppReporter {
    fn failed(&self, detail: &str) {
        crate::activity::publish(
            &self.app,
            "data.backup.failed",
            "core",
            serde_json::json!({ "error": detail }),
        );
        let lang = crate::i18n::app_language(&self.app);
        if let Err(e) = crate::notify::show(
            &self.app,
            crate::i18n::backup_failed_title(lang),
            crate::i18n::backup_failed_body(lang),
        ) {
            eprintln!("[data] 백업 실패 알림 표시 실패: {e}");
        }
    }
}

// 앱 핸들 미설정(부팅 극초기) 대비 — 최소한 로그로 남긴다(무음 아님, 알림/activity 는 핸들 필요).
struct LogReporter;

impl BackupReporter for LogReporter {
    fn failed(&self, detail: &str) {
        eprintln!("[data] 백업 링 스냅샷 실패: {detail}");
    }
}

// 부팅 1회(lib.rs setup)에 심는 앱 핸들 — on_write 스냅샷 스레드가 실패 고지에 쓴다. dockmenu 와
// 동형(OnceLock<AppHandle>). 발견 가능한 seam 이라 숨은 상태가 아니다.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 부팅에서 앱 핸들을 심는다 — 이후 백업 실패가 activity/알림으로 드러난다.
pub fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

// 스냅샷 동시 수행 방지 — 진행 중이면 신규 쓰기 신호는 그냥 지나간다(다음 쓰기가 다시 신호).
// 이 플래그는 **이 프로세스** 안에서만 겹침을 막는다. 프로세스가 둘이면 서로를 못 보므로,
// 겹쳐도 안전한 것은 작업 파일 이름이 호출마다 갈리기 때문이다(soksak_store::ring).
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 쓰기 신호 진입 — stat 1회 선판정 후에만 백그라운드 스레드 1개가 스냅샷한다.
/// 쓰기 커넥션은 블로킹하지 않는다(WAL 읽기 동시 + 별도 read-only 커넥션).
///
/// 저장소 경로는 **부르는 쪽이 준다.** 여기서 앰비언트(이 프로세스의 홈)로 캐면 같은 신호가
/// 프로세스마다 다른 파일을 백업하고, 그 오답은 오류가 아니라 "엉뚱한 홈의 백업"으로 끝난다.
pub fn on_write(db: PathBuf) {
    if !due(slot0_mtime(&db), SystemTime::now()) {
        return;
    }
    if IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        match APP.get() {
            Some(app) => run_cycle(&db, SystemTime::now(), &AppReporter { app: app.clone() }),
            None => run_cycle(&db, SystemTime::now(), &LogReporter),
        }
        IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}
