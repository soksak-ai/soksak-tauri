// 저장소의 자기 무결성 — 볼 수 있어야 고칠 수 있다.
//
// 부팅 개방은 `PRAGMA quick_check` 로 페이지 무결성을 본다(mod.rs). 그런데 quick_check 는 설계상
// **인덱스와 테이블을 대조하지 않는다** — 인덱스에서 행이 빠진 손상은 그 게이트를 그냥 통과한다.
// 그 상태의 저장소는 읽기는 멀쩡하고 쓰기만 무너진다: 실측(2026-07-13)에서 SQLite 가 그 손상 위의
// 삽입에 `out of memory` 를 돌려줬고, 앱은 자기 저장소가 아프다는 것도, 어디가 아픈지도 말하지 못했다.
//
// 그래서 두 표면을 둔다. 진단(check)은 전수 대조(integrity_check)를, 치유(repair)는 REINDEX 를
// 쓴다 — 인덱스는 테이블에서 다시 만들 수 있으므로 이 치유는 데이터를 만들지도 지우지도 않는다.
// 치유 후에는 다시 진단해서 나은 것을 증명한다(고쳤다고 말만 하지 않는다).

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
#[derive(Debug, serde::Serialize)]
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
pub fn failure_evidence(conn: &Connection) -> String {
    let f = findings(conn);
    let head = f.first().cloned().unwrap_or_else(|| "없음".to_string());
    let proc = process_memory_probe();
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

/// 프로세스가 정말 메모리를 못 받는가 — 한도와 실제 할당 가능 여부를 그 순간에 확인한다.
///
/// SQLite 의 `out of memory` 는 저장소가 아파서일 수도, 프로세스가 굶어서일 수도 있다. 그 둘은 사후에
/// 구분할 수 없다(파일은 밖에서 열면 멀쩡하고, 프로세스는 이미 사라졌다). 그래서 실패한 자리에서
/// 직접 재 본다: 한도가 걸려 있는가, 지금 64MiB 를 받을 수 있는가.
fn process_memory_probe() -> String {
    let lim = |res: libc::c_int| -> String {
        let mut rl = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(res, &mut rl) } == 0 {
            if rl.rlim_cur == libc::RLIM_INFINITY {
                "무제한".to_string()
            } else {
                format!("{}B", rl.rlim_cur)
            }
        } else {
            "?".to_string()
        }
    };
    // 64MiB 시험 할당 — 성공하면 프로세스는 굶지 않은 것이고, 그 `out of memory` 는 저장소 쪽 신호다.
    const PROBE: usize = 64 * 1024 * 1024;
    let got = {
        let p = unsafe { libc::malloc(PROBE) };
        if p.is_null() {
            false
        } else {
            unsafe { libc::free(p) };
            true
        }
    };
    format!(
        "프로세스 한도 DATA {} AS {} | 64MiB 시험할당 {}",
        lim(libc::RLIMIT_DATA),
        lim(libc::RLIMIT_AS),
        if got { "성공" } else { "실패" }
    )
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
#[derive(Debug, serde::Serialize)]
pub struct Stats {
    /// 부팅 쓰기 게이트가 남긴 판정(관측면) — 게이트는 부팅 때 한 번 돌고 사라진다. 그 결과를
    /// 읽을 수 없으면 "돌았는지" 조차 확인할 수 없어, 자가치유가 있었다고 주장만 하게 된다.
    pub boot_gate: String,
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
mod tests {
    use super::*;

    // 실제로 만난 손상의 모양 — **논리적 불일치**다: 인덱스 안의 항목이 테이블의 현재 내용과
    // 맞지 않는다("row N missing from index"). 페이지를 깨는 것과 다르다 — 페이지는 멀쩡해서
    // quick_check 는 통과하고, 인덱스↔테이블 대조를 하는 전수 진단만 그것을 본다.
    // 재현: 인덱스 항목은 k 로 채워 두고 선언만 j 로 바꾼다(writable_schema).
    fn desync_index(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_schema SET sql='CREATE INDEX idx_k ON t(j)' WHERE name='idx_k';
             PRAGMA writable_schema=OFF;",
        )
        .unwrap();
    }

    // 테스트 DB — ring.rs 와 같은 규약(temp_dir + pid). 호출마다 다른 이름으로 격리한다.
    fn scratch() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p =
            std::env::temp_dir().join(format!("soksak-integrity-{}-{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn seeded(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, j TEXT);
             CREATE INDEX idx_k ON t(k);",
        )
        .unwrap();
        for i in 0..200 {
            conn.execute(
                "INSERT INTO t(k, j) VALUES (?1, ?2)",
                [format!("key-{i}"), format!("other-{i}")],
            )
            .unwrap();
        }
    }

    #[test]
    fn healthy_store_reports_no_problems() {
        let db = scratch();
        seeded(&db);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(check(&conn).unwrap(), Vec::<String>::new());
    }

    // 부팅 게이트가 이 손상을 못 본다는 것이 이 결함의 핵심 — quick_check 는 통과하고
    // integrity_check 만 문제를 본다. 그래서 진단 표면은 전수 대조여야 한다.
    #[test]
    fn a_broken_index_is_invisible_to_quick_check_and_visible_to_the_full_check() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        let quick: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quick, "ok", "부팅 게이트는 이 손상을 통과시킨다");
        assert!(
            !check(&conn).unwrap().is_empty(),
            "전수 진단은 이 손상을 본다"
        );
    }

    #[test]
    fn repair_rebuilds_the_index_and_proves_it() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        let r = repair(&conn).unwrap();
        assert!(!r.before.is_empty(), "치유 전에는 문제가 있었다");
        assert_eq!(r.after, Vec::<String>::new(), "치유 후에는 없다");
        assert!(r.reindex_error.is_none(), "치유는 성공했다");

        // 행은 하나도 잃지 않았다 — 인덱스만 다시 만든 것이다.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 200);
    }

    // 실물 저장소 진단 프로브(수동) — 앱과 **같은** SQLite(번들 rusqlite)로 사본을 본다. 밖의
    // sqlite3 CLI 는 판이 달라 표현식 인덱스에 유령 손상을 보고한다(실측) — 그 답으로 저장소를
    // 판정하면 안 된다. 사본에 대고 진단·치유를 돌려 "이 손상이 REINDEX 로 낫는가"를 실물로
    // 가른다. 라이브 저장소는 건드리지 않는다(사본 경로만 받는다).
    //
    //   SOKSAK_PROBE_DB=/path/to/copy.db cargo test probe_store_copy -- --ignored --nocapture
    #[test]
    #[ignore = "수동 진단 — SOKSAK_PROBE_DB 로 사본 경로를 준다"]
    fn probe_store_copy() {
        let path = std::env::var("SOKSAK_PROBE_DB").expect("SOKSAK_PROBE_DB 필요(사본 경로)");
        // SOKSAK_PROBE_OPEN=app 이면 앱과 같은 개방 절차(PRAGMA·부팅 게이트·스키마·FTS 정합)를 그대로
        // 탄다 — 밖에서 파일만 열어 보는 것과 앱이 여는 것이 다르면 그 차이가 원인이기 때문이다.
        let conn = if std::env::var("SOKSAK_PROBE_OPEN").as_deref() == Ok("app") {
            println!("open: app(super::open)");
            crate::data::open(std::path::Path::new(&path)).expect("앱 개방 절차")
        } else {
            println!("open: plain");
            Connection::open(&path).expect("사본 열기")
        };
        // 앱과 같은 조건으로 본다 — 개방 PRAGMA 가 다르면 답도 다르다(temp_store 가 특히 그렇다:
        // MEMORY 면 무거운 연산이 디스크로 흘리지 못하고 메모리만 요구한다).
        if let Ok(pragmas) = std::env::var("SOKSAK_PROBE_PRAGMAS") {
            conn.execute_batch(&pragmas).expect("프로브 PRAGMA");
            println!("pragmas: {pragmas}");
        }
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        println!("sqlite: {version}");
        // 연산별 메모리 수요 — 무엇이 얼마를 요구하는지 모르면 구조를 고칠 근거가 없다.
        let hw = || unsafe { rusqlite::ffi::sqlite3_memory_highwater(1) } as f64 / 1_048_576.0;
        let used = || unsafe { rusqlite::ffi::sqlite3_memory_used() } as f64 / 1_048_576.0;
        let _ = hw(); // 기준선 리셋
        let t = std::time::Instant::now();
        let all = findings(&conn);
        println!(
            "진단(전체): {:?} | 최고 {:.1}MB | 현재 {:.1}MB | {:?}",
            all,
            hw(),
            used(),
            t.elapsed()
        );

        let _ = hw();
        let t = std::time::Instant::now();
        let rec: Result<Vec<String>, _> = conn
            .prepare("PRAGMA integrity_check(\"records\")")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            });
        println!(
            "진단(records): {:?} | 최고 {:.1}MB | {:?}",
            rec.map(|v| v.len()),
            hw(),
            t.elapsed()
        );

        let _ = hw();
        let t = std::time::Instant::now();
        let w = conn.execute_batch(
            "BEGIN; INSERT INTO records(ns,coll,id,scope,doc,created,updated) \
             VALUES('probe','probe','p1','','{\"a\":1}',1,1); ROLLBACK;",
        );
        println!(
            "쓰기(records INSERT): {:?} | 최고 {:.1}MB | {:?}",
            w.err().map(|e| e.to_string()),
            hw(),
            t.elapsed()
        );

        // FTS5 쓰기 — 실물에서 이 경로만 무너졌다(FTS 선언 컬렉션의 put 만 실패, 없는 것은 성공).
        // 각 FTS 표에 DELETE+INSERT 를 넣어 보고(롤백) 어느 표가 무너지는지 지목한다.
        let fts_tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts\\_%' ESCAPE '\\' \
                 AND name NOT LIKE '%\\_data' ESCAPE '\\' AND name NOT LIKE '%\\_idx' ESCAPE '\\' \
                 AND name NOT LIKE '%\\_content' ESCAPE '\\' AND name NOT LIKE '%\\_docsize' ESCAPE '\\' \
                 AND name NOT LIKE '%\\_config' ESCAPE '\\'",
            )
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default();
        for tbl in &fts_tables {
            let _ = hw();
            let t = std::time::Instant::now();
            let sql = format!(
                "BEGIN; DELETE FROM \"{tbl}\" WHERE rowid=999999999; \
                 INSERT INTO \"{tbl}\"(rowid, text) VALUES(999999999, '프로브 probe text'); ROLLBACK;"
            );
            match conn.execute_batch(&sql) {
                Ok(()) => println!("FTS 쓰기 {tbl}: ok | 최고 {:.1}MB | {:?}", hw(), t.elapsed()),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    println!("FTS 쓰기 {tbl}: 실패 {e} | 최고 {:.1}MB", hw());
                }
            }
        }

        let _ = hw();
        let t = std::time::Instant::now();
        let r = repair(&conn).expect("치유 보고");
        println!(
            "치유(REINDEX): 오류 {:?} | 최고 {:.1}MB | {:?}",
            r.reindex_error,
            hw(),
            t.elapsed()
        );
    }

    // 진단 자체가 무너지는 손상 — 페이지 헤더가 깨지면 전수 진단은 문제 목록을 돌려주는 게 아니라
    // 오류로 끝난다(실측한 저장소에서는 `out of memory` 였다: 인덱스 손상 위의 진단·삽입이
    // SQLITE_NOMEM). 커넥션 밖으로 새는 전역 설정(hard_heap_limit 은 프로세스 전역이다)을 쓰지
    // 않기 위해 파일을 직접 깨뜨린다.
    fn corrupt_header(path: &std::path::Path) {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        f.write_all(&[0xFFu8; 100]).unwrap();
        f.flush().unwrap();
    }

    // 표 단위 진단은 손상을 가진 표를 지목한다 — 전수 진단이 통째로 무너져도 범위를 좁힐 수 있어야
    // "어디가 아픈지"를 말할 수 있다.
    #[test]
    fn per_table_names_the_sick_table() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        let per = per_table(&conn);
        assert!(
            per.iter().any(|p| p.starts_with("t:")),
            "손상을 가진 표를 지목한다: {per:?}",
        );
    }

    // 개별 재작성은 성한 저장소에서 아무 것도 남기지 않는다(전부 성공) — 그리고 손상 위에서도
    // 고칠 수 있는 인덱스를 고친다. 전체 REINDEX 한 번의 성패로 치유를 끝내지 않는다.
    #[test]
    fn reindex_each_rebuilds_every_index() {
        let db = scratch();
        seeded(&db);
        desync_index(&db);

        let conn = Connection::open(&db).unwrap();
        assert_eq!(reindex_each(&conn), Vec::<String>::new(), "전부 다시 만들어진다");
        assert_eq!(check(&conn).unwrap(), Vec::<String>::new(), "손상이 사라진다");
    }

    // 증거는 성한 저장소에서도 답을 내야 한다 — 실패 순간에만 쓰는 코드가 그때 처음 돌면 그 자체가
    // 또 하나의 미지수다. 손상 위에서는 무엇이 문제인지 첫 항목으로 싣는다.
    #[test]
    fn failure_evidence_speaks_on_both_healthy_and_sick_stores() {
        let db = scratch();
        seeded(&db);
        let conn = Connection::open(&db).unwrap();
        let healthy = failure_evidence(&conn);
        assert!(healthy.contains("진단 0건"), "성한 저장소: {healthy}");
        assert!(healthy.contains("SQLite"), "실황을 싣는다: {healthy}");

        desync_index(&db);
        let conn2 = Connection::open(&db).unwrap();
        let sick = failure_evidence(&conn2);
        assert!(!sick.contains("진단 0건"), "아픈 저장소는 문제를 싣는다: {sick}");
    }

    // 카나리는 성한 저장소에서 통과하고, 흔적을 남기지 않는다 — 부팅마다 도는 검사가 데이터를
    // 남기면 그 자체가 오염이다.
    #[test]
    fn write_canary_passes_and_leaves_nothing() {
        let db = scratch();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE records (ns TEXT NOT NULL, coll TEXT NOT NULL, scope TEXT NOT NULL,\
             id TEXT NOT NULL, doc TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,\
             enc INTEGER NOT NULL DEFAULT 0, keyId TEXT, PRIMARY KEY(ns, coll, id));",
        )
        .unwrap();

        write_canary(&conn).expect("성한 저장소는 쓸 수 있다");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "카나리는 흔적을 남기지 않는다");

        // 두 번 돌려도 같다(멱등) — 부팅마다 도는 검사의 최소 조건.
        write_canary(&conn).expect("두 번째도 통과");
    }

    #[test]
    fn per_table_is_quiet_on_a_healthy_store() {
        let db = scratch();
        seeded(&db);
        let conn = Connection::open(&db).unwrap();
        assert_eq!(per_table(&conn), Vec::<String>::new(), "성한 표는 조용하다");
    }

    // 손상이 심하면 진단이 먼저 무너진다. 그때 치유를 진단에 매어 두면 — 가장 필요한 순간에
    // 치유가 닫힌다. 치유는 진단 실패에 막히지 않고, 못 본 것은 "진단 실패"로 실어 보낸다.
    // (진단이 실패했는데 문제 목록이 비어 보이면 그것이 거짓 보고다.)
    #[test]
    fn a_failed_diagnosis_does_not_block_healing() {
        let db = scratch();
        seeded(&db);
        corrupt_header(&db);

        let conn = Connection::open(&db).unwrap();
        assert!(check(&conn).is_err(), "이 손상에서 진단은 오류로 끝난다");

        let r = repair(&conn).expect("진단이 실패해도 치유 보고는 돌아온다");
        assert!(
            r.before.iter().any(|p| p.contains("진단 실패")),
            "못 본 것을 못 봤다고 싣는다: {:?}",
            r.before
        );
        // 치유가 실패했다면 그 사유도 싣는다 — 시도조차 안 한 것과 구분된다.
        assert!(
            r.reindex_error.is_some(),
            "이 손상에서는 REINDEX 도 실패한다 — 그 사유를 실어야 한다",
        );
    }
}
