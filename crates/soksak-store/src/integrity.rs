// **저장소**의 자기 무결성 — 볼 수 있어야 고칠 수 있다.
//
// 설치 실행물의 무결성이 아니다. 그쪽은 soksak_core::artifact_integrity(해시 검증·stale 제거)다.
//
// 부팅 개방은 `PRAGMA quick_check` 로 페이지 무결성을 본다(mod.rs). 그런데 quick_check 는 설계상
// **인덱스와 테이블을 대조하지 않는다** — 인덱스에서 행이 빠진 손상은 그 게이트를 그냥 통과한다.
// 그 상태의 저장소는 읽기는 멀쩡하고 쓰기만 무너진다: 실측(2026-07-13)에서 SQLite 가 그 손상 위의
// 삽입에 `out of memory` 를 돌려줬고, 앱은 자기 저장소가 아프다는 것도, 어디가 아픈지도 말하지 못했다.
//
// 그래서 두 표면을 둔다. 진단(check)은 전수 대조(integrity_check)를, 치유(repair)는 REINDEX 를
// 쓴다 — 인덱스는 테이블에서 다시 만들 수 있으므로 이 치유는 데이터를 만들지도 지우지도 않는다.
// 치유 후에는 다시 진단해서 나은 것을 증명한다(고쳤다고 말만 하지 않는다).
//
// ── 자리 ──────────────────────────────────────────────────────────────────────
// 이 규칙은 `&Connection` 을 받는다. 그래서 코어(무의존)가 아니라 여기 산다 — 저장소는
// 프레임워크가 아니라 **자원**이고, 자원의 규칙은 그 자원을 여는 크레이트가 진다.
// 한때 프레임워크 폴더 안에 있었고, 그러면 백엔드가 둘이 될 때 규칙도 두 벌이 된다.

use rusqlite::Connection;

/// 전수 무결성 진단 — 문제 목록(빈 목록 = 정상). SQLite 는 정상일 때 "ok" 단행을 돌려주므로
/// 그 한 줄은 문제로 세지 않는다.
pub fn check(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let line = row.map_err(|e| e.to_string())?;
        if line != "ok" {
            out.push(line);
        }
    }
    Ok(out)
}

/// 치유 결과 — 전후 문제 목록. after 가 비지 않았다면 REINDEX 로는 낫지 않는 손상이다(테이블 자체의
/// 손상 등) — 나았다고 주장하지 않고 남은 문제를 그대로 실어 보낸다.
/// reindex_error 가 있으면 치유를 시도했지만 못 했다는 뜻이다(시도조차 안 한 것과 구분된다).
// 이 값은 프로세스를 건넌다(저장소 주인이 답하고 다른 프로세스가 읽는다) — 그래서 쓰는 쪽과
// 읽는 쪽이 **같은 모양**이어야 한다. Deserialize 가 없으면 받는 쪽이 JSON 을 손으로 다시
// 조립하고, 그 조립이 갈리는 순간 같은 이름이 두 모양을 답한다.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Repair {
    pub before: Vec<String>,
    pub after: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reindex_error: Option<String>,
}

/// 진단을 시도하되 실패를 삼키지 않는다 — 못 본 것은 "진단 실패"로 실어 치유 판단에 남긴다.
/// 진단이 실패했다고 목록이 비어 보이면(=문제 없음) 그것이 거짓 보고가 된다.
///
/// 끝내지 못한 진단은 정상도 앱 오류도 아니다 — 손상의 신호다. 그것을 오류로 던지면 호출자는
/// "저장소가 아프다"가 아니라 "명령이 실패했다"로 읽는다(실측: `out of memory` 를 머신 메모리
/// 압박으로 오독했다). 그래서 진단 표면은 이 목록을 돌려준다.
pub fn findings(conn: &Connection) -> Vec<String> {
    match check(conn) {
        Ok(problems) => problems,
        Err(e) => {
            // 전수 진단이 끝내지 못했으면 표를 하나씩 본다 — "어디가 아픈지"를 잃지 않기 위해서다.
            // 전수 진단은 한 번에 저장소 전체를 훑어 실패도 전체로 온다(무엇 때문인지 알 수 없다).
            // 표 단위 진단은 범위가 작아 통과하는 표가 대부분이고, 걸리는 표만 남는다.
            let mut out = vec![format!("진단 실패: {e}")];
            out.extend(per_table(conn));
            out
        }
    }
}

