// 백업/복원/이식 — 쉬운 백업/복원(사용자 요구). 전체 스냅샷은 VACUUM INTO(단일 .db, WAL 사이드카
// 흡수). 복원은 검증 후 원자 스왑(현재본 안전복사). JSONL export/import 는 네임스페이스 단위 이식용
// (id/doc/scope 보존, created/updated 는 재스탬프 — 정확한 스냅샷은 backup/restore 사용).

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::{ring, store};

// 부팅 복구 보고 — 격리한 손상본 경로와 복원 출처 슬롯. restored_from=None 은 전 슬롯 실패로 빈 DB
// 재시작을 뜻한다. 무음 복구 금지 — 이 값이 호출 측 activity 고지의 재료다.
pub struct Recovery {
    pub quarantined: PathBuf,
    pub restored_from: Option<usize>,
}

// VACUUM INTO — 일관된 단일 파일 스냅샷(WAL 체크포인트 포함). 경로는 작은따옴표 이스케이프.
pub fn backup(conn: &Connection, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let p = dest.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{p}';"))
        .map_err(|e| e.to_string())
}

// 후보 .db 가 우리 스키마의 정상 SQLite 인지 검증(integrity_check + records/kv 존재).
pub fn validate(src: &Path) -> Result<(), String> {
    if !src.is_file() {
        return Err(format!("백업 파일 없음: {}", src.display()));
    }
    let conn = Connection::open(src).map_err(|e| e.to_string())?;
    let ok: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err(format!("무결성 검사 실패: {ok}"));
    }
    let has: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('records','kv','meta_collections')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has < 3 {
        return Err("soksak 데이터 스키마가 아님(records/kv/meta_collections 누락)".to_string());
    }
    Ok(())
}

// 원자 복원 — 검증 → 현재본 안전복사 → 스왑(현재 .db 덮기 + 스테일 WAL 제거). 호출 측에서
// 기존 Connection 을 드롭(파일 잠금 해제·체크포인트)한 뒤 호출해야 한다.
pub fn restore_into(db_path: &Path, src: &Path) -> Result<PathBuf, String> {
    validate(src)?;
    let backup_copy = db_path.with_extension(format!("bak-{}.db", crate::now_millis()));
    if db_path.exists() {
        std::fs::copy(db_path, &backup_copy).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, db_path).map_err(|e| e.to_string())?;
    // 스테일 WAL/SHM 제거(새 본문과 불일치 방지).
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", db_path.to_string_lossy()));
        let _ = std::fs::remove_file(side);
    }
    Ok(backup_copy)
}

// 부팅 손상 복구 — 손상본을 격리(증거 보존)한 뒤 백업 슬롯을 신선순(0=최신)으로 validate 하며
// 첫 정상 슬롯을 복원한다. 전 슬롯 실패면 restored_from=None 으로 반환(호출 측이 빈 DB 로 재개방).
// 격리는 rename 이라 원본 바이트가 그대로 남는다 — 사후 조사·수동 추출용.
pub fn recover(db_path: &Path) -> Result<Recovery, String> {
    let quarantined = quarantine(db_path)?;
    for i in 0..ring::SLOTS {
        // restore_into 가 슬롯을 validate(integrity_check+스키마) 후에만 복사한다 — 실패 슬롯은 건너뛴다.
        if restore_into(db_path, &ring::slot_path(db_path, i)).is_ok() {
            return Ok(Recovery {
                quarantined,
                restored_from: Some(i),
            });
        }
    }
    Ok(Recovery {
        quarantined,
        restored_from: None,
    })
}

// 손상본을 `<db>.corrupt-<ms>` 로 옮기고 스테일 사이드카를 제거한다. rename 은 원본을 보존한다.
fn quarantine(db_path: &Path) -> Result<PathBuf, String> {
    let dst = PathBuf::from(format!(
        "{}.corrupt-{}",
        db_path.to_string_lossy(),
        crate::now_millis()
    ));
    std::fs::rename(db_path, &dst).map_err(|e| e.to_string())?;
    // 손상 본체의 WAL/SHM 은 복원본·신규본과 불일치하므로 남기지 않는다.
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", db_path.to_string_lossy()));
    }
    Ok(dst)
}

// ── JSONL export/import ───────────────────────────────────────────────────────

