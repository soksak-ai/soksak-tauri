//! 백업 링에서 **이 프로세스의 몫** — 쓰기 신호를 걸고, 실패를 창 없는 쪽의 방식으로 고지한다.
//!
//! 언제 몇 개를 어떻게 돌리는가는 저장소 규칙이다(soksak_store::ring). 여기 남은 것은 고지뿐이고,
//! 이 프로세스에는 창이 없어 OS 알림이 없다 — 실패는 활동 원장에 남는다. 조용히 지나가지 않는
//! 것이 이 자리의 전부다: 백업 실패는 다음 사고 때에야 값을 치른다.

use crate::ctx::Ctx;

struct LedgerReporter;

impl soksak_store::ring::BackupReporter for LedgerReporter {
    fn failed(&self, detail: &str) {
        crate::control::broadcast(
            "activity",
            serde_json::json!({
                "kind": "data.backup.failed",
                "ns": "core",
                "payload": { "error": detail },
            }),
        );
        eprintln!("[cored] 백업 링 스냅샷 실패: {detail}");
    }
}

/// 쓰기 신호 — 판정과 겹침 방지는 저장소가 진다.
pub fn on_write(ctx: &Ctx) {
    soksak_store::ring::on_write(ctx.db_path(), std::sync::Arc::new(LedgerReporter));
}
