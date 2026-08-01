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

/// 이 정체성의 URI 스킴 — **홈처럼 env 로 갈린다**(`soksak` · `soksak-dev` · `soksak-debug`).
///
/// 한 스킴을 모든 정체성이 주장하면 어느 앱이 그 링크를 받을지 **제비뽑기**가 된다. 실측
/// 2026-08-01: 이 기계의 LaunchServices 에 `soksak:` 을 주장하는 번들이 200 개가 넘었고(옛 dmg·
/// 옛 repo·워크트리), `open soksak://…` 이 도는 앱에 닿지 않았다. 그 부재는 오류가 아니라
/// "링크가 안 열린다"로만 나타난다.
///
/// 홈을 가르는 축이 env 하나이므로(identity.rs) 스킴도 그 축으로 간다 — release 는 접미사가
/// 없다(홈이 `~/.soksak` 인 것과 같은 규칙).
pub fn scheme_for(identifier: &str) -> String {
    // 홈 접미사와 **같은 판정**을 쓴다 — 홈이 `~/.soksak` 인 정체성은 스킴도 접미사가 없다.
    // 여기서 release 를 따로 판정하면 그 규칙이 두 벌이 되고, 갈리면 링크가 엉뚱한 앱으로 간다.
    let suffix = crate::identity::home_suffix_for_identifier(identifier);
    format!("{}{suffix}", crate::identity::PRODUCT)
}

/// 이 스킴이 이 제품의 명령 URI 인가 — 정체성 접미사는 받아들인다.
///
/// 파싱은 어느 정체성으로 왔는지 가리지 않는다: OS 가 이미 그 앱으로 넘긴 뒤이므로, 여기서
/// 다시 고르면 그 판정이 두 벌이 된다(등록이 정본이다).
pub fn is_command_scheme(scheme: &str) -> bool {
    scheme == crate::identity::PRODUCT
        || scheme
            .strip_prefix(crate::identity::PRODUCT)
            .and_then(|r| r.strip_prefix('-'))
            .is_some_and(|env| !env.is_empty())
}

/// soksak://run?cmd=NAME&p=JSON → (명령 이름, params 오브젝트). 스킴≠soksak·호스트≠run·cmd 없음/빈값이면
/// None. p 는 URL-인코딩된 JSON 오브젝트(생략·비오브젝트면 빈 오브젝트). 미지 query 키는 무시.
pub fn parse_command_url(raw: &str) -> Option<(String, Value)> {
    let u = Url::parse(raw).ok()?;
    if !is_command_scheme(u.scheme()) || u.host_str() != Some("run") {
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
