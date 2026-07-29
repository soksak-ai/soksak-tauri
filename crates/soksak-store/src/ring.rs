// 백업 링의 규칙 — 몇 개를, 언제, 어떻게 돌리는가.
//
// 트리거는 쓰기 사실뿐이다(폴링 0): 쓴 쪽이 신호를 준다. 그 신호를 받는 자리는 프로세스마다
// 다르지만 게이트·회전·슬롯 규칙은 하나여야 한다 — 두 벌이면 앱이 만든 슬롯과 다른 프로세스가
// 만든 슬롯이 서로 다른 규칙으로 돌고, 그 차이는 오류가 아니라 "복구할 백업이 없다"로 나타난다.
//
// 게이트는 최신 슬롯(.bak.0) mtime 1시간(now 를 주입받아 결정적). 스냅샷은 별도 read-only
// 커넥션의 VACUUM INTO(쓰기 커넥션 비블로킹) → 임시 파일 → 성공 시에만 회전(.bak.3→4 …
// .bak.0→1) → rename 원자 편입. 슬롯 5개 고정(soksak.db.bak.0=최신 … .bak.4).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};

/// 링 슬롯 수 — .bak.0(최신) ~ .bak.4(최고령).
pub const SLOTS: usize = 5;

/// 백업 간 최소 간격 — 최신 슬롯 mtime 게이트.
const MIN_INTERVAL: Duration = Duration::from_secs(3600);

/// i번째 슬롯 경로 — `<db>.bak.<i>`.
pub fn slot_path(db_path: &Path, i: usize) -> PathBuf {
    PathBuf::from(format!("{}.bak.{i}", db_path.to_string_lossy()))
}

/// 스냅샷을 짓는 작업 파일 이름 — **부를 때마다 다르다.**
///
/// 이름이 고정(`<db>.bak.tmp`)이면 같은 저장소를 회전하는 둘이 서로의 작업 파일을 밟는다.
/// 백엔드가 하나뿐이던 시절엔 그런 둘이 없었지만, 지금은 앱과 cored 가 같은 홈을 본다.
/// 밟히면 한쪽이 "크래시 잔재 정리"로 남의 진행 중 파일을 지우고, 남은 쪽의 VACUUM INTO 는
/// 사라진 파일에 쓰거나 이미 있는 파일을 거부한다. 그 실패는 백업이 조용히 안 생기는 것으로
/// 끝나고, 없는 백업은 저장소가 깨지고 나서야 발견된다.
fn snapshot_tmp_path(db_path: &Path) -> PathBuf {
    // pid 는 프로세스를 가르고, 번호는 한 프로세스 안의 동시 회전을 가른다.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!(
        "{}.bak.tmp.{}.{n}",
        db_path.to_string_lossy(),
        std::process::id()
    ))
}

/// 게이트(순수) — 최신 슬롯 mtime 과 now 주입으로 결정적. 슬롯 없음=즉시 due,
/// 1시간 경과=due, 미래 mtime(시계 역행)=보류.
pub fn due(slot0_mtime: Option<SystemTime>, now: SystemTime) -> bool {
    match slot0_mtime {
        None => true,
        Some(m) => now
            .duration_since(m)
            .map(|d| d >= MIN_INTERVAL)
            .unwrap_or(false),
    }
}

/// 최신 슬롯의 mtime — 게이트의 유일한 입력. 쓰기 신호를 받는 쪽이 stat 1회로 선판정한다.
pub fn slot0_mtime(db_path: &Path) -> Option<SystemTime> {
    std::fs::metadata(slot_path(db_path, 0))
        .ok()
        .and_then(|m| m.modified().ok())
}

/// 쓰기 신호 1회 처리 — 게이트 통과 시 스냅샷+회전. 반환=수행 여부.
pub fn tick(db_path: &Path, now: SystemTime) -> Result<bool, String> {
    if !due(slot0_mtime(db_path), now) {
        return Ok(false);
    }
    snapshot_rotate(db_path)?;
    Ok(true)
}

/// 스냅샷+회전 — read-only 커넥션의 VACUUM INTO 가 작업 파일을 만들고, 성공 쓰기
/// 이후에만 회전(.bak.3→4 … .bak.0→1) 뒤 tmp→.bak.0 rename 으로 원자 편입한다.
fn snapshot_rotate(db_path: &Path) -> Result<(), String> {
    let tmp = snapshot_tmp_path(db_path);
    // 이 이름은 이 호출만의 것이다 — 남의 작업 파일을 지울 여지가 없다. 그래도 지우는 이유는
    // VACUUM INTO 가 기존 파일을 거부하기 때문이다(같은 pid·같은 번호가 다시 나오는 재시작 잔재).
    let _ = std::fs::remove_file(&tmp);
    {
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let p = tmp.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{p}';"))
            .map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(slot_path(db_path, SLOTS - 1));
    for i in (0..SLOTS - 1).rev() {
        let from = slot_path(db_path, i);
        if from.exists() {
            std::fs::rename(&from, slot_path(db_path, i + 1)).map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&tmp, slot_path(db_path, 0)).map_err(|e| e.to_string())
}

// 백업 실패 고지 대상 — 무음 폴백 금지(전 폴백은 고지를 남긴다). tick 실패(특히 손상 신호)를
// 삼키지 않고 여기로 흘려 관찰 가능하게 만든다. 고지 수단은 프로세스마다 다르므로(창 있는 쪽은
// 알림, 없는 쪽은 로그) 규칙은 이 seam 만 알고 구현은 부르는 쪽이 준다.
pub trait BackupReporter {
    fn failed(&self, detail: &str);
}

/// 백업 1주기 — 게이트 통과 시 스냅샷하고, 실패는 reporter 로 고지한다(삼킴 금지).
pub fn run_cycle(db_path: &Path, now: SystemTime, reporter: &dyn BackupReporter) {
    if let Err(e) = tick(db_path, now) {
        reporter.failed(&e);
    }
}

#[cfg(test)]
#[path = "ring_tests.rs"]
mod tests;
