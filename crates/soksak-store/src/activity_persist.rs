//! 활동 원장의 영속 — **적재하는 모든 프로세스가 이 한 자리를 지난다.**
//!
//! 규칙(도장·보관 축·요약)은 `soksak_core::activity` 가 소유하고, **쓰기**는 여기가 소유한다.
//! 저장소 계층(`store::put`)을 지나야 쓰기 정책·암호화·무결성이 함께 걸리기 때문이다.
//!
//! 실측(2026-07-31): 프레임워크는 `store::put` + 회복 큐 + `retention_trim` 으로 쓰는데,
//! cored 는 raw SQL 한 줄이었다. 그래서 cored 로 적재된 항목은 저장소 정책을 우회했고
//! **보관 정리를 한 번도 받지 않았다** — 그 원장은 영원히 자란다. 두 구현이 갈린 것이
//! 아니라 한쪽이 통째로 빈약했고, 그 차이는 오류를 내지 않아 조용했다.
//!
//! 실패는 삼키지 않는다: 쓰기가 실패하면 회복 큐에 담고, 다음 성공에 함께 흘려보낸다.
//! 큐가 넘치면 버린 수를 센다 — 조용히 사라지는 사실이 없어야 한다.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use soksak_core::activity as act;

/// 회복 큐 상한 — 넘치면 가장 오래된 것부터 버리고 그 수를 센다.
const PENDING_CAP: usize = 512;
/// 영속 보관 상한(보관 축마다).
const PERSIST_CAP: i64 = 5000;

struct PendingRow {
    scope: &'static str,
    id: Option<String>,
    doc: Value,
}

static PENDING: Mutex<VecDeque<PendingRow>> = Mutex::new(VecDeque::new());
static DROPS: AtomicU64 = AtomicU64::new(0);
static FAILURES: AtomicU64 = AtomicU64::new(0);

fn pending_push(q: &mut VecDeque<PendingRow>, row: PendingRow) -> u64 {
    let mut dropped = 0;
    while q.len() >= PENDING_CAP {
        q.pop_front();
        dropped += 1;
    }
    q.push_back(row);
    dropped
}

/// 영속 실패 누계 — 조용한 유실을 밖에서 셀 수 있어야 한다.
pub fn persist_failures() -> u64 {
    FAILURES.load(Ordering::Relaxed)
}

/// 회복 큐 초과로 버린 수.
pub fn persist_drops() -> u64 {
    DROPS.load(Ordering::Relaxed)
}

/// 대기 중인 회복 행 수.
pub fn persist_pending() -> usize {
    PENDING.lock().map(|q| q.len()).unwrap_or(0)
}

/// 원장 항목 하나를 남긴다. 성공하면 true.
///
/// 순서가 계약이다: 밀린 것을 먼저 흘려보내고(첫 건이 막히면 즉시 멈춘다 — 실패 지속 중
/// 헛시도 방지), 이번 것을 쓰고, 그 보관 축을 정리한다.
pub fn persist_entry(conn: &rusqlite::Connection, entry: &Value) -> bool {
    let scope = act::retention_scope(entry);
    let id = entry
        .get("seq")
        .and_then(Value::as_u64)
        .map(act::row_id);
    // 영속본은 관찰 요약 — 대형 내용물은 라이브(링·이벤트)의 것이다. 상한을 넘는 행 하나가
    // json 파스에서 수백 MB 를 요구해 앱을 즉사시킨 적이 있다(방어가 아니라 계약).
    let doc = act::summarize_for_persist(entry);

    if let Ok(mut q) = PENDING.lock() {
        while let Some(row) = q.front() {
            match crate::store::put(conn, act::NS, act::COLL, row.scope, row.id.clone(), &row.doc) {
                Ok(_) => {
                    q.pop_front();
                }
                Err(_) => break,
            }
        }
    }

    if let Err(e) = crate::store::put(conn, act::NS, act::COLL, scope, id.clone(), &doc) {
        FAILURES.fetch_add(1, Ordering::Relaxed);
        let _ = e;
        if let Ok(mut q) = PENDING.lock() {
            let dropped = pending_push(&mut q, PendingRow { scope, id, doc });
            if dropped > 0 {
                DROPS.fetch_add(dropped, Ordering::Relaxed);
            }
        }
        return false;
    }
    // 보관 정리 — 이것이 빠지면 그 원장은 영원히 자란다(cored 경로가 정확히 그랬다).
    let _ = crate::store::retention_trim(conn, act::NS, act::COLL, scope, PERSIST_CAP);
    true
}

#[cfg(test)]
#[path = "activity_persist_tests.rs"]
mod tests;
