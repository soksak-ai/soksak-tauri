//! 딥링크 command URI 라우팅 — `soksak://run?cmd=<명령>&p=<JSON>` 을 명령 실행으로 푼다.
//!
//! 알림 클릭·외부 진입(`open soksak://…`)이 한 명령을 실행하는 단일 경로다. 여기는 **파싱과
//! 라우팅만** 한다 — 실행은 부르는 쪽이 자기 registry 에 위임한다(단일 실행 경로).
//!
//! URI 스킴은 제품의 것이지 프레임워크의 것이 아니다. 한때 이 규칙이 Tauri 폴더 안에 살았고,
//! 그러면 프레임워크가 둘이 될 때 한쪽만 딥링크를 알게 된다 — 그 차이는 오류가 아니라
//! "저 앱에서는 링크가 안 열린다"로 나타난다. OS 스킴 등록과 `on_open_url` 배선은 여전히
//! 프레임워크의 몫이다(부수효과이고 창을 안다).
use serde_json::Value;
use url::Url;

/// soksak://run?cmd=NAME&p=JSON → (명령 이름, params 오브젝트). 스킴≠soksak·호스트≠run·cmd 없음/빈값이면
/// None. p 는 URL-인코딩된 JSON 오브젝트(생략·비오브젝트면 빈 오브젝트). 미지 query 키는 무시.
pub fn parse_command_url(raw: &str) -> Option<(String, Value)> {
    let u = Url::parse(raw).ok()?;
    if u.scheme() != "soksak" || u.host_str() != Some("run") {
        return None;
    }
    let mut cmd: Option<String> = None;
    let mut params = Value::Object(serde_json::Map::new());
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "cmd" => cmd = Some(v.to_string()),
            "p" => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
                    if parsed.is_object() {
                        params = parsed;
                    }
                }
            }
            _ => {}
        }
    }
    let cmd = cmd?;
    if cmd.is_empty() {
        return None;
    }
    Some((cmd, params))
}

#[cfg(test)]
#[path = "deeplink_tests.rs"]
mod tests;
