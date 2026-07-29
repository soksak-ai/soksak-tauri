//! 레코드 id·시각·이름 규칙 — 저장 연산이 쓰는 작은 진실들.
//!
//! 이름 검증이 두 벌이면 한쪽이 막는 이름을 다른 쪽이 만들고, 그 레코드는 만든 쪽에서만 읽힌다.

use std::time::{SystemTime, UNIX_EPOCH};

// ── 공용 헬퍼 ────────────────────────────────────────────────────────────────

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 레코드 id 미지정 시 생성 — 시간(ms)+프로세스+나노 꼬리. 정렬가능·충돌 회피용(uuid 의존 회피).
pub fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:013}-{}-{}",
        now_millis(),
        std::process::id(),
        nanos % 1_000_000
    )
}

// ns = 호출 pluginId(또는 "core"). 경로/식별자 안전 문자만(plugins.rs sanitize_id 와 동형).
// 규칙은 soksak-core 이 소유한다 — cored 도 같은 규칙으로 거른다.
pub fn validate_ns(ns: &str) -> Result<(), String> {
    soksak_core::kv::validate_ns(ns)
}

// 컬렉션명 — [a-z0-9_]. (ns 와 분리된 문자셋이라 메타 키 충돌 없음.)
pub fn validate_coll(coll: &str) -> Result<(), String> {
    if !coll.is_empty()
        && coll
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        Ok(())
    } else {
        Err(format!("잘못된 컬렉션: {coll:?}"))
    }
}

// 인덱스/FTS/필터 필드명 — JSON 경로($.field)·인덱스명에 직접 쓰이므로 엄격 화이트리스트
// (SQL 주입 차단). created/updated 는 실제 컬럼이라 별도 허용.
pub fn validate_field(field: &str) -> Result<(), String> {
    let mut chars = field.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 필드명: {field:?}"))
    }
}