/// 표 단위 진단 — 실패한 표만 남긴다(통과한 표는 조용하다). 표 목록조차 읽지 못하면 그 사실을 싣는다.
fn per_table(conn: &Connection) -> Vec<String> {
    let tables: Vec<String> = match conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(v) => v,
        Err(e) => return vec![format!("표 목록 실패: {e}")],
    };
    let mut out = Vec::new();
    for t in tables {
        // PRAGMA integrity_check(<table>) — 그 표와 그 인덱스만 본다(SQLite 3.33+).
        let sql = format!("PRAGMA integrity_check({})", quote_ident(&t));
        match conn.prepare(&sql).and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
            Ok(rows) => {
                for line in rows {
                    if line != "ok" {
                        out.push(format!("{t}: {line}"));
                    }
                }
            }
            Err(e) => out.push(format!("{t}: 진단 실패: {e}")),
        }
    }
    out
}

// 식별자 인용 — 표 이름은 사용자/플러그인이 만든 값이라 그대로 이어 붙이지 않는다.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 인덱스를 테이블에서 다시 만든다(REINDEX). 데이터 행은 건드리지 않는다.
///
/// 치유는 진단에 매이지 않는다. 손상이 심할수록 진단이 먼저 무너지는데(실측: 인덱스 손상 위에서
/// 전수 진단과 삽입이 SQLITE_NOMEM), 진단 성공을 치유의 전제로 두면 가장 필요한 순간에 치유가
/// 닫힌다. 진단 실패는 보고에 실어 보내고 치유는 그대로 시도한다. 치유가 실패해도 진단 결과를
/// 통째로 잃지 않는다 — 무엇을 봤고 무엇을 못 했는지 둘 다 싣는다.
pub fn repair(conn: &Connection) -> Result<Repair, String> {
    let before = findings(conn);
    // 먼저 WAL 을 접는다 — 가장 싸고, 되돌릴 것이 없는 정비다. WAL 이 길게 자라면 그것을 따라가는
    // 구조(wal-index)도 함께 커지고, 그 위에서 도는 쓰기·전수 진단이 먼저 무너진다. 여기서 낫는다면
    // 손상이 아니라 자란 WAL 이 문제였다는 뜻이다.
    let checkpoint_error = conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .err()
        .map(|e| e.to_string());
    if checkpoint_error.is_none() && !findings_are_unhealed(conn) {
        // WAL 을 접는 것으로 끝났다 — 인덱스를 다시 만들 이유가 없다.
        return Ok(Repair {
            before,
            after: findings(conn),
            reindex_error: None,
        });
    }
    let mut reindex_error = conn.execute_batch("REINDEX").err().map(|e| e.to_string());
    if reindex_error.is_some() {
        // 한 번에 전부 다시 만들기가 실패하면 인덱스를 하나씩 만든다 — 전체 실패는 저장소 전체를
        // 못 고친다는 뜻이 아니다(하나가 걸리면 나머지도 함께 죽는다). 고칠 수 있는 것부터 고치고,
        // 끝내 안 되는 인덱스만 이름으로 남긴다.
        let stuck = reindex_each(conn);
        reindex_error = if stuck.is_empty() {
            None // 하나씩은 전부 성공 — 치유됐다
        } else {
            Some(format!("일괄 실패 후 개별 재작성도 실패: {}", stuck.join(", ")))
        };
    }
    // 인덱스를 다시 만들어도 진단이 낫지 않으면 남은 것은 표 자체의 물리 상태다 — VACUUM 이
    // 저장소를 논리 내용에서 통째로 다시 쓰고(행은 그대로) WAL 을 접는다. 인덱스 재작성이
    // 닿지 못하는 층이라 여기서 한 번 더 올라간다. 실패하면 그 사유를 싣는다(삼키지 않는다).
    let vacuum_error = if findings_are_unhealed(conn) {
        conn.execute_batch("VACUUM;").err().map(|e| e.to_string())
    } else {
        None
    };
    if let Some(v) = vacuum_error {
        reindex_error = Some(match reindex_error {
            Some(r) => format!("{r} / VACUUM: {v}"),
            None => format!("VACUUM: {v}"),
        });
    }
    let after = findings(conn);
    Ok(Repair {
        before,
        after,
        reindex_error,
    })
}

