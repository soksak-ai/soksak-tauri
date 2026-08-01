//! 스트림 토큰 — 답 하나로 끝나지 않는 명령의 되돌아오는 길.
//!
//! 터미널 출력·프로세스 stdout·파일 감시는 **답이 여럿**이다. 요청/응답 한 쌍으로는 담기지
//! 않으므로 부르는 쪽이 받을 자리를 함께 보낸다: 인자 어딘가에 토큰 하나가 실리고, 그 뒤로
//! 프레임이 그 토큰을 달고 밀려온다.
//!
//! 프레임워크마다 그 자리의 실체가 다르다 — Tauri 는 `Channel`, Electron 은 프리로드가 만든
//! 토큰이다. 함수는 프로세스 경계를 넘지 못하므로, 소켓 위에서는 **어느 쪽이든 토큰**이다.
//!
//! 여기 있는 것은 그 토큰을 **찾고 만드는 규칙**뿐이다. 미는 일은 연결을 가진 쪽이 한다.
//! 규칙이 두 벌이면 한쪽이 만든 프레임을 다른 쪽이 못 알아보고, 그 어긋남은 오류가 아니라
//! "터미널이 아무것도 안 나온다"로 나타난다.

use serde_json::{json, Map, Value};

/// 인자 안에서 토큰을 지목하는 키. 프리로드가 이 이름으로 싣는다(electron/preload.cjs).
pub const TOKEN_KEY: &str = "__frameworkStream";

/// 밀려오는 프레임의 봉투 키. 응답 봉투(`ok`/`code`/`data`)와 겹치지 않는다 — 겹치면 받는 쪽이
/// 프레임을 답으로 읽고 짝을 지운다.
pub const FRAME_KEY: &str = "stream";

/// 인자에 실린 스트림 토큰들 — 인자 이름과 토큰의 짝.
///
/// 한 호출이 스트림을 둘 이상 받을 수 있다(출력과 종료 신호를 따로 받는 명령). 첫 개만 보면
/// 나머지는 조용히 굶는다.
pub fn tokens(params: &Value) -> Vec<(String, String)> {
    let Some(obj) = params.as_object() else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = obj
        .iter()
        .filter_map(|(k, v)| token_of(v).map(|t| (k.clone(), t)))
        .collect();
    // 정렬은 결정성을 위해서다 — 같은 인자에 대해 호출마다 순서가 뒤바뀌면 검사가 흔들린다.
    out.sort();
    out
}

