//! AI 세션 계보 — cwd(scope)의 전이 레코드.
//!
//! 저장은 watch 가, 조회는 이 한 경로로 한다. 두 벌이면 같은 계보를 두 모양으로 답하고, 그
//! 차이는 오류가 아니라 **다른 흐름**으로 보인다.

use rusqlite::Connection;
use serde_json::Value;

/// AI 세션 계보 조회 — cwd(scope)의 전이 레코드를 시간순(created)으로.
///
/// 각 레코드 = {viewId, fromSession, toSession, kind, time}. 시간순 from→to 가 곧 흐름이고,
/// 같은 fromSession 에서 여러 toSession 이면 분기다. 저장은 watch 가, 조회는 이 한 경로로 —
/// 두 벌이면 같은 계보를 두 모양으로 답한다.
///
/// 계보는 평문(전이 메타)이라 복호 resolver 를 받지 않는다.
pub fn ai_session_lineage(
    conn: &Connection,
    cwd: &str,
    view_id: Option<String>,
) -> Result<Vec<Value>, String> {
    // 빈 cwd 의 답은 저장소 상태와 무관하다 — 잠그기 전에 거절한다.
    if cwd.is_empty() {
        return Err("cwd 필요".to_string());
    }
    let where_obj = view_id
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::json!({ "viewId": v }));
    crate::store::query(
        conn,
        "core",
        "ai_session_lineage",
        Some(cwd),
        where_obj.as_ref(),
        Some("created"),
        false,
        Some(1000),
        None,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // 계보 조회는 커넥션 하나면 선다 — 커맨드 층이 State 를 벗기는 것은 그쪽의 일이다.
    #[test]
    fn 계보_조회는_커넥션_하나면_선다() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::init_base(&conn).unwrap();
        assert_eq!(
            ai_session_lineage(&conn, "/w", None).unwrap(),
            Vec::<serde_json::Value>::new()
        );
        assert!(ai_session_lineage(&conn, "", None).is_err(), "빈 cwd 는 거부");
    }
}
