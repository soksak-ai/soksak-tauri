//! 활동 원장의 **자원** — 이 프로세스가 지는 seq 할당자와 그 재개 지점.
//!
//! 규칙은 `soksak_core::activity` 가 소유한다(도장·단조·보관 축). 여기 있는 것은 자원
//! 둘뿐이다: 저장소에서 재개 지점을 읽는 질의문 하나와, 원장별 할당자 하나.
//!
//! **적재하고 남긴다. 부채질은 안 한다.** 발행 3단이 이렇게 갈린다:
//!   - 적재·영속: 여기서 한다. 번호를 매기고(`admit`) 그 자리에서 행을 쓴다(`persist`).
//!     한때 적재만 했다 — 그때 실측은 publish 24회 성공에 `records` 0행이었다(2026-07-28,
//!     Electron 라이브). 답은 전부 성공이라 부재가 오류로 안 보였고, 다음 부팅에서 피드가
//!     비고 재개 지점이 0 이 되는 것으로만 드러났다.
//!   - 부채질: 창은 프레임워크의 것이다. cored 는 적재된 항목을 답에 실어 보내고, 프레임워크가 그것을 받아
//!     자기 창에 뿌린다. 항목의 모양은 앱의 invoke 가 돌려주는 것과 같다.
//!
//! **이 쓰기는 저장소 쓰기 잠금 밖에 있다.** `data_kv_set` 은 `owns_writes()` 를 보고 거절하는데
//! 이 경로는 안 본다 — 여기에 같은 게이트를 달면 위의 침묵이 글자 그대로 돌아오기 때문이다.
//! 대가는 앱이 잠금을 쥔 홈에서 cored 도 돌 때 두 프로세스가 `records` 에 쓴다는 것이고,
//! 그 두 사실을 `tests/writes_outside_the_lock.rs` 가 함께 못 박는다.
//! 여기서 쓰는 것은 원장 한 종류뿐이다 — 다른 레코드 쓰기를 이 파일에 들이면 봉인 seam·FTS
//! 동기화를 지나는 저장소 경로와 두 벌이 되고, 두 벌의 차이는 조용하다.
//!
//! 할당자는 **원장(저장소 파일)마다 하나**다. 한 cored 가 두 홈을 서빙해도 번호가 섞이지
//! 않는다 — 섞이면 한 홈의 소비자 커서가 다른 홈의 번호를 가리킨다.

use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use soksak_core::activity::Ledger;

/// 활동 원장이 사는 자리 — 코어가 소유한다. 여기서 값을 다시 적으면 "같다"는 주석만 남고
/// 실제로는 한쪽이 쓴 것을 다른 쪽이 못 읽는 상태가 조용히 생긴다.
use soksak_core::activity::{COLL, NS};

/// 원장별 할당자. 경로 문자열이 원장의 이름이다.
static LEDGERS: Mutex<Vec<(String, Ledger)>> = Mutex::new(Vec::new());

/// 저장소의 영속 최댓값 — 앱의 `resume_seq` 가 읽는 것과 **같은 사실**이다.
/// 그쪽은 seq 내림차순 첫 행을 보고 여기는 최댓값을 보는데, 둘은 같은 수를 답한다.
/// scope 를 가리지 않는다: 신호든 저신호든 마지막이 어느 쪽이었건 뒤로 가지 않아야 한다.
///
/// **이 질의만** 읽기 전용으로 연다. 재개 지점을 읽는 자리가 쓰기 연결을 열 이유가 없고,
/// 열어 두면 실수로 쓰는 문장이 들어와도 아무것도 막지 않는다. 원장 행을 남기는 것은
/// `persist` 한 자리뿐이다.
///
/// 행이 하나도 없으면 0 이다(신선 설치 — 앱도 그렇게 재개한다). 저장소를 못 열거나 못
/// 읽는 것은 그것과 다른 사실이므로 사유를 달고 올린다.
fn stored_last_seq(db_path: &str) -> Result<u64, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("원장 저장소 열기 실패: {e}"))?;
    // 인덱스 필드(kind·seq)는 봉인된 행에서도 평문 top-level 로 남는다 — 앱의 질의가 그
    // 위를 타므로 여기서도 같은 자리를 본다.
    conn.query_row(
        "SELECT COALESCE(MAX(CAST(json_extract(doc,'$.seq') AS INTEGER)), 0) \
         FROM records WHERE ns=?1 AND coll=?2",
        (NS, COLL),
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v.max(0) as u64)
    .map_err(|e| format!("원장 재개 지점 조회 실패: {e}"))
}

/// 벽시계 밀리초. 원장 도장과 kv 갱신 시각이 같은 시계를 본다.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 항목 하나를 적재하고 도장 찍힌 항목을 돌려준다.
///
/// 그 원장을 이 프로세스가 처음 만지는 것이면 재개 지점을 먼저 읽는다. 못 읽으면 이름을
/// 달고 실패한다 — 재개 지점을 모르는 채 0 부터 매기면 소비자의 영속 읽음 커서가 미래를
/// 가리켜 그 소비자가 전면 침묵한다(실측된 잠복 결함). 모르는 것은 모른다고 답한다.
pub fn admit(db_path: &str, kind: &str, source: &str, payload: Value) -> Result<Value, String> {
    let mut all = LEDGERS
        .lock()
        .map_err(|_| "원장 잠금이 오염됐다(적재 스레드가 패닉했다)".to_string())?;
    if !all.iter().any(|(p, _)| p == db_path) {
        let mut led = Ledger::default();
        led.resume_from(stored_last_seq(db_path)?);
        all.push((db_path.to_string(), led));
    }
    let led = all
        .iter_mut()
        .find(|(p, _)| p == db_path)
        .map(|(_, l)| l)
        .expect("직전에 넣었거나 이미 있던 원장");
    let entry = led.admit(now_ms(), kind, source, payload);
    drop(all); // 쓰기 동안 원장 잠금을 쥐고 있지 않는다 — 디스크가 느리면 적재가 통째로 막힌다.
    persist(db_path, &entry)?;
    Ok(entry)
}