pub fn export(conn: &Connection, ns: Option<&str>, coll: Option<&str>) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    let push = |lines: &mut Vec<String>, v: Value| {
        if let Ok(s) = serde_json::to_string(&v) {
            lines.push(s);
        }
    };

    // meta
    {
        let mut sql = String::from("SELECT ns,coll,idx_fields,fts_fields FROM meta_collections");
        let mut conds = Vec::new();
        if ns.is_some() {
            conds.push("ns=?1");
        }
        if coll.is_some() {
            conds.push(if ns.is_some() { "coll=?2" } else { "coll=?1" });
        }
        if !conds.is_empty() {
            sql.push_str(&format!(" WHERE {}", conds.join(" AND ")));
        }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"meta","ns":r.get::<_,String>(0)?,"coll":r.get::<_,String>(1)?,
                "idx":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!([])),
                "fts":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!([])),
            }))
        };
        let rows = bind_query(&mut stmt, ns, coll, map)?;
        for v in rows {
            push(&mut lines, v);
        }
    }
    // records
    {
        let mut sql = String::from("SELECT ns,coll,scope,id,doc FROM records");
        let mut conds = Vec::new();
        if ns.is_some() {
            conds.push("ns=?1");
        }
        if coll.is_some() {
            conds.push(if ns.is_some() { "coll=?2" } else { "coll=?1" });
        }
        if !conds.is_empty() {
            sql.push_str(&format!(" WHERE {}", conds.join(" AND ")));
        }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"record","ns":r.get::<_,String>(0)?,"coll":r.get::<_,String>(1)?,
                "scope":r.get::<_,String>(2)?,"id":r.get::<_,String>(3)?,
                "doc":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).unwrap_or(json!({})),
            }))
        };
        let rows = bind_query(&mut stmt, ns, coll, map)?;
        for v in rows {
            push(&mut lines, v);
        }
    }
    // kv (coll 무관 — coll 지정 시 생략)
    if coll.is_none() {
        let mut stmt = conn
            .prepare(if ns.is_some() {
                "SELECT ns,k,v FROM kv WHERE ns=?1"
            } else {
                "SELECT ns,k,v FROM kv"
            })
            .map_err(|e| e.to_string())?;
        let map = |r: &rusqlite::Row| {
            Ok(json!({
                "kind":"kv","ns":r.get::<_,String>(0)?,"k":r.get::<_,String>(1)?,
                "v":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(json!(null)),
            }))
        };
        let rows: Vec<Value> = if let Some(ns) = ns {
            stmt.query_map([ns], map)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        } else {
            stmt.query_map([], map)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        };
        for v in rows {
            push(&mut lines, v);
        }
    }
    Ok(lines.join("\n"))
}

// ns/coll 조합에 맞춰 파라미터 바인딩(0/1/2개). 한 분기만 실행 → map 이동 OK.
fn bind_query(
    stmt: &mut rusqlite::Statement,
    ns: Option<&str>,
    coll: Option<&str>,
    map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
) -> Result<Vec<Value>, String> {
    let out: Vec<Value> = match (ns, coll) {
        (Some(n), Some(c)) => stmt
            .query_map((n, c), map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (Some(n), None) => stmt
            .query_map([n], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (None, Some(c)) => stmt
            .query_map([c], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
        (None, None) => stmt
            .query_map([], map)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?,
    };
    Ok(out)
}

// import — meta(define) → record(put) → kv(set). 반환=적용 레코드/kv 수.
pub fn import(conn: &Connection, jsonl: &str) -> Result<i64, String> {
    let mut n = 0i64;
    for line in jsonl.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let ns = v.get("ns").and_then(|x| x.as_str()).unwrap_or("");
        // 들어오는 길도 검증한다 — 안 하면 나머지 표면이 주소로 삼을 수 없는 ns 가 저장소에 앉는다.
        // 실측: 검증 없는 import 가 "plugin:probe-lane" 을 만들었고, 그 뒤 어떤 명령도 그것을 읽지도
        // 지우지도 못했다(전 명령이 validate_ns 를 지난다). 만든 길이 규칙을 안 지키면 규칙이 아니다.
        soksak_core::kv::validate_ns(ns)?;
        match kind {
            "meta" => {
                let coll = v.get("coll").and_then(|x| x.as_str()).unwrap_or("");
                let idx: Vec<String> = v
                    .get("idx")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let fts: Vec<String> = v
                    .get("fts")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| s.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                store::define(conn, ns, coll, &idx, &fts)?;
            }
            "record" => {
                let coll = v.get("coll").and_then(|x| x.as_str()).unwrap_or("");
                let scope = v.get("scope").and_then(|x| x.as_str()).unwrap_or("");
                let id = v.get("id").and_then(|x| x.as_str()).map(String::from);
                let doc = v.get("doc").cloned().unwrap_or(json!({}));
                store::put(conn, ns, coll, scope, id, &doc)?;
                n += 1;
            }
            "kv" => {
                let k = v.get("k").and_then(|x| x.as_str()).unwrap_or("");
                let val = v.get("v").cloned().unwrap_or(Value::Null);
                store::kv_set(conn, ns, k, &val)?;
                n += 1;
            }
            _ => {}
        }
    }
    Ok(n)
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
