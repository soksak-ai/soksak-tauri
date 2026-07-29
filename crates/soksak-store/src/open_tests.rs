use super::*;
use crate::backup::backup;
use crate::ring::slot_path;
use crate::{now_millis, store};
use serde_json::json;

fn mem_file(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    dir.join(name)
}

#[cfg(unix)]
#[test]
fn open_creates_db_file_with_owner_only_mode() {
    // DB 는 봉투 키·레코드를 담는 data-at-rest 저장소 — group/other 접근을 0600 으로 차단한다.
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "soksak-dbperm-{}-{}",
        std::process::id(),
        now_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("soksak.db");
    let conn = open(&path).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(mode, 0o600, "soksak.db 는 0600 이어야 한다(실제 {mode:o})");
}

#[test]
fn overwritten_plaintext_is_scrubbed_from_db_file() {
    // 봉인 전환(convert 의 in-place UPDATE)이 남기는 옛 평문이 secure_delete=ON + VACUUM 으로 파일에서
    // 사라짐을 증명한다 — 라이브 DB 를 훔친 자가 전환 이전 평문을 키 없이 carve 하는 경로(적대 프로브
    // 앵글2)를 닫는다. 수정 전(secure_delete 부재·VACUUM 부재)엔 옛 평문이 freelist·WAL 에 잔존.
    let dir = std::env::temp_dir().join(format!(
        "soksak-scrub-{}-{}",
        std::process::id(),
        now_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("soksak.db");
    let secret = "SCRUB-SECRET-a1b2c3d4e5f6-do-not-leak";
    {
        let conn = open(&path).unwrap();
        conn.execute(
            "INSERT INTO kv(ns,k,v,updated) VALUES('t','k',?1,0)",
            rusqlite::params![format!("{{\"body\":\"{secret}\"}}")],
        )
        .unwrap();
        // 봉인 전환처럼 그 값을 암호문 자리표시자로 덮어쓴 뒤, 전환 완료와 동형으로 scrub.
        conn.execute(
            "UPDATE kv SET v='SEALED-CIPHERTEXT-PLACEHOLDER-0123456789abcdef' WHERE ns='t' AND k='k'",
            [],
        )
        .unwrap();
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    let mut hay = std::fs::read(&path).unwrap();
    if let Ok(wal) = std::fs::read(format!("{}-wal", path.to_string_lossy())) {
        hay.extend_from_slice(&wal);
    }
    let _ = std::fs::remove_dir_all(&dir);
    let leaked = hay.windows(secret.len()).any(|w| w == secret.as_bytes());
    assert!(
        !leaked,
        "덮어쓴 평문이 DB 파일에 잔존한다(secure_delete/VACUUM 미작동)"
    );
}

#[test]
fn fts_residual_is_scrubbed_after_convert() {
    // 봉인 변환 후 FTS 그림자테이블(%_data)에 남던 봉인 필드의 옛 트라이그램이 purge_fts_residual
    // ('rebuild') + VACUUM 으로 파일에서 사라짐을 증명한다 — sync_fts 의 DELETE 가 FTS5 tombstone 이라
    // 트라이그램이 살아남아 파일-carve 로 키 없이 복원되던 적대검증 구멍(residual-carve)을 막는다.
    let dir = std::env::temp_dir().join(format!(
        "soksak-ftsscrub-{}-{}",
        std::process::id(),
        now_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("soksak.db");
    // 희귀 트라이그램 단어 — 정상 DB(스키마·sqlite 헤더)엔 안 나와 위양성 배제.
    let secret = "qzvxwkjfby";
    {
        let conn = open(&path).unwrap();
        // fts 전용 필드(idx 아님) — 봉인 대상이면서 평문 시점에 FTS 색인됨(누출 후보).
        store::define(&conn, "t", "notes", &[], &["body".into()]).unwrap();
        store::put(
            &conn,
            "t",
            "notes",
            "proj-a",
            None,
            &serde_json::json!({ "body": secret }),
        )
        .unwrap();
        // 암호화 활성 후 변환 — 레코드 봉인, FTS 엔트리 DELETE(tombstone).
        let (_s, p) = soksak_seal::gen_asym_keypair();
        crate::doc::register_active_key(&conn, "proj-a", "key-1", &p, 50).unwrap();
        assert_eq!(
            store::convert_pending(&conn, "t", "notes", "proj-a", 100).unwrap(),
            1,
            "평문 1건 봉인 변환"
        );
        store::purge_fts_residual(&conn, "t", "notes").unwrap();
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    let mut hay = std::fs::read(&path).unwrap();
    if let Ok(wal) = std::fs::read(format!("{}-wal", path.to_string_lossy())) {
        hay.extend_from_slice(&wal);
    }
    let _ = std::fs::remove_dir_all(&dir);
    // 봉인된 fts 필드 값의 어떤 트라이그램도 파일에 남지 않아야 한다(평문 잔존 0).
    let present = secret
        .as_bytes()
        .windows(3)
        .filter(|w| hay.windows(3).any(|h| h == *w))
        .count();
    assert_eq!(
        present, 0,
        "봉인된 FTS 필드의 트라이그램이 DB 파일에 잔존(rebuild/VACUUM 미작동)"
    );
}

// auto_vacuum=INCREMENTAL 은 첫 CREATE 전에만 먹는다 — 개방 절차가 그 순서를 지키는지 실물로 본다.
#[test]
fn incremental_vacuum_reclaims_pages() {
    use store::{define, incremental_vacuum, put, retention_reap_ttl};
    let dir = std::env::temp_dir().join(format!(
        "soksak-vac-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("d.db");
    {
        let c = open(&path).unwrap(); // auto_vacuum=INCREMENTAL 적용(신규 DB)
        define(&c, "t", "c", &[], &[]).unwrap();
        for i in 0..300 {
            put(
                &c,
                "t",
                "c",
                "s",
                None,
                &json!({"pad": "y".repeat(500), "i": i}),
            )
            .unwrap();
        }
        retention_reap_ttl(&c, "t", "c", i64::MAX).unwrap(); // 전부 삭제(created < MAX)
        let free_before: i64 = c
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        incremental_vacuum(&c, 100_000).unwrap();
        let free_after: i64 = c
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(
            free_before > 0,
            "삭제 후 free 페이지 존재(auto_vacuum=INCREMENTAL)"
        );
        assert!(
            free_after < free_before,
            "incremental_vacuum 이 free 페이지 반환(physical reclaim)"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn corrupt_db_recovers_from_slot() {
    let root = std::env::temp_dir().join(format!("soksak-recover-slot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let db = mem_file(&root, "soksak.db");

    // 정상 DB + 슬롯 0 스냅샷(marker=42).
    let conn = open(&db).unwrap();
    store::kv_set(&conn, "core", "marker", &json!(42)).unwrap();
    backup(&conn, &slot_path(&db, 0)).unwrap();
    drop(conn);

    // 본체를 쓰레기 바이트로 덮고 사이드카 제거 — 손상 재현.
    std::fs::write(&db, b"this is definitely not a sqlite database").unwrap();
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db.to_string_lossy()));
    }
    assert!(open(&db).is_err(), "쓰레기 바이트 본체는 개방 실패");

    // 복구 — 슬롯 0 에서 복원, 손상본 격리, marker 보존.
    let (conn, rec) = open_or_recover(&db).unwrap();
    let rec = rec.expect("손상 본체는 복구를 유발해야 한다");
    assert_eq!(rec.restored_from, Some(0), "슬롯 0 에서 복원");
    assert!(rec.quarantined.is_file(), "손상본은 격리 파일로 보존(증거)");
    assert_eq!(
        store::kv_get(&conn, "core", "marker").unwrap(),
        Some(json!(42)),
        "복원본에 marker 보존"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn corrupt_db_without_slots_starts_empty() {
    let root = std::env::temp_dir().join(format!("soksak-recover-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let db = mem_file(&root, "soksak.db");

    std::fs::write(&db, b"garbage, and no valid backup slots exist").unwrap();
    assert!(open(&db).is_err(), "쓰레기 바이트 본체는 개방 실패");

    // 복구 — 정상 슬롯 없음 → 빈 DB 재시작, 손상본은 여전히 격리.
    let (conn, rec) = open_or_recover(&db).unwrap();
    let rec = rec.expect("손상 본체는 복구를 유발해야 한다");
    assert_eq!(rec.restored_from, None, "정상 슬롯 없음 → 빈 DB 재시작");
    assert!(rec.quarantined.is_file(), "손상본 격리 파일 실존");
    assert_eq!(
        store::kv_get(&conn, "core", "marker").unwrap(),
        None,
        "빈 DB"
    );
    store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
    assert_eq!(
        store::kv_get(&conn, "core", "marker").unwrap(),
        Some(json!(1)),
        "빈 DB 는 쓰기 가능"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

// [defect ②] 헤더는 멀쩡하나 내부 페이지가 손상된 DB(비헤더 손상)는 이전엔 개방·DDL 을 통과해
// 부분 유실을 성공으로 오인했다. 부팅 open() 의 quick_check 게이트가 이를 복구 경로로 넘긴다.
#[test]
fn deep_corruption_is_gated_into_recovery() {
    let root = std::env::temp_dir().join(format!("soksak-deepcorrupt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let db = mem_file(&root, "soksak.db");

    // 정상 DB 를 다중 페이지로 키운다(레코드 다수) + 슬롯 0 스냅샷(복원 원천) + marker.
    let conn = open(&db).expect("open healthy db");
    store::define(&conn, "core", "notes", &[], &[]).expect("define notes");
    for i in 0..400 {
        store::put(
            &conn,
            "core",
            "notes",
            "app",
            Some(format!("n{i}")),
            &json!({ "body": format!("row {i} padding padding padding padding padding") }),
        )
        .expect("put note");
    }
    store::kv_set(&conn, "core", "marker", &json!(7)).expect("set marker");
    backup(&conn, &slot_path(&db, 0)).expect("snapshot slot 0");
    // WAL 을 본체로 내린다 — 손상 주입이 실데이터 페이지에 닿도록.
    // 실패 문구는 SQLite 의 pragma 이름(wal_checkpoint) 그대로 적는다. 맨 낱말로 줄이면
    // 터미널 복원 어휘와 한 이름이 되고, 한 낱말이 두 뜻을 지면 읽는 쪽이 갈린다.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .expect("wal_checkpoint");
    drop(conn);

    // 헤더(page 1)·메타(page 2)는 보존, 내부 페이지(page 3~)를 파손 — 헤더 기반 개방은 통과,
    // quick_check 는 실패. 8KB 를 0xAA 로 덮어 다중 btree 페이지를 확실히 오염시킨다.
    let bytes = std::fs::read(&db).expect("read db");
    assert!(
        bytes.len() > 8192 * 3,
        "다중 페이지 확보: {} bytes",
        bytes.len()
    );
    let mut corrupt = bytes.clone();
    let start = 4096 * 2; // page 3 시작(page 1=header/schema, page 2=meta 보존)
    let end = (start + 8192).min(corrupt.len());
    for b in &mut corrupt[start..end] {
        *b = 0xAA;
    }
    std::fs::write(&db, &corrupt).expect("write corrupt db");
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db.to_string_lossy()));
    }

    // 헤더는 멀쩡 → 순수 Connection::open + 스키마 조회는 통과(깊은 손상의 정의).
    {
        let raw = Connection::open(&db).expect("header open");
        let n: i64 = raw
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .expect("schema query");
        assert!(n > 0, "스키마(page 1)는 보존");
    }

    // 게이트: open() 이 quick_check 로 손상을 잡아 Err → open_or_recover 가 복구를 발동한다.
    let (conn, rec) = open_or_recover(&db).expect("recover deep corruption");
    let rec = rec.expect("깊은 손상은 무음 통과가 아니라 복구를 발동해야 한다");
    assert_eq!(rec.restored_from, Some(0), "슬롯 0 에서 복원");
    assert!(rec.quarantined.is_file(), "손상본 격리(증거)");
    assert_eq!(
        store::kv_get(&conn, "core", "marker").expect("get marker"),
        Some(json!(7)),
        "복원본 marker 보존"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

// [defect ③] recover 가 손상본을 격리한 뒤 재개방까지 실패하면, 이전엔 Recovery(격리 경로)를
// 통째로 drop 해 사람에게 무음이었다. 이제 에러가 격리 경로를 실어 호출 측이 고지할 수 있다.
// opener 를 주입해 재개방 실패를 결정적으로 재현한다.
#[test]
fn reopen_failure_after_recovery_carries_quarantine() {
    let root = std::env::temp_dir().join(format!("soksak-reopen-fail-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let db = mem_file(&root, "soksak.db");

    // 손상 본체(슬롯 없음) — 실제 recover 가 이 파일을 격리한다(restored_from=None).
    std::fs::write(&db, b"garbage corrupt body, no valid slots").expect("write corrupt body");
    // opener 를 항상 실패로 주입 → 초기 개방 실패 → recover 격리 → 재개방도 실패.
    let always_fail =
        |_p: &std::path::Path| Err::<Connection, String>("injected open failure".into());
    let err = match open_or_recover_with(&db, always_fail) {
        Ok(_) => panic!("주입 opener 는 항상 실패이므로 Ok 일 수 없다"),
        Err(e) => e,
    };

    assert_eq!(err.detail, "injected open failure");
    let q = err
        .quarantined
        .expect("재개방 실패라도 격리 경로는 에러에 실려야 한다(무음 drop 금지)");
    assert!(q.is_file(), "격리본 실존(증거 보존)");
    assert!(!db.exists(), "손상본은 격리로 이동");
    let _ = std::fs::remove_dir_all(&root);
}
