// 바깥으로 나가는 전송기 — BoringSSL 한 스택, 두 얼굴.
//
//   정직(honest)      위장 없는 wreq. first-party 호출을 위조하지 않는 것이 올바른 기본값이다.
//   위장(impersonate) Chrome 핸드셰이크를 정밀 위조한 wreq. fingerprint 봇차단 CDN(Cloudflare/
//                     Akamai)이 TLS(JA3)+HTTP/2 지문으로 비-브라우저를 403 하는 자리에서만 쓴다.
//
// 두 번째 TLS 스택(reqwest/OpenSSL)으로 폴백하지 않는다 — 그 이중 스택의 SSL_* 심볼 충돌이
// Linux 정적 링크를 깨던 결함의 근치다. 연결 실패는 502 로 정직히 실패한다.
//
// ── 왜 클라이언트·런타임은 전역으로 남는가 ─────────────────────────────────────
// 프록시의 포트·토큰은 전역이면 안 된다(그것이 곧 **답**이라 프로세스마다 달라진다). 여기 셋은
// 답이 아니라 **자원**이다: 어느 인스턴스로 보내든 같은 요청이 같은 응답을 받고, 바뀌는 것은
// 연결 풀과 스레드뿐이다. 요청마다 런타임을 세우면 그 비용이 매 세그먼트에 붙는다.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use url::Url;
use wreq_util::Emulation;

static ASYNC_RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static WREQ_CLIENT: OnceLock<wreq::Client> = OnceLock::new();
static WREQ_HONEST_CLIENT: OnceLock<wreq::Client> = OnceLock::new();

// wreq 는 async 전용이고 프록시 루프는 sync 다 — 그 사이를 block_on 이 잇는다.
pub(crate) fn rt() -> Option<&'static tokio::runtime::Runtime> {
    if ASYNC_RT.get().is_none() {
        if let Ok(rt) = tokio::runtime::Runtime::new() {
            let _ = ASYNC_RT.set(rt);
        }
    }
    ASYNC_RT.get()
}

pub(crate) fn impersonating_client() -> Option<&'static wreq::Client> {
    if WREQ_CLIENT.get().is_none() {
        if let Ok(c) = wreq::Client::builder()
            .emulation(Emulation::Chrome136)
            .build()
        {
            let _ = WREQ_CLIENT.set(c);
        }
    }
    WREQ_CLIENT.get()
}

pub(crate) fn honest_client() -> Option<&'static wreq::Client> {
    if WREQ_HONEST_CLIENT.get().is_none() {
        // 무한 대기 금지 — stall 한 원격이 호출자를 영원히 붙잡지 못한다(설치 클로저 다중 fetch 의 근치).
        if let Ok(c) = wreq::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
        {
            let _ = WREQ_HONEST_CLIENT.set(c);
        }
    }
    WREQ_HONEST_CLIENT.get()
}

// referer 에서 origin 을 유도한다 — hotlink 보호는 둘을 함께 본다. referer 만 실으면
// origin 을 보는 CDN 이 그대로 403 한다.
pub(crate) fn origin_of(u: &str) -> Option<String> {
    let p = Url::parse(u).ok()?;
    let host = p.host_str()?;
    let port = p.port().map(|x| format!(":{x}")).unwrap_or_default();
    Some(format!("{}://{}{}", p.scheme(), host, port))
}

// 임퍼소네이션 fetch → (status, content-* 헤더, 바디 바이트). referer/origin/range 동일 주입.
pub(crate) fn impersonated_fetch(
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let rt = rt().ok_or("wreq runtime")?;
    let client = impersonating_client().ok_or("wreq client")?;
    rt.block_on(async {
        let mut rb = client.get(url);
        if let Some(r) = referer {
            rb = rb.header("referer", r);
            if let Some(o) = origin_of(r) {
                rb = rb.header("origin", o);
            }
        }
        if let Some(rg) = range {
            rb = rb.header("range", rg);
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
        ]
        .iter()
        .filter_map(|h| {
            resp.headers()
                .get(*h)
                .and_then(|v| v.to_str().ok())
                .map(|v| ((*h).to_string(), v.to_string()))
        })
        .collect();
        let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok::<_, String>((status, headers, body))
    })
}

// query 를 URL 에 직접 붙인다 — wreq 의 .query() 는 "query" feature 게이트라(미활성) 새 feature 켜는 대신
// 이미 쓰는 url::form_urlencoded 로 인코딩(정직/임퍼소네이션 두 경로 공용, 단일 진실).
pub(crate) fn build_target(url: &str, query: &HashMap<String, String>) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    let mut enc = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in query {
        enc.append_pair(k, v);
    }
    let qs = enc.finish();
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{qs}")
}

// 위장 전송 — 시크릿 치환은 호출 전에 끝났다. 여기는 순수 전송기일 뿐이다.
pub fn impersonated_request(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<(u16, HashMap<String, String>, String), String> {
    let client = impersonating_client().ok_or("wreq client")?;
    send_text(client, method, url, headers, query, body, content_type, false)
}

// 정직 전송 — 위장만 없고 응답 shape 는 위와 같다. Authorization 이 실린 요청은 리다이렉트를
// 따르지 않는다(검증된 대상 URL 밖으로 자격증명이 새지 않게 — HTTPS→HTTP 강등 포함).
pub fn honest_request(
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<(u16, HashMap<String, String>, String), String> {
    let client = honest_client().ok_or("wreq client")?;
    let no_redirect = headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization"));
    send_text(
        client,
        method,
        url,
        headers,
        query,
        body,
        content_type,
        no_redirect,
    )
}

// 두 전송기의 공통 몸. 갈리면 한쪽만 고친 보안 불변(redirect·헤더 순서)이 다른 쪽에 안 간다.
#[allow(clippy::too_many_arguments)]
fn send_text(
    client: &wreq::Client,
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    query: &HashMap<String, String>,
    body: Option<&str>,
    content_type: Option<&str>,
    no_redirect: bool,
) -> Result<(u16, HashMap<String, String>, String), String> {
    let rt = rt().ok_or("wreq runtime")?;
    let m = wreq::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("HTTP method 불량: {e}"))?;
    let target = build_target(url, query);
    rt.block_on(async {
        let mut rb = client.request(m, target.as_str());
        if no_redirect {
            rb = rb.redirect(wreq::redirect::Policy::none());
        }
        for (k, v) in headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(b) = body {
            rb = rb.body(b.to_string());
        }
        let resp = rb.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let mut hmap = HashMap::new();
        for (k, v) in resp.headers() {
            hmap.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, hmap, text))
    })
}

// fetch reach 다운로드용 정직 GET(바디 바이트) — 호출자가 sha256 핀으로 검증한다(무결성 우선).
pub fn honest_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let rt = rt().ok_or("wreq runtime")?;
    let client = honest_client().ok_or("wreq client")?;
    rt.block_on(async {
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok::<_, String>(body)
    })
}