/// 물리 이상이 의심되는 실패에 붙일 증거 한 줄 — 그 순간의 진단 요약과 저장소 실황.
///
/// `out of memory` 만 남기고 사라지는 실패는 사후에 재현할 수 없다(실측: 파일을 밖에서 열면 멀쩡하고,
/// 앱 안에서만 무너지는 상태였다 — 원인 추적에 두 시간이 들었고 그마저 못 밝혔다). 실패한 그 순간의
/// 저장소가 자기 상태를 말하게 해 다음 발생을 추측 없이 잡는다.
///
/// `process_facts` 는 **부르는 쪽**이 준다. 프로세스 한도와 시험할당은 저장소의 사실이 아니라
/// 그것을 연 프로세스의 사실이고, 여기서 직접 캐면 이 규칙이 "이 프로세스가 무엇인가"에
/// 의존하게 된다 — 같은 코드가 프로세스마다 다른 답을 내고, 그것도 조용히.
pub fn failure_evidence(conn: &Connection, process_facts: &str) -> String {
    let f = findings(conn);
    let head = f.first().cloned().unwrap_or_else(|| "없음".to_string());
    let proc = process_facts.to_string();
    // SQLite 로그는 마지막 몇 줄만, 그것도 짧게 싣는다 — 증거는 오류 메시지에 실려 사람 눈앞까지
    // 가는데, 스물몇 줄의 SQL 전문을 그대로 실으면 화면을 삼킨다(실사고: 레일이 로그로 도배됐다).
    // 전문은 data.stats 가 따로 들고 있으니, 여기서는 무엇이 걸렸는지 알아볼 만큼만 남긴다.
    const LOG_TAIL: usize = 3;
    const LOG_LINE_MAX: usize = 90;
    let log = recent_sqlite_log();
    let proc = if log.is_empty() {
        proc
    } else {
        let tail: Vec<String> = log
            .iter()
            .rev()
            .take(LOG_TAIL)
            .rev()
            .map(|l| {
                let t: String = l.chars().take(LOG_LINE_MAX).collect();
                if l.chars().count() > LOG_LINE_MAX {
                    format!("{t}…")
                } else {
                    t
                }
            })
            .collect();
        format!("{proc} | SQLite 로그(최근 {}줄): {}", tail.len(), tail.join(" ; "))
    };
    match stats(conn) {
        Ok(s) => format!(
            "진단 {}건(첫 항목: {head}) | SQLite {} 사용 {}B 최고 {}B 한도 soft {} hard {} | 페이지 {}x{} free {} | records 인덱스 {} | {proc}",
            f.len(),
            s.sqlite_version,
            s.memory_used,
            s.memory_highwater,
            s.soft_heap_limit,
            s.hard_heap_limit,
            s.page_count,
            s.page_size,
            s.freelist_count,
            s.records_indexes,
        ),
        Err(e) => format!("진단 {}건(첫 항목: {head}) | 실황 실패: {e} | {proc}", f.len()),
    }
}