/// 이 값이 스트림 토큰인가. 토큰은 `{"__frameworkStream":"s1"}` 한 모양뿐이다.
pub fn token_of(v: &Value) -> Option<String> {
    v.as_object()?
        .get(TOKEN_KEY)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 프레임 한 줄 — 이 토큰으로 이것이 왔다.
pub fn frame(token: &str, msg: Value) -> Value {
    json!({ FRAME_KEY: { "token": token, "msg": msg } })
}

/// 종료 메시지 — **수 하나로 건넌다.**
///
/// 봉투를 씌우면 소비자가 프레임워크마다 다른 것을 받는다. 코어 계약은 `onExit(code: number)`
/// 이고(플러그인 API), 그 계약을 만족하는 모양은 하나다. 실측(2026-08-01): 앱은 수를,
/// cored 는 `{"code":N}` 을 보내고 있었다 — 같은 이름의 종료가 어느 프로세스를 지났느냐에
/// 따라 소비자에게 숫자로도 객체로도 도착했다.
pub fn exit_msg(code: i32) -> Value {
    Value::from(code)
}

/// 밀려온 줄에서 프레임을 읽는다. 프레임이 아니면 None — 응답 봉투는 그대로 응답이다.
pub fn read_frame(line: &Value) -> Option<(String, Value)> {
    let f = line.get(FRAME_KEY)?.as_object()?;
    let token = f.get("token")?.as_str()?.to_string();
    Some((token, f.get("msg").cloned().unwrap_or(Value::Null)))
}

/// 토큰 자리를 **지운** 인자 — 명령의 몸은 토큰을 몰라도 된다.
///
/// 남겨 두면 명령마다 "이 인자는 토큰이니 무시하라"를 따로 알아야 하고, 하나가 빠뜨리면 그
/// 명령만 조용히 다르게 군다.
pub fn without_tokens(params: &Value) -> Value {
    match params.as_object() {
        Some(obj) => Value::Object(
            obj.iter()
                .filter(|(_, v)| token_of(v).is_none())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Map<String, Value>>(),
        ),
        None => params.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_found_by_its_key_not_its_position() {
        let p = json!({ "cols": 80, "onOutput": { "__frameworkStream": "s1" } });
        assert_eq!(tokens(&p), vec![("onOutput".to_string(), "s1".to_string())]);
    }

    /// 한 호출이 스트림을 둘 이상 받는다 — 첫 개만 보면 나머지는 조용히 굶는다.
    #[test]
    fn every_token_is_found_not_only_the_first() {
        let p = json!({
            "onOutput": { "__frameworkStream": "s1" },
            "onExit": { "__frameworkStream": "s2" },
            "cols": 80,
        });
        assert_eq!(
            tokens(&p),
            vec![
                ("onExit".to_string(), "s2".to_string()),
                ("onOutput".to_string(), "s1".to_string()),
            ]
        );
    }

    #[test]
    fn a_call_without_streams_has_no_tokens() {
        assert!(tokens(&json!({ "cols": 80 })).is_empty());
        assert!(tokens(&json!(null)).is_empty());
        assert!(tokens(&json!([1, 2])).is_empty());
    }

    /// 빈 토큰은 토큰이 아니다 — 빈 문자열로 밀면 아무도 못 받고, 그 프레임은 사라진다.
    #[test]
    fn an_empty_token_is_not_a_token() {
        assert!(tokens(&json!({ "on": { "__frameworkStream": "" } })).is_empty());
        assert!(tokens(&json!({ "on": { "__frameworkStream": 7 } })).is_empty());
        assert!(tokens(&json!({ "on": {} })).is_empty());
    }

    /// 프레임 봉투는 응답 봉투와 겹치지 않는다 — 겹치면 받는 쪽이 프레임을 답으로 읽는다.
    #[test]
    fn a_frame_is_not_mistaken_for_a_reply() {
        let f = frame("s1", json!({ "bytes": [1, 2, 3] }));
        assert!(f.get("ok").is_none());
        assert!(f.get("id").is_none());
        assert!(f.get("code").is_none());
        let (t, m) = read_frame(&f).expect("프레임");
        assert_eq!(t, "s1");
        assert_eq!(m["bytes"][0], 1);
    }

    #[test]
    fn a_reply_is_not_read_as_a_frame() {
        assert!(read_frame(&json!({ "ok": true, "id": 3, "data": null })).is_none());
        assert!(read_frame(&json!({ "stream": "s1" })).is_none());
    }

    /// 명령의 몸은 토큰을 몰라도 된다 — 남기면 명령마다 무시 규칙을 따로 알아야 한다.
    #[test]
    fn the_body_never_sees_the_token() {
        let p = json!({ "cols": 80, "onOutput": { "__frameworkStream": "s1" } });
        assert_eq!(without_tokens(&p), json!({ "cols": 80 }));
    }

    #[test]
    fn stripping_leaves_a_non_object_alone() {
        assert_eq!(without_tokens(&json!(null)), json!(null));
        assert_eq!(without_tokens(&json!([1])), json!([1]));
    }
}

#[cfg(test)]
mod exit_tests {
    use super::*;

    /// 종료는 수 하나다 — 봉투를 씌우면 `onExit(code: number)` 계약이 깨진다.
    #[test]
    fn 종료는_봉투_없이_수로_간다() {
        let v = exit_msg(130);
        assert!(v.is_number(), "객체로 감싸면 소비자가 숫자를 못 읽는다: {v}");
        assert_eq!(v.as_i64(), Some(130));
    }
}
