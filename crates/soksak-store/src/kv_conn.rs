//! KV 한 칸의 읽기·쓰기 — **연결만 여기 있고 규칙은 코어가 진다.**
//!
//! 질의문과 "언제 과거를 남기는가"는 `soksak_core::kv` 가 소유한다. 여기서 다시 적으면 같은
//! 사실이 두 벌이 되고, 그때 한쪽만 과거를 남긴다 — 실측 2026-08-01 에 cored 가 자기 UPSERT 를
//! 직접 돌아 이 파일의 과거 보존을 통째로 지나쳤다.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::ids::now_millis;

// ── KV ───────────────────────────────────────────────────────────────────────

// 저장된 원문 한 칸. 질의문과 연결은 여기 남고, 해독 규칙은 soksak-core 이 갖는다.
pub fn kv_raw(conn: &Connection, ns: &str, k: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT v FROM kv WHERE ns=?1 AND k=?2", (ns, k), |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

pub fn kv_get(conn: &Connection, ns: &str, k: &str) -> Result<Option<Value>, String> {
    soksak_core::kv::decode(kv_raw(conn, ns, k)?)
}

/// 이 연결을 코어 규칙에 끼우는 자리 — 네 트레이트를 한 어댑터가 채운다.
///
/// 읽기 전용 어댑터를 따로 두지 않는다: 같은 연결에 어댑터가 둘이면 어느 것을 쓰느냐에 따라
/// 과거가 남기도 하고 안 남기도 한다. 질의문도 규칙도 코어가 소유한다 — 여기서 다시 적으면
/// 같은 사실이 두 벌이 되고, 그때 한쪽만 과거를 남긴다(실측: cored 는 자기 UPSERT 를 직접
/// 돌아서 이 파일의 과거 보존을 통째로 지나쳤다).
pub struct ConnKv<'a>(pub &'a Connection);

impl soksak_core::kv::KvRows for ConnKv<'_> {
    fn value(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
        kv_raw(self.0, ns, key)
    }
}

impl soksak_core::kv::KvWrite for ConnKv<'_> {
    fn put(&self, ns: &str, key: &str, raw: &str, updated_ms: u64) -> Result<(), String> {
        self.0
            .execute(soksak_core::kv::UPSERT_SQL, (ns, key, raw, updated_ms as i64))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl soksak_core::kv::KvDelete for ConnKv<'_> {
    fn remove(&self, ns: &str, key: &str) -> Result<bool, String> {
        self.0
            .execute(soksak_core::kv::DELETE_SQL, (ns, key))
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }
}

impl soksak_core::kv::KvPast for ConnKv<'_> {
    fn push_past(&self, ns: &str, key: &str, raw: &str, at_ms: u64) -> Result<(), String> {
        self.0
            .execute(soksak_core::kv::PAST_INSERT_SQL, (ns, key, raw, at_ms as i64))
            .map_err(|e| e.to_string())?;
        self.0
            .execute(
                soksak_core::kv::PAST_PRUNE_SQL,
                (ns, key, soksak_core::kv::PAST_DEPTH as i64),
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn past(&self, ns: &str, key: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .0
            .prepare(soksak_core::kv::PAST_SELECT_SQL)
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map((ns, key), |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }
}

pub fn kv_set(conn: &Connection, ns: &str, k: &str, v: &Value) -> Result<(), String> {
    soksak_core::kv::set_keeping_past(&ConnKv(conn), ns, k, v, now_millis() as u64)
}

pub fn kv_delete(conn: &Connection, ns: &str, k: &str) -> Result<bool, String> {
    soksak_core::kv::delete_keeping_past(&ConnKv(conn), ns, k, now_millis() as u64)
}

/// 직전 값으로 되돌린다 — 되돌릴 것이 없으면 false.
pub fn kv_undo(conn: &Connection, ns: &str, k: &str) -> Result<bool, String> {
    soksak_core::kv::undo(&ConnKv(conn), ns, k, now_millis() as u64)
}

/// 이 칸이 간직한 과거 — 최신 직전 값이 앞.
pub fn kv_history(conn: &Connection, ns: &str, k: &str) -> Result<Vec<Value>, String> {
    soksak_core::kv::past(&ConnKv(conn), ns, k)
}

pub fn kv_keys(conn: &Connection, ns: &str, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let pat = format!("{}%", prefix.unwrap_or(""));
    let mut stmt = conn
        .prepare("SELECT k FROM kv WHERE ns=?1 AND k LIKE ?2 ORDER BY k")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((ns, pat), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "kv_conn_tests.rs"]
mod tests;