/// 메모리 압박이 지나갈 때까지 다시 해 본다 — `out of memory` 는 저장소의 상태가 아니라 그 순간의
/// 형편일 수 있다(실측: 무거운 컴파일이 도는 8초 동안 모든 레코드 쓰기가 실패했고, 컴파일이 끝나자
/// 같은 쓰기가 그대로 통과했다. 파일은 내내 성했다).
///
/// SQLite 는 이미 잠금 경합(`SQLITE_BUSY`)을 busy_timeout 으로 흡수한다. 압박 하의 `SQLITE_NOMEM` 은
/// 그 메모리판이다 — 한 번 실패했다고 사용자의 저장을 버리면, 기계가 바쁜 몇 초 때문에 데이터를
/// 잃는다. 되돌려진 트랜잭션을 다시 여는 것이라 재시도는 안전하다.
///
/// 끝내 안 되면 그대로 실패한다 — 무한히 매달리지 않는다(호출자는 응답을 기다리는 중이다).
pub fn with_nomem_retry<T>(
    attempts: u32,
    backoff: std::time::Duration,
    mut op: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    let mut waited = backoff;
    for left in (1..attempts.max(1)).rev() {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient_memory(&e) => {
                let _ = left;
                std::thread::sleep(waited);
                waited *= 2; // 압박은 몇 초 단위로 오간다 — 물러서며 기다린다
            }
            Err(e) => return Err(e),
        }
    }
    op()
}

/// 그 순간의 형편인가 — SQLite 가 돌려준 메모리 실패는 다시 하면 되는 부류다.
fn is_transient_memory(err: &str) -> bool {
    err.contains("out of memory")
}

/// 쓸 수 있는가 — 레코드 표에 한 줄 넣어 보고 되돌린다(남기지 않는다).
///
/// 읽기는 멀쩡하고 쓰기만 무너진 저장소가 실재한다(실측: 조회·검색·백업은 되는데 모든 레코드 쓰기가
/// `out of memory`). 부팅 게이트(quick_check)도 전수 진단도 그것을 잡지 못했다 — 진단은 읽기이기
/// 때문이다. 쓸 수 있는지는 써 봐야만 안다.
pub fn write_canary(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;\
         INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc)\
         VALUES('__canary__','__canary__','','probe','{}',0,0,0);\
         ROLLBACK;",
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;"); // 실패 지점에 따라 열려 있을 수 있다
        e.to_string()
    })
}

/// 아직 낫지 않았는가 — 진단이 문제를 보고하거나 진단 자체가 끝나지 못하면 낫지 않은 것이다.
fn findings_are_unhealed(conn: &Connection) -> bool {
    !findings(conn).is_empty()
}

/// 인덱스를 하나씩 재작성 — 실패한 인덱스 이름만 돌려준다(성공한 것은 조용하다).
fn reindex_each(conn: &Connection) -> Vec<String> {
    let names: Vec<String> = match conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(v) => v,
        Err(e) => return vec![format!("인덱스 목록 실패: {e}")],
    };
    let mut stuck = Vec::new();
    for n in names {
        if conn
            .execute_batch(&format!("REINDEX {}", quote_ident(&n)))
            .is_err()
        {
            stuck.push(n);
        }
    }
    stuck
}

/// 저장소 실황 — 앱 **안의** SQLite 가 자기 상태를 답한다. 밖에서 파일을 열어 보는 것은 판이 달라
/// 답이 갈리고(표현식 인덱스), 한도·메모리는 프로세스 안에서만 알 수 있다. `out of memory` 가 났을 때
/// 무엇이 굶겼는지는 이 값들로만 가려진다: 힙 한도(누군가 sqlite3_soft/hard_heap_limit 을 걸었는가),
/// 지금 쓰는 메모리와 최고치, 페이지 캐시 설정, 그리고 SQLite 판(밖의 CLI 와 다르다).
// Deserialize 도 판다 — 이 값이 소켓을 건너 다른 프로세스의 답으로 돌아온다(저장소 주인이
// 하나라 통계도 주인이 낸다). 직렬화만 있으면 부르는 쪽이 JSON 을 손으로 다시 조립하게 되고,
// 그 조립이 이 구조체와 갈리는 순간 같은 이름이 두 모양으로 답한다.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Stats {
    /// 부팅 쓰기 게이트가 남긴 판정(관측면) — 게이트는 부팅 때 한 번 돌고 사라진다. 그 결과를
    /// 읽을 수 없으면 "돌았는지" 조차 확인할 수 없어, 자가치유가 있었다고 주장만 하게 된다.
    pub boot_gate: String,
    /// SQLite 가 스스로 남긴 최근 내부 로그 — 실패한 할당의 크기가 여기에만 있다.
    pub sqlite_log: Vec<String>,
    pub sqlite_version: String,
    pub soft_heap_limit: i64,
    pub hard_heap_limit: i64,
    pub memory_used: i64,
    pub memory_highwater: i64,
    pub cache_size: i64,
    pub page_size: i64,
    pub page_count: i64,
    pub freelist_count: i64,
    pub records_indexes: i64,
}

