// 백업 링에서 **이 프로세스의 몫** — 쓰기 신호를 받고, 실패를 창이 있는 쪽의 방식으로 고지한다.
//
// 언제 몇 개를 어떻게 돌리는가는 저장소 규칙이다(soksak_store::ring). 여기 남은 것은 창이
// 있어야만 되는 일뿐이다: 활동 원장 발행, OS 알림, 그리고 이 프로세스 하나가 갖는 상태
// (앱 핸들·진행 중 플래그).

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::AppHandle;

use soksak_store::ring::BackupReporter;

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

/// 쓰기 신호 — 판정과 겹침 방지는 저장소가 지고, 이 자리는 **누가 알리는가**만 고른다.
pub fn on_write(db: PathBuf) {
    let reporter: std::sync::Arc<dyn BackupReporter + Send + Sync> = match APP.get() {
        Some(app) => std::sync::Arc::new(AppReporter { app: app.clone() }),
        None => std::sync::Arc::new(LogReporter),
    };
    soksak_store::ring::on_write(db, reporter);
}
