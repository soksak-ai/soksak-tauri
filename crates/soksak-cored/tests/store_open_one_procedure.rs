// 저장소를 여는 절차는 **한 벌**이다 — 앱이 열든 이 프로세스가 열든 같은 문을 지난다.
//
// 앱의 부팅 개방은 PRAGMA 만 거는 것이 아니라 게이트를 지난다: 페이지 무결성(quick_check),
// 기본 형태(init_base), FTS 정합, 쓰기 카나리아. 이 프로세스는 그중 PRAGMA 와 형태만 했다.
//
// 빠진 게이트 중 조용한 것이 무결성이다. 헤더(page 1)가 멀쩡하고 내부 페이지만 깨진 저장소는
// 맨 개방·DDL·부분 조회를 전부 통과한다 — 그래서 이 프로세스는 손상된 저장소를 정상으로 알고
// 서빙을 시작했고, 부분 유실이 성공으로 보였다. 그 홈에는 앱이 없어서 아무도 대신 안 잡는다.
//
// RED 근거(2026-07-29): 아래 검사는 이관 전 `claim_writes()` 가 `Ok(true)` 를 돌려주며 통과했다.

#![cfg(unix)]

use rusqlite::Connection;
use soksak_core::identity::Identity;

/// 앱이 만든 것과 같은 형태의 저장소를, 페이지가 여럿 되도록 채워서 만든다.
fn healthy_store(db: &std::path::Path) {
    let conn = Connection::open(db).expect("저장소 만들기");
    conn.execute_batch(soksak_core::store_open::OPEN_PRAGMA_SQL)
        .expect("개방 PRAGMA");
    soksak_store::store::init_base(&conn).expect("기본 형태");
    soksak_store::store::define(&conn, "t.ns", "notes", &[], &[]).expect("컬렉션 선언");
    for i in 0..400 {
        soksak_store::store::put(
            &conn,
            "t.ns",
            "notes",
            "scope",
            Some(format!("n{i}")),
            &serde_json::json!({ "body": format!("row {i} padding padding padding padding") }),
        )
        .expect("레코드");
    }
    // WAL 을 본체로 내린다 — 손상 주입이 실데이터 페이지에 닿아야 한다.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("체크포인트");
}

/// 헤더와 스키마 페이지는 남기고 내부 페이지만 깬다 — 맨 개방은 통과하는 손상.
fn corrupt_inner_pages(db: &std::path::Path) {
    let mut bytes = std::fs::read(db).expect("읽기");
    assert!(bytes.len() > 4096 * 4, "페이지가 여럿이어야 한다");
    let start = 4096 * 2; // page 1=헤더/스키마, page 2=meta 는 보존
    let end = (start + 8192).min(bytes.len());
    for b in &mut bytes[start..end] {
        *b = 0xAA;
    }
    std::fs::write(db, &bytes).expect("쓰기");
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db.to_string_lossy()));
    }
}

#[test]
fn a_corrupt_store_does_not_pass_this_process_boot() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("시각")
        .as_nanos();
    let home = std::env::temp_dir().join(format!("soksak-cored-open-{stamp}"));
    let data = home.join("data");
    std::fs::create_dir_all(&data).expect("데이터 디렉터리");
    let db = data.join(soksak_core::identity::DB_FILE);
    healthy_store(&db);
    corrupt_inner_pages(&db);

    // 헤더는 멀쩡하다 — 맨 개방과 스키마 조회는 통과한다(이 손상의 정의).
    {
        let raw = Connection::open(&db).expect("맨 개방");
        let n: i64 = raw
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .expect("스키마 조회");
        assert!(n > 0, "스키마 페이지는 보존된다");
    }

    let mut ctx = soksak_cored::ctx::Ctx::new(Identity::new(
        home.to_string_lossy().to_string(),
        "com.soksak.dev",
    ))
    .with_data_dir(&data);
    let verdict = ctx.claim_writes();
    let _ = std::fs::remove_dir_all(&home);
    let err = match verdict {
        Ok(_) => panic!("손상된 저장소를 정상으로 알고 서빙을 시작했다 — 부팅 게이트가 없다"),
        Err(e) => e,
    };
    assert!(
        err.contains("integrity"),
        "거절은 무결성을 이름으로 지목해야 한다: {err}"
    );
}
