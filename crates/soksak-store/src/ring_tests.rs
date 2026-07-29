use super::*;
use crate::open;
use crate::store;
use serde_json::json;

const HOUR: Duration = Duration::from_secs(3600);

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("soksak-ring-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

// 기록형 reporter — 발행 사실을 단언하는 test double(창도 앱 핸들도 필요 없다).
struct RecordingReporter {
    failures: std::sync::Mutex<Vec<String>>,
}

impl BackupReporter for RecordingReporter {
    fn failed(&self, detail: &str) {
        self.failures
            .lock()
            .expect("reporter lock")
            .push(detail.to_string());
    }
}

// [defect ①] 손상 DB 스냅샷 실패는 삼키지 않고 정확히 1회 고지된다(무음 폴백 금지).
#[test]
fn corrupt_snapshot_failure_is_reported_not_swallowed() {
    let root = temp_root("failreport");
    let db = root.join("soksak.db");
    // 슬롯 없음 → due=true → tick 이 스냅샷을 시도한다. 본체는 SQLite 가 아니므로 VACUUM INTO 실패.
    std::fs::write(&db, b"this is not a sqlite database, snapshot must fail")
        .expect("write corrupt body");
    let reporter = RecordingReporter {
        failures: std::sync::Mutex::new(Vec::new()),
    };
    run_cycle(&db, SystemTime::now(), &reporter);
    let failures = reporter.failures.lock().expect("reporter lock");
    assert_eq!(
        failures.len(),
        1,
        "손상 DB 스냅샷 실패는 정확히 1회 고지되어야 한다"
    );
    assert!(
        !failures[0].is_empty(),
        "고지에 실패 상세가 실려야 한다: {failures:?}"
    );
    drop(failures);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn gate_is_due_without_slot_and_after_interval() {
    let now = SystemTime::now();
    assert!(due(None, now), "첫 백업(슬롯 없음)은 즉시 due");
    assert!(
        !due(Some(now - Duration::from_secs(600)), now),
        "10분 경과는 게이트 미달"
    );
    assert!(due(Some(now - HOUR), now), "1시간 경과는 due");
    assert!(!due(Some(now + HOUR), now), "미래 mtime(시계 역행)은 보류");
}

#[test]
fn write_then_tick_creates_slot_zero() {
    let root = temp_root("first");
    let db = root.join("soksak.db");
    let conn = open::open(&db).unwrap();
    store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
    // 쓰기 커넥션이 살아있는 채(앱 상태 그대로) tick — 스냅샷은 read-only 커넥션 몫.
    let did = tick(&db, SystemTime::now()).unwrap();
    assert!(did, "쓰기 후 첫 tick 은 백업을 생성해야 한다");
    let slot0 = slot_path(&db, 0);
    assert!(slot0.is_file(), "bak.0 실존");
    crate::backup::validate(&slot0).unwrap();
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn tick_within_interval_skips() {
    let root = temp_root("skip");
    let db = root.join("soksak.db");
    let conn = open::open(&db).unwrap();
    store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
    assert!(tick(&db, SystemTime::now()).unwrap());
    // 직후 재신호 — 게이트(1h) 미달이므로 수행하지 않고 회전도 없다.
    let did = tick(&db, SystemTime::now()).unwrap();
    assert!(!did, "간격 미달 tick 은 수행하지 않는다");
    assert!(!slot_path(&db, 1).exists(), "회전 없음");
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rotation_keeps_five_newest_in_order() {
    let root = temp_root("rot");
    let db = root.join("soksak.db");
    let conn = open::open(&db).unwrap();
    let base = SystemTime::now();
    // 7회 스냅샷(사이마다 marker 갱신, 주입 now 를 2h 씩 전진 → 항상 due).
    for i in 1..=7u32 {
        store::kv_set(&conn, "core", "marker", &json!(i)).unwrap();
        assert!(tick(&db, base + HOUR * 2 * i).unwrap(), "스냅샷 {i} 수행");
    }
    // 슬롯 5개만 남고 bak.0=최신(7) … bak.4=3.
    for i in 0..SLOTS {
        let sc = rusqlite::Connection::open(slot_path(&db, i)).unwrap();
        let v: String = sc
            .query_row("SELECT v FROM kv WHERE ns='core' AND k='marker'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v, (7 - i).to_string(), "bak.{i} 내용");
    }
    assert!(!slot_path(&db, SLOTS).exists(), "슬롯 5개 캡");
    // 작업 파일은 rename 으로 소진된다 — 이름이 무엇이든 잔재가 남지 않아야 한다.
    let leftovers: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".bak.tmp"))
        .collect();
    assert!(leftovers.is_empty(), "작업 파일 잔재: {leftovers:?}");
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

// 회전은 **자기 작업 파일만** 만진다.
//
// 이름이 고정(`<db>.bak.tmp`)이면 같은 저장소를 회전하는 둘이 그 한 이름을 두고 겹친다 —
// 한쪽의 "크래시 잔재 정리"가 다른 쪽이 짓고 있는 파일을 지운다. 그 결과는 오류 로그가
// 아니라 **안 생긴 백업**이고, 없는 백업은 저장소가 깨진 뒤에야 발견된다.
//
// 아래 파일 이름은 고정 이름 시절 회전이 자기 것이라고 주장하던 바로 그 자리다.
#[test]
fn a_rotation_leaves_another_writers_scratch_file_alone() {
    let root = temp_root("scratch");
    let db = root.join("soksak.db");
    let conn = open::open(&db).unwrap();
    store::kv_set(&conn, "core", "marker", &json!(1)).unwrap();
    let foreign = PathBuf::from(format!("{}.bak.tmp", db.to_string_lossy()));
    std::fs::write(&foreign, b"another writer is building its snapshot here").unwrap();

    assert!(tick(&db, SystemTime::now()).unwrap(), "스냅샷 수행");

    assert!(
        foreign.is_file(),
        "남이 짓고 있는 작업 파일을 지웠다 — 고정 이름이면 둘이 서로를 밟는다"
    );
    assert_eq!(
        std::fs::read(&foreign).unwrap(),
        b"another writer is building its snapshot here",
        "남의 작업 파일 내용이 바뀌었다"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&root);
}

/// 이름이 갈리는 축은 둘이다 — 프로세스(pid)와 한 프로세스 안의 동시 회전(번호).
#[test]
fn each_rotation_claims_its_own_scratch_name() {
    let db = std::path::Path::new("/tmp/soksak-ring-name/soksak.db");
    let a = snapshot_tmp_path(db);
    let b = snapshot_tmp_path(db);
    assert_ne!(a, b, "같은 프로세스의 두 회전이 한 이름을 쓴다");
    assert!(
        a.to_string_lossy()
            .contains(&std::process::id().to_string()),
        "이름이 프로세스를 가르지 않는다: {a:?}"
    );
}
