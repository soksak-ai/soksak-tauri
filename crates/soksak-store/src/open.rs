// 저장소를 **여는 절차** — 연결은 프로세스의 것이지만 여는 절차는 아니다.
//
// 한때 이 절차는 앱 폴더 안에 있었다. 앱이 유일한 백엔드이던 시절엔 그것으로 충분했다. 지금은
// 같은 홈을 앱과 cored 가 함께 보고, 앱이 아예 없는 홈에서는 cored 가 저장소를 처음 만든다.
// 절차가 두 벌이면 같은 파일을 두 프로세스가 다르게 열고, 그 차이는 오류가 아니라 **데이터의
// 성질**로 나타난다(실측 2026-07-29: cored 가 만든 홈은 전부 auto_vacuum=NONE·secure_delete=OFF).
//
// 층은 둘이다.
//   connect — 매 연결이 지나는 자리(PRAGMA·권한). 읽기 전용 프로세스도 여기까지는 온다.
//   open    — 부팅 개방. connect 에 게이트를 더한다(무결성·기본 형태·FTS 정합·쓰기 카나리아).
//             전부 쓰기이거나 비용이 있어 호출마다 돌 수 없다 — 저장소를 소유한 쪽이 한 번 한다.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::{backup, integrity, store};

/// 매 연결이 지나는 자리 — 연결 + 권한 + PRAGMA. 게이트는 없다(부팅이 아니다).
///
/// `install_sqlite_log` 이 여기 있는 이유: SQLite 내부 실패(할당 크기 포함)를 남기려면
/// `sqlite3_initialize` 이전에 걸어야 하고, 그 시점은 프로세스가 SQLite 를 **처음 쓰는** 자리다.
/// `Once` 라 두 번째 호출이 무시되는 것이 아니라 **첫 번째가 이긴다** — 누가 먼저 여느냐가
/// 곧 로그의 임자다. 저장소를 여는 길이 여기 하나뿐이어야 그 임자가 정해진다.
pub fn connect(path: &Path) -> Result<Connection, String> {
    integrity::install_sqlite_log();
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // 로컬 사용자 전용(0600) — 봉투 키·레코드를 담는 data-at-rest 저장소라 group/other 접근을
    // 차단한다(소켓 0600 선례와 동형). best-effort: :memory:·권한 미지원 FS 는 조용히 무시.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(soksak_core::store_open::STORE_FILE_MODE),
        );
    }
    // WAL: 읽기-쓰기 비차단(사이드바 읽기 중 CLI 쓰기 → 락 스톨 회피). NORMAL: WAL 에서 안전·고성능.
    // execute_batch 는 sqlite3_exec 라 journal_mode 가 돌려주는 행을 버린다(pragma_update 보다 안전).
    // 문장은 코어가 소유한다(soksak_core::store_open) — 사본을 두면 규칙이 두 벌이 된다.
    //
    // [R5] auto_vacuum=INCREMENTAL 과 secure_delete=ON 은 **첫 CREATE 전에만** 먹는다 —
    // 그래서 이 배치가 스키마보다 먼저다. 사유 원문은 store_open 머리말이 진다.
    conn.execute_batch(soksak_core::store_open::OPEN_PRAGMA_SQL)
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 저장소 전수 검사 한 번. 판정 문자열을 그대로 돌린다("ok" 가 정상).
///
/// 헤더는 멀쩡하나 내부 페이지가 손상된 저장소는 연결·DDL·부분 조회를 통과해 **부분 유실을
/// 성공으로 오인**하게 한다. 그것을 잡는 것이 이 검사다.
pub fn deep_check(conn: &Connection) -> Result<String, String> {
    conn.query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// 부팅 개방 — connect + 게이트. 저장소를 소유한 쪽이 부팅에서 **한 번** 부른다.
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = connect(path)?;
    // [P0] 깊은 손상 게이트 — 헤더는 멀쩡하나 내부 페이지가 손상된 DB 는 Connection::open·DDL·부분
    // 조회가 통과해 부분 유실을 성공으로 오인한다(비헤더 손상 무음 통과). quick_check(integrity_check
    // 경량판)로 페이지 무결성을 부팅 개방에서 확인해 손상을 복구 경로(open_or_recover)로 넘긴다. 정상
    // DB 는 "ok" 단행 반환. 비용은 부팅 개방 1회(DDL 이전에 확인 — 손상본에 스키마 변경을 얹지 않는다).
    //
    // 각 단계가 얼마나 걸렸는지 남긴다 — 이 개방은 부팅의 임계경로에 있고, 그중 quick_check 는
    // **데이터 크기에 비례해 자란다**(실측 2026-08-08: 106MB 저장소에서 1471ms, 개방 비용의
    // 99.8%). 이 비용은 저장소를 소유한 프로세스의 수명당 한 번이지 앱을 켤 때마다가 아니다 —
    // 그래서 게이트는 그대로 둔다. 다만 저장소가 자라면 그 한 번이 자란다는 사실은 재서 남긴다.
    let at = std::time::Instant::now();
    let integrity_verdict: String = deep_check(&conn)?;
    integrity::record_open_step("quick_check", at.elapsed().as_millis());
    if integrity_verdict != "ok" {
        return Err(format!("integrity check failed: {integrity_verdict}"));
    }
    let at = std::time::Instant::now();
    store::init_base(&conn)?;
    integrity::record_open_step("init_base", at.elapsed().as_millis());
    let at = std::time::Instant::now();
    // [M0] 부팅 시 FTS 정합 backstop(과거 비원자 put crash 의 orphan 청소). 멱등·저비용.
    store::reconcile_fts(&conn)?;
    integrity::record_open_step("reconcile_fts", at.elapsed().as_millis());
    let at = std::time::Instant::now();
    // 쓰기 게이트 — 위의 검사들은 전부 읽기라, 읽기는 성하고 쓰기만 무너진 저장소를 통과시킨다
    // (실측: 조회·검색·백업은 되는데 모든 레코드 쓰기가 `out of memory`. 사용자에게는 저장이
    // 조용히 실패하는 앱으로 보였다). 한 줄 써 보고 되돌린 뒤, 막혀 있으면 판정만 남긴다.
    // 고치지는 않는다 — 원인을 모르는 채 부팅마다 저장소를 자동으로 다시 쓰는 것은 증상 위에
    // 얹는 우회다. 치유는 사람·에이전트가 부르는 명시적 표면(data.repair)이 소유한다.
    // 막혀 있어도 부팅은 계속한다 — 읽기라도 살리는 편이 낫고, 실패는 쓰기마다 증거와 함께 뜬다.
    match integrity::write_canary(&conn) {
        Ok(()) => integrity::record_boot_gate("부팅 쓰기 정상"),
        Err(why) => integrity::record_boot_gate(format!("부팅 쓰기 막힘: {why}")),
    }
    integrity::record_open_step("write_canary", at.elapsed().as_millis());
    Ok(conn)
}

