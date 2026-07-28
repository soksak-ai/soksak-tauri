//! KV 조회 — 연결은 **자원**이지 셸이 아니다. 다만 타입으로는 건너오지 못한다.
//!
//! `rusqlite::Connection` 을 인자로 받으면 이 크레이트가 rusqlite 에 의존하게 되고,
//! 무-셸 게이트(`tests/no_shell.rs`)의 의존성 금지 목록이 그것을 거부한다. 자원을 인자로
//! 받는다는 판단은 옳지만, 그 자원의 **타입**까지 들이면 크레이트가 SQLite 를 가진 프로세스
//! 전용이 된다 — 이동성을 잃는 것은 셸 타입일 때와 똑같다.
//!
//! 그래서 연결은 `KvRows` 뒤에 남고 여기에는 그 뒤에 있는 것만 온다: ns 규칙, 원문 해독,
//! 그리고 둘을 잇는 순서. 앱은 자기 연결로, cored 는 자기 연결로 같은 규칙을 통과한다.

use serde_json::Value;

/// KV 한 칸의 **원문**(저장된 TEXT) 공급자. 행이 없으면 `None`.
///
/// 질의문과 연결은 구현자의 것이다 — 여기서 아는 것은 "ns·key 로 원문 하나"뿐이다.
pub trait KvRows {
    fn value(&self, ns: &str, key: &str) -> Result<Option<String>, String>;
}

/// ns 이름 규칙 — `^[a-z0-9][a-z0-9-]*$`.
///
/// 문자셋에 `/`·`.`·`:` 가 없어 ns 가 경로나 메타 키로 새지 않는다.
pub fn validate_ns(ns: &str) -> Result<(), String> {
    let mut chars = ns.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 ns: {ns:?}"))
    }
}

/// 저장된 원문 → 값. 행이 없으면 `None`.
///
/// 깨진 JSON 은 **오류**다. `None` 으로 접으면 "없는 키"와 구분이 사라지고, 호출자는
/// 기본값을 쓰며 그 손상을 영원히 못 본다.
pub fn decode(raw: Option<String>) -> Result<Option<Value>, String> {
    match raw {
        Some(s) => Ok(Some(serde_json::from_str(&s).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// KV 조회 한 번 — ns 검사, 원문 취득, 해독.
///
/// 검사가 먼저다. 이름이 규칙 밖이면 자원을 건드리기 전에 거부한다.
pub fn get(rows: &dyn KvRows, ns: &str, key: &str) -> Result<Option<Value>, String> {
    validate_ns(ns)?;
    decode(rows.value(ns, key)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeRows {
        rows: Vec<(String, String, String)>,
        asked: RefCell<Vec<String>>,
    }

    impl FakeRows {
        fn with(ns: &str, key: &str, raw: &str) -> Self {
            FakeRows {
                rows: vec![(ns.to_string(), key.to_string(), raw.to_string())],
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl KvRows for FakeRows {
        fn value(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
            self.asked.borrow_mut().push(format!("{ns}/{key}"));
            Ok(self
                .rows
                .iter()
                .find(|(n, k, _)| n == ns && k == key)
                .map(|(_, _, v)| v.clone()))
        }
    }

    #[test]
    fn the_ns_charset_is_the_rule() {
        assert!(validate_ns("core").is_ok());
        assert!(validate_ns("soksak-plugin-kanban").is_ok());
        assert!(validate_ns("9lives").is_ok());
        assert!(validate_ns("").is_err());
        assert!(validate_ns("-lead").is_err());
        assert!(validate_ns("Core").is_err());
        assert!(validate_ns("plugin:probe").is_err());
        assert!(validate_ns("../etc").is_err());
    }

    #[test]
    fn a_missing_row_is_none() {
        let rows = FakeRows::default();
        assert_eq!(get(&rows, "core", "settings").unwrap(), None);
    }

    #[test]
    fn a_row_decodes_to_its_value() {
        let rows = FakeRows::with("core", "settings", r#"{"theme":"dark"}"#);
        assert_eq!(
            get(&rows, "core", "settings").unwrap(),
            Some(json!({"theme": "dark"}))
        );
    }

    #[test]
    fn broken_stored_json_is_an_error_not_a_silent_none() {
        // 손상을 None 으로 접으면 "없는 키"와 구분이 사라진다 — 조용한 실패 금지.
        let rows = FakeRows::with("core", "settings", "{not json");
        assert!(get(&rows, "core", "settings").is_err());
    }

    #[test]
    fn a_bad_ns_is_refused_before_the_resource_is_touched() {
        let rows = FakeRows::default();
        assert!(get(&rows, "Bad Ns", "k").is_err());
        assert!(rows.asked.borrow().is_empty(), "검사 전에 자원을 만졌다");
    }

    #[test]
    fn the_answer_follows_the_rows_it_is_given() {
        // 연결이 인자라는 것의 요점 — 답이 프로세스가 아니라 넘겨받은 자원으로 결정된다.
        let a = FakeRows::with("core", "k", "1");
        let b = FakeRows::with("core", "k", "2");
        assert_ne!(get(&a, "core", "k").unwrap(), get(&b, "core", "k").unwrap());
    }

    #[test]
    fn a_row_error_travels_out() {
        struct Broken;
        impl KvRows for Broken {
            fn value(&self, _ns: &str, _key: &str) -> Result<Option<String>, String> {
                Err("DB 미초기화".to_string())
            }
        }
        assert_eq!(get(&Broken, "core", "k"), Err("DB 미초기화".to_string()));
    }
}
