// 저장소 무결성의 검사 — 규칙은 integrity.rs 가, 그 증명은 여기가 진다.
//
// 손상을 **심어서** 잰다. 심지 않고 통과만 보면 게이트가 눈을 감은 것과 구분되지 않는다.
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
        // 앱 개방 절차(PRAGMA·부팅 게이트·스키마·FTS 정합)는 아직 프레임워크에 있다.
        // data/mod.rs 가 이 크레이트로 오면 이 갈래가 그것을 그대로 탄다 — 그때까지는
        // 조용히 다른 것을 열지 않고 이름을 달고 멈춘다.
        panic!("앱 개방 절차는 아직 프레임워크에 있다 — data/mod.rs 이관 뒤 이 갈래가 선다")
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
    let healthy = failure_evidence(&conn, "프로세스 사실(검사 주입)");
    assert!(healthy.contains("진단 0건"), "성한 저장소: {healthy}");
    assert!(healthy.contains("SQLite"), "실황을 싣는다: {healthy}");

    desync_index(&db);
    let conn2 = Connection::open(&db).unwrap();
    let sick = failure_evidence(&conn2, "프로세스 사실(검사 주입)");
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

// 압박이 지나가면 같은 쓰기가 통과한다 — 그 몇 초 때문에 사용자의 저장을 버리지 않는다.
#[test]
fn a_write_starved_by_pressure_is_retried_until_it_passes() {
    let mut tries = 0;
    let out = with_nomem_retry(4, std::time::Duration::from_millis(1), || {
        tries += 1;
        if tries < 3 {
            Err("out of memory".to_string())
        } else {
            Ok("저장됨")
        }
    });
    assert_eq!(out.unwrap(), "저장됨");
    assert_eq!(tries, 3, "압박이 풀린 시도에서 통과한다");
}

// 메모리와 무관한 실패는 즉시 올린다 — 잘못된 쓰기를 반복하는 것은 재시도가 아니라 고집이다.
#[test]
fn a_real_error_is_not_retried() {
    let mut tries = 0;
    let out: Result<(), String> = with_nomem_retry(4, std::time::Duration::from_millis(1), || {
        tries += 1;
        Err("UNIQUE constraint failed".to_string())
    });
    assert!(out.is_err());
    assert_eq!(tries, 1, "한 번만 시도한다");
}

// 끝내 안 되면 실패한다 — 무한히 매달리지 않는다.
#[test]
fn retry_gives_up_and_reports() {
    let mut tries = 0;
    let out: Result<(), String> = with_nomem_retry(3, std::time::Duration::from_millis(1), || {
        tries += 1;
        Err("out of memory".to_string())
    });
    assert!(out.is_err());
    assert_eq!(tries, 3, "정해진 횟수만 시도한다");
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