/// 적재한 항목을 원장에 **남긴다.**
///
/// 적재만 하면 답은 성공으로 나가고 원장은 남지 않는다. 그 부재는 오류가 아니라 다음 부팅에서
/// **아무 일도 없었던 것**으로 나타난다: 피드가 비고, 재개 지점이 0 이 되어 새 원장이 조용히
/// 시작된다(실측 2026-07-28, Electron 라이브 — publish 24회 성공에 records 0행).
///
/// 규칙·문장은 코어가 소유하고 여기는 연결만 갖는다.
/// 원장 항목을 남긴다 — 쓰기는 저장소 계층이 소유한다(soksak_store::activity_persist).
///
/// 여기 raw SQL 을 두었던 동안 이 경로는 저장소 정책을 우회했고 **보관 정리를 한 번도 받지
/// 않았다**(실측 2026-07-31 — 그 원장은 영원히 자란다). 규칙이 갈린 것이 아니라 한쪽이 통째로
/// 빈약했고, 오류를 내지 않아 조용했다.
/// 밖에서 도장 찍힌 항목을 영속만 한다 — 이 프로세스의 원장 커서는 건드리지 않는다.
///
/// 커서를 올리면 이 프로세스도 그 자리를 자기 것으로 여기고, 다음 자체 발행이 그 위를 이어
/// 매긴다 — 주인이 둘이 되는 정확한 경로다. 쓰기만 진다.
pub fn persist_only(db_path: &str, entry: &Value) -> Result<(), String> {
    persist(db_path, entry)
}

fn persist(db_path: &str, entry: &Value) -> Result<(), String> {
    soksak_store::activity_persist::with_writer(std::path::Path::new(db_path), |conn| {
        if soksak_store::activity_persist::persist_entry(conn, entry) {
            return Ok(());
        }
        // 실패는 회복 큐에 담겼다 — 다음 성공에 함께 흘러간다. 부른 쪽에는 사실대로 알린다.
        Err("원장 쓰기 실패(회복 큐에 보관됨)".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 앱이 만드는 records 스키마 그대로의 저장소 하나.
    fn db(name: &str, seqs: &[(&str, u64)]) -> String {
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join(".soksak-cored-test")
            .join("ledger");
        std::fs::create_dir_all(&dir).expect("픽스처 루트");
        let path = dir.join(format!("{name}.db"));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("저장소 생성");
        conn.execute_batch(
            "CREATE TABLE records (ns TEXT NOT NULL, coll TEXT NOT NULL, scope TEXT NOT NULL, \
             id TEXT NOT NULL, doc TEXT NOT NULL, created INTEGER NOT NULL, \
             updated INTEGER NOT NULL, enc INTEGER NOT NULL DEFAULT 0, keyId TEXT, \
             PRIMARY KEY(ns, coll, id));",
        )
        .expect("스키마");
        for (scope, seq) in seqs {
            conn.execute(
                "INSERT INTO records(ns,coll,scope,id,doc,created,updated) \
                 VALUES('core','activity',?1,?2,?3,0,0)",
                (
                    scope,
                    format!("a{seq:016}"),
                    format!(r#"{{"seq":{seq},"kind":"k"}}"#),
                ),
            )
            .expect("행");
        }
        path.to_string_lossy().to_string()
    }

    #[test]
    fn an_empty_collection_resumes_at_zero() {
        // 행이 없는 것은 "못 읽었다"가 아니다 — 신선 설치의 정답이 0 이다.
        assert_eq!(stored_last_seq(&db("empty", &[])).unwrap(), 0);
    }

    #[test]
    fn the_maximum_is_taken_across_both_retention_axes() {
        // 저신호가 마지막이었어도 뒤로 가지 않는다.
        let path = db("both-axes", &[("app", 12), ("app-low", 77)]);
        assert_eq!(stored_last_seq(&path).unwrap(), 77);
    }

    #[test]
    fn another_collection_does_not_move_this_ledger() {
        // ns·coll 로 좁히지 않으면 남의 레코드가 이 원장의 재개 지점을 밀어 올린다.
        let path = db("other-coll", &[("app", 5)]);
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO records(ns,coll,scope,id,doc,created,updated) \
             VALUES('core','sessions','app','s1','{\"seq\":9999}',0,0)",
            (),
        )
        .unwrap();
        assert_eq!(stored_last_seq(&path).unwrap(), 5);
    }

    #[test]
    fn a_missing_store_is_reported_not_answered_with_zero() {
        let why = stored_last_seq("/nonexistent-xyz/soksak.db").unwrap_err();
        assert!(why.contains("원장"), "{why}");
    }

    #[test]
    fn a_store_without_the_records_table_is_reported() {
        // 열리기는 하는데 원장이 아닌 파일 — 0 으로 답하면 새 원장을 조용히 시작한다.
        let dir = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join(".soksak-cored-test")
            .join("ledger");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("no-records.db");
        let _ = std::fs::remove_file(&path);
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE other(x);").unwrap();
        let why = stored_last_seq(&path.to_string_lossy()).unwrap_err();
        assert!(why.contains("조회 실패"), "{why}");
    }
}
