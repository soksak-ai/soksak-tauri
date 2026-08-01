//! 딥링크 command URI 라우팅 — `soksak[-env]://cmd/<명령>?<query>` 를 명령 실행으로 푼다.
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

/// `soksak[-env]://cmd/<명령>?<query>` → (명령 이름, params 오브젝트).
///
/// **형식은 여기 하나다.** 한때 이 파서와 프론트 파서가 서로 다른 형식을 읽었고 둘 다 살아
/// 있었다(Tauri 는 이쪽, Electron 은 저쪽) — 한 프레임워크에서 되는 링크가 다른 쪽에서 안 됐고,
/// 그 어긋남은 오류가 아니라 "저 앱에서는 안 열린다"로만 났다(실측 2026-08-01).
///
/// 딥링크는 **밖에서 온 명령 실행**이다. 명령 표면의 주인은 이 프로세스이므로 파싱도 여기 있다 —
/// 창이 없어도 닿아야 하고, 코어 명령·플러그인 명령이 창 유무와 무관하게 돌아야 한다.
pub fn parse_command_url(raw: &str) -> Option<(String, Value)> {
    let u = Url::parse(raw).ok()?;
    if !is_command_scheme(u.scheme()) || u.host_str() != Some("cmd") {
        return None;
    }
    let cmd = percent_decode(u.path().trim_start_matches('/'));
    if cmd.is_empty() {
        return None;
    }
    // query 는 그대로 params 다. 값 강제(숫자·불리언 해석)는 여기서 하지 않는다 — 그것은 명령의
    // 파라미터 계약이고, 여기서 추측하면 그 계약이 두 벌이 된다.
    let mut params = serde_json::Map::new();
    for (k, v) in u.query_pairs() {
        params.insert(k.to_string(), Value::String(v.to_string()));
    }
    Some((cmd, Value::Object(params)))
}

/// URL 경로 한 조각의 퍼센트 해독 — 프론트가 `encodeURIComponent` 로 짓는다.
/// 새 의존을 들이지 않는다: 이 한 가지를 위해 크레이트를 늘리면 그것이 다음 사람의 짐이 된다.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[cfg(test)]
#[path = "deeplink_tests.rs"]
mod tests;
