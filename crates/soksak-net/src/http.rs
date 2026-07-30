// 범용 HTTP 요청 capability 의 몸 — method/url/headers/query/body 를 받아 {status, headers, body}.
// webview JS 는 임의 출처로 raw HTTP 를 못 보내(CORS/보안) 이 자리가 대신 보낸다. 특정 API 락인 0.
//
// ── 시크릿은 여기서만 실값이 된다 ────────────────────────────────────────────
// secret_subst{placeholder→secretKey} 를 해소해 url/headers/body 의 placeholder 를 실값으로 바꾼
// 뒤 전송한다. 평문은 JS·history·lastResponse 어디에도 안 남는다. 하나라도 잠김/미존재면
// 전송 **전에** Err — 미해소 placeholder 가 요청으로 나가면 그것은 실패가 아니라 유출이다.
//
// 볼트를 여기서 읽지 않는다. 여는 것은 프로세스의 일이고(키체인 신원·잠금 수명), 이 규칙은
// `resolve` 를 **인자로** 받는다. 앰비언트로 캐면 같은 코드가 프로세스마다 다른 시크릿을
// 집어 들고, 그 차이는 오류가 아니라 "저쪽에서만 401" 로 나타난다.
//
// 두 모드, 한 인터페이스: impersonate 토글이 전송기를 고른다. 어느 모드든 응답 shape·시크릿
// 치환은 동일하다. 단 Authorization 요청은 검증된 target 에만 귀속되므로 정직 경로가 redirect 를
// 전부 차단하고, redirect 정책을 호출별로 고정할 수 없는 위장 공유 client 는 fail-closed 한다.

use std::collections::HashMap;

use crate::transport;

#[derive(serde::Serialize, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

// 호출자가 준 요청 그대로 — 치환 전이다.
//
// 프로세스를 건넌다(소켓으로 온 요청도 이 모양이다). method·url 은 기본값을 두지 않는다 —
// 빠뜨린 요청이 빈 문자열로 서면 "어디로 무엇을"이 없는 채로 돌고, 그 답은 오류가 아니라
// 엉뚱한 실패다.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub query: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub ns: Option<String>,
    #[serde(default)]
    pub secret_subst: Option<HashMap<String, String>>,
    #[serde(default)]
    pub impersonate: Option<String>,
}

// ns 볼트에서 시크릿 하나를 평문으로 꺼내는 일 — 프로세스가 준다.
pub type SecretResolver<'a> = &'a dyn Fn(&str, &str) -> Result<String, String>;

// placeholder→실값 치환 — url/header/body 단일 규칙(모든 출현). placeholder 는 NUL 래핑 마커라
// 사용자 텍스트와 충돌 0.
pub fn substitute(text: &str, subst: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (ph, val) in subst {
        out = out.replace(ph, val);
    }
    out
}

// secret_subst(placeholder→secretKey)를 placeholder→평문 으로 해소. 비면 빈 맵.
// 비어있지 않으면 ns 필수. 하나라도 잠김/미존재면 Err.
pub fn resolve_secret_subst(
    resolve: SecretResolver<'_>,
    ns: Option<&str>,
    secret_subst: &Option<HashMap<String, String>>,
) -> Result<HashMap<String, String>, String> {
    match secret_subst {
        Some(map) if !map.is_empty() => {
            let ns = ns.ok_or("secret_subst 주입에는 ns 필수")?;
            let mut out = HashMap::new();
            for (ph, key) in map {
                out.insert(ph.clone(), resolve(ns, key)?);
            }
            Ok(out)
        }
        _ => Ok(HashMap::new()),
    }
}

// 전송 백엔드 선택 — "off"(기본)=정직, "chrome"=위장.
fn impersonate_chrome(impersonate: Option<&str>) -> bool {
    matches!(impersonate, Some("chrome"))
}

fn has_authorization_header(headers: &HashMap<String, String>) -> bool {
    headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("authorization"))
}

// 치환 완료된 순수 입력 → 응답("off" 정직 백엔드). Authorization 이 실린 요청의 redirect-none
// 보안 불변은 transport::honest_request 가 시행한다.
pub fn send_http(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<HttpResponse, String> {
    let (status, headers, body) =
        transport::honest_request(method, url, headers, query, body, content_type)?;
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

// impersonate:"chrome" — 백엔드만 다르다(off 경로와 동일 shape). 치환은 호출 전 완료됨.
pub fn send_http_impersonated(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<HttpResponse, String> {
    let (status, headers, body) =
        transport::impersonated_request(method, url, headers, query, body, content_type)?;
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

// 한 요청의 전부 — 해소·치환·백엔드 선택·전송. 프레임워크의 명령 래퍼는 볼트 해소 함수만 준다.
pub fn request(resolve: SecretResolver<'_>, req: HttpRequest) -> Result<HttpResponse, String> {
    let subst = resolve_secret_subst(resolve, req.ns.as_deref(), &req.secret_subst)?;
    let url = substitute(&req.url, &subst);
    let headers: HashMap<String, String> = req
        .headers
        .into_iter()
        .map(|(k, v)| (k, substitute(&v, &subst)))
        .collect();
    let query: HashMap<String, String> = req
        .query
        .into_iter()
        .map(|(k, v)| (k, substitute(&v, &subst)))
        .collect();
    let body = req.body.map(|b| substitute(&b, &subst));

    if impersonate_chrome(req.impersonate.as_deref()) {
        // 위장 공유 client 는 자기 redirect 정책을 소유해 호출별로 못 끈다. 자격증명이 실린
        // 요청에 필요한 no-redirect 불변을 줄 수 없으므로 조용히 약화하지 않고 닫아 실패한다.
        if has_authorization_header(&headers) {
            return Err(
                "Authorization 요청은 impersonate=chrome을 사용할 수 없음(redirect 차단 불가)"
                    .to_string(),
            );
        }
        send_http_impersonated(
            &req.method,
            &url,
            &headers,
            &query,
            body.as_deref(),
            req.content_type.as_deref(),
        )
    } else {
        send_http(
            &req.method,
            &url,
            &headers,
            &query,
            body.as_deref(),
            req.content_type.as_deref(),
        )
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