// 부팅 개방 실패 — detail 은 원인, quarantined 는 복구가 손상본을 옮긴 경로(재개방까지 실패했어도
// 이 값을 실어 호출 측이 사람에게 고지한다). None=격리 이전에 실패(파일 부재·복구 자체 실패).
// 무음 drop 금지 — recover 가 격리를 마친 뒤 재개방이 실패해도 격리 경로를 잃지 않는다.
#[derive(Debug)]
pub struct OpenError {
    pub detail: String,
    pub quarantined: Option<PathBuf>,
}

// 부팅 개방 — 정상이면 그대로, 손상이면 백업 슬롯에서 복구 후 재개방한다. 반환 Ok((conn, None))=정상,
// Ok((conn, Some(rec)))=복구 발생(호출 측이 사람에게 고지). 파일 부재는 실패가 아니다(open 이 신규 생성)
// → 개방 실패 후 파일이 있을 때만 손상으로 보고 복구한다. 복구 후에도 개방 실패면 격리 경로를 실어
// 전파한다(무음 drop 금지).
pub fn open_or_recover(path: &Path) -> Result<(Connection, Option<backup::Recovery>), OpenError> {
    open_or_recover_with(path, open)
}

// open_or_recover 의 검증 가능한 심 — opener 를 주입해 재개방 실패 경로를 결정적으로 재현한다(R2).
pub(crate) fn open_or_recover_with(
    path: &Path,
    opener: impl Fn(&Path) -> Result<Connection, String>,
) -> Result<(Connection, Option<backup::Recovery>), OpenError> {
    match opener(path) {
        Ok(conn) => Ok((conn, None)),
        Err(open_err) => {
            if !path.exists() {
                return Err(OpenError {
                    detail: open_err,
                    quarantined: None,
                });
            }
            let rec = backup::recover(path).map_err(|detail| OpenError {
                detail,
                quarantined: None,
            })?;
            match opener(path) {
                Ok(conn) => Ok((conn, Some(rec))),
                // 재개방 실패 — 격리 경로를 실어 전파한다(호출 측 고지의 재료).
                Err(detail) => Err(OpenError {
                    detail,
                    quarantined: Some(rec.quarantined),
                }),
            }
        }
    }
}

#[cfg(test)]
#[path = "open_tests.rs"]
mod tests;
