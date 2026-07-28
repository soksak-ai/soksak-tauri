//! 활동 원장의 **자원** — 이 프로세스가 지는 seq 할당자와 그 재개 지점.
//!
//! 규칙은 `soksak_core::activity` 가 소유한다(도장·단조·보관 축). 여기 있는 것은 자원
//! 둘뿐이다: 저장소에서 재개 지점을 읽는 질의문 하나와, 원장별 할당자 하나.
//!
//! **적재까지만 한다.** 발행 3단 중 나머지 둘은 이 프로세스의 것이 아니다:
//!   - 부채질: 창은 셸의 것이다. cored 는 적재된 항목을 답에 실어 보내고, 셸이 그것을 받아
//!     자기 창에 뿌린다. 항목의 모양은 앱의 invoke 가 돌려주는 것과 같다.
//!   - 영속: records 쓰기 경로는 저장소 소유자의 것이다. 여기서 행을 쓰면 레코드 쓰기가
//!     둘이 되고(봉인 seam·FTS 동기화·단일 쓰기 커넥션 전제) 두 경로의 차이는 조용하다.
//!     저장소 쓰기 축이 옮겨올 때 영속과 재개가 함께 온다 — 지금은 읽기만 한다.
//!
//! 할당자는 **원장(저장소 파일)마다 하나**다. 한 cored 가 두 홈을 서빙해도 번호가 섞이지
//! 않는다 — 섞이면 한 홈의 소비자 커서가 다른 홈의 번호를 가리킨다.

use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use soksak_core::activity::Ledger;

/// 활동 원장이 사는 자리 — 앱의 `activity.rs` 와 같은 ns·컬렉션이다.
const NS: &str = "core";
const COLL: &str = "activity";

/// 원장별 할당자. 경로 문자열이 원장의 이름이다.
static LEDGERS: Mutex<Vec<(String, Ledger)>> = Mutex::new(Vec::new());

/// 저장소의 영속 최댓값 — 앱의 `resume_seq` 가 읽는 것과 **같은 사실**이다.
/// 그쪽은 seq 내림차순 첫 행을 보고 여기는 최댓값을 보는데, 둘은 같은 수를 답한다.
/// scope 를 가리지 않는다: 신호든 저신호든 마지막이 어느 쪽이었건 뒤로 가지 않아야 한다.
///
/// 읽기 전용으로 연다. 이 프로세스는 원장을 쓰지 않고, 두 프로세스가 같은 파일에 쓰면
/// 그 순간 단일 쓰기자 계약이 깨진다.
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

fn now_ms() -> u64 {
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
    Ok(led.admit(now_ms(), kind, source, payload))
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