// SQLite 자기 로그 — SQLite 는 내부 실패를 errorlog 로 남긴다(실패한 할당의 크기까지). 그것을 안 보면
// 우리에게 오는 것은 `out of memory` 한 줄뿐이고, 그 한 줄로는 무엇이 얼마를 요구하다 막혔는지 알 수
// 없다(실측: 프로세스는 그 순간 64MiB 를 받는데 SQLite 는 거절당했다 — 크기를 몰라 추적이 막혔다).
// SQLite 문서가 권하는 기본 설치물이다.
static SQLITE_LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
const SQLITE_LOG_KEEP: usize = 24;

unsafe extern "C" fn sqlite_log_cb(
    _ctx: *mut std::ffi::c_void,
    code: std::os::raw::c_int,
    msg: *const std::os::raw::c_char,
) {
    if msg.is_null() {
        return;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(msg) }
        .to_string_lossy()
        .into_owned();
    if let Ok(mut log) = SQLITE_LOG.lock() {
        if log.len() >= SQLITE_LOG_KEEP {
            log.remove(0);
        }
        log.push(format!("[{code}] {text}"));
    }
}

/// SQLite 에러 로그를 설치한다(멱등·최선노력). sqlite3_initialize 이전에 불러야 먹으므로 저장소 개방
/// 첫머리에서 한 번 부른다 — 늦게 불리면 SQLite 가 거절하고, 그때는 로그 없이 간다.
pub fn install_sqlite_log() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_config(
            rusqlite::ffi::SQLITE_CONFIG_LOG,
            sqlite_log_cb as unsafe extern "C" fn(*mut std::ffi::c_void, std::os::raw::c_int, *const std::os::raw::c_char),
            std::ptr::null_mut::<std::ffi::c_void>(),
        );
    });
}

/// 최근 SQLite 내부 로그 — 실패 증거에 싣는다.
pub fn recent_sqlite_log() -> Vec<String> {
    SQLITE_LOG.lock().map(|l| l.clone()).unwrap_or_default()
}

// 부팅 게이트 판정 보관 — 프로세스 1개당 1개. 게이트가 끝난 뒤에도 읽을 수 있어야 한다.
static BOOT_GATE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 부팅 게이트가 자기 판정을 남긴다.
pub fn record_boot_gate(verdict: impl Into<String>) {
    if let Ok(mut g) = BOOT_GATE.lock() {
        *g = verdict.into();
    }
}

fn boot_gate_verdict() -> String {
    BOOT_GATE
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "?".to_string())
}

pub fn stats(conn: &Connection) -> Result<Stats, String> {
    let one = |sql: &str| -> i64 {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .unwrap_or(-1)
    };
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(Stats {
        boot_gate: boot_gate_verdict(),
        sqlite_log: recent_sqlite_log(),
        sqlite_version: version,
        soft_heap_limit: one("PRAGMA soft_heap_limit"),
        hard_heap_limit: one("PRAGMA hard_heap_limit"),
        memory_used: unsafe { rusqlite::ffi::sqlite3_memory_used() },
        memory_highwater: unsafe { rusqlite::ffi::sqlite3_memory_highwater(0) },
        cache_size: one("PRAGMA cache_size"),
        page_size: one("PRAGMA page_size"),
        page_count: one("PRAGMA page_count"),
        freelist_count: one("PRAGMA freelist_count"),
        records_indexes: one(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND tbl_name='records'",
        ),
    })
}

#[cfg(test)]
#[path = "integrity_tests.rs"]
mod tests;
