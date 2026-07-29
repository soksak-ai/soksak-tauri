// cored 가 만든 저장소는 앱이 만든 것과 **같은 모양**이어야 한다.
//
// 앱이 없는 홈(이 프레임워크의 홈)에서는 저장소를 cored 가 처음 만든다. 그때 세우는 형태가
// 앱의 것과 다르면, 그 차이는 오류로 나타나지 않고 **데이터의 성질**로 나타난다.
//
// 두 가지가 첫 CREATE 전에만 정해진다:
//   auto_vacuum=INCREMENTAL — 이후에 바꿔도 무시된다. NONE 으로 태어난 저장소에서는
//     retention 의 incremental_vacuum 이 조용히 0 페이지를 돌려준다("지웠는데 파일이 안 준다").
//   secure_delete=ON — 지운 셀을 0 으로 채운다. OFF 로 태어나면 봉인 전환이 남긴 옛 평문 셀이
//     freelist·WAL 에 잔존해 키 없이 파일에서 긁힌다. 봉인 데이터 at-rest 전제가 깨진다.
//
// 파일 권한도 같은 부류다 — 0600 이 아니면 같은 머신의 다른 사용자가 봉투 키를 읽는다.
//
// RED 근거(실측 2026-07-29): cored 의 ensure_schema 가 맨 Connection::open 으로 열고
// 기본 스키마만 돌렸다. 이 프레임워크의 홈은 전부 그렇게 태어났다.

#![cfg(unix)]

use rusqlite::Connection;
use soksak_core::identity::Identity;

fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))
        .unwrap_or(-1)
}

/// cored 가 자기 홈에 저장소를 세운다 — 앱은 이 홈에 없다.
fn stand_up_store() -> (std::path::PathBuf, std::path::PathBuf) {
    // 검사마다 다른 홈 — 같은 자리를 쓰면 앞 검사가 만든 저장소의 모양을 보게 된다.
    // 시각만으로는 부족하다: 검사는 병렬로 돌고 같은 나노초를 볼 수 있다(실측 플래키).
    // 단조 증가 번호를 함께 실어 겹칠 여지를 없앤다.
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("soksak-store-shape-{stamp}-{n}"));
    let data = dir.join("data");
    let mut ctx = soksak_cored::ctx::Ctx::new(Identity::new(
        dir.to_string_lossy().to_string(),
        "com.soksak.dev",
    ))
    .with_data_dir(&data);
    assert!(ctx.claim_writes().expect("쓰기 소유권"), "빈 홈은 소유권을 잡는다");
    let db = ctx.db_path();
    assert!(db.exists(), "저장소 파일이 생겨야 한다");
    (dir, db)
}

/// 이후에 바꿔도 무시되는 값 — 태어날 때 정해진다.
#[test]
fn a_store_born_here_reclaims_pages() {
    let (_home, db) = stand_up_store();
    let conn = Connection::open(&db).expect("열기");
    // 2 = INCREMENTAL. 0(NONE)이면 retention 이 파일을 못 줄인다.
    assert_eq!(pragma_i64(&conn, "auto_vacuum"), 2, "auto_vacuum 이 INCREMENTAL 이 아니다");
}

/// secure_delete 는 파일이 아니라 **연결** 속성이다 — 한 번 정해지는 auto_vacuum 과 다르다.
///
/// 그래서 파일을 검사해서는 알 수 없고, **여는 자리마다** 걸려야 한다. 한 자리라도 맨 연결로
/// 열면 그 연결의 삭제는 옛 셀을 남기고, 그 잔존은 오류가 아니라 파일에서 긁히는 평문이 된다.
#[test]
fn every_connection_from_here_wipes_deleted_cells() {
    let (home, _db) = stand_up_store();
    let ctx = soksak_cored::ctx::Ctx::new(Identity::new(
        home.to_string_lossy().to_string(),
        "com.soksak.dev",
    ))
    .with_data_dir(home.join("data"));
    let conn = ctx.open_db().expect("코어 규칙으로 열기");
    assert_eq!(pragma_i64(&conn, "secure_delete"), 1, "secure_delete 가 켜져 있지 않다");
    // 여는 규칙을 안 타면 기본값이다 — 그 차이를 이 검사가 지킨다.
    let raw = Connection::open(ctx.db_path()).expect("맨 연결");
    assert_eq!(pragma_i64(&raw, "secure_delete"), 0, "맨 연결이 켜져 있으면 이 검사가 무의미하다");
}

/// 봉투 키와 레코드가 사는 파일이다 — 같은 머신의 다른 사용자에게 열어 두지 않는다.
#[test]
fn a_store_born_here_is_private_to_this_user() {
    use std::os::unix::fs::PermissionsExt;
    let (_home, db) = stand_up_store();
    let mode = std::fs::metadata(&db).expect("권한").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "저장소 파일 권한이 0600 이 아니다: {mode:o}");
}

// ── 이 프로세스가 만든 저장소는 앱이 만든 것과 **같은 모양**이다 ──────────────────
//
// 지금까지 이 파일은 열기 규칙(auto_vacuum·secure_delete·권한)만 봤다. 표와 인덱스는 아무도
// 안 봤고, 그래서 cored 가 만든 홈에는 `encryption_keys` 가 없었다.
//
// 그 결손은 봉인 기능만 못 쓰는 것으로 끝나지 않는다. 레코드 쓰기가 `doc::active_key` 를
// **평문 경로에서도** 지나고(store.rs:420 — "active key 없으면 평문 항등"), `active_key` 의
// `.optional()` 은 "행 없음"만 삼키지 **"테이블 없음"은 오류로 낸다**. 그래서 그 홈에서는
// 레코드 쓰기가 전량 실패한다 — 봉인을 켠 적이 없어도.

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn has_index(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

#[test]
fn the_store_this_process_creates_has_the_shape_records_need() {
    let (_home, db) = stand_up_store();
    let conn = Connection::open(&db).expect("연결");
    assert!(
        has_table(&conn, "encryption_keys"),
        "봉투 키 표가 없다 — 레코드 쓰기가 평문에서도 실패한다"
    );
    assert!(has_index(&conn, "records_created"), "retention FIFO 인덱스가 없다");
    assert!(has_index(&conn, "records_pending"), "변환 재개 부분 인덱스가 없다");
}

/// 모양만 보면 "왜 그것이 필요한가"가 안 남는다 — 실제로 한 건 써 본다.
#[test]
fn a_plain_record_write_succeeds_in_a_store_this_process_created() {
    let (_home, db) = stand_up_store();
    let conn = Connection::open(&db).expect("연결");
    // 컬렉션 선언이 먼저다 — 레코드는 선언된 자리에만 앉는다.
    soksak_store::store::define(&conn, "t.ns", "things", &[], &[])
        .expect("컬렉션 선언");
    let r = soksak_store::store::put(
        &conn,
        "t.ns",
        "things",
        "scope",
        Some("id-1".to_string()),
        &serde_json::json!({ "a": 1 }),
    );
    assert!(r.is_ok(), "평문 레코드 쓰기가 실패했다: {r:?}");
}
