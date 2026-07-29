// HTTP capability 검사 — 서버는 이 프로세스 안에 세운다(외부망 비의존).

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

// 1회 요청을 받는 최소 HTTP 서버 — 받은 raw 요청을 채널로 돌려주고 고정 응답을 쓴다.
fn spawn_once_server(response: impl Into<String>) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    let response = response.into();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = tx.send(req);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, rx)
}

const OK_RESP: &str =
    "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: application/json\r\n\r\n{\"v\":\"hello\"}";

// 볼트 대역 — 이 규칙이 받는 것은 "ns 와 key 로 평문 하나"라는 계약뿐이다.
fn resolver_with(pairs: &'static [(&'static str, &'static str, &'static str)]) -> impl Fn(&str, &str) -> Result<String, String> {
    move |ns, key| {
        pairs
            .iter()
            .find(|(n, k, _)| *n == ns && *k == key)
            .map(|(_, _, v)| (*v).to_string())
            .ok_or_else(|| format!("시크릿 없음: {ns}/{key}"))
    }
}

// (a) GET — 상태/바디 캡처 + 서버가 method/path 수신.
#[test]
fn get_captures_status_and_body() {
    let (port, rx) = spawn_once_server(OK_RESP);
    let url = format!("http://127.0.0.1:{port}/path");
    let resp = send_http("GET", &url, &HashMap::new(), &HashMap::new(), None, None).unwrap();
    assert_eq!(resp.status, 200);
    assert!(resp.body.contains("hello"));
    let received = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(received.starts_with("GET /path"));
}

// (b) POST — 헤더·바디·content-type 전송.
#[test]
fn post_sends_header_body_contenttype() {
    let (port, rx) = spawn_once_server(OK_RESP);
    let url = format!("http://127.0.0.1:{port}/x");
    let mut headers = HashMap::new();
    headers.insert("x-test".to_string(), "abc".to_string());
    let resp = send_http(
        "POST",
        &url,
        &headers,
        &HashMap::new(),
        Some("payload-123"),
        Some("application/json"),
    )
    .unwrap();
    assert_eq!(resp.status, 200);
    let received = rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .to_lowercase();
    assert!(received.starts_with("post /x"));
    assert!(received.contains("x-test: abc"));
    assert!(received.contains("payload-123"));
    assert!(received.contains("content-type: application/json"));
}

// 자격증명이 실린 요청은 redirect 판단을 원격에 넘기지 않는다 — 그렇지 않으면 descriptor 검증이
// 끝난 뒤에 HTTPS 레지스트리가 Authorization 을 강등되거나 남의 URL 로 흘려보낼 수 있다.
#[test]
fn authorization_request_does_not_follow_redirects() {
    let (target_port, target_rx) = spawn_once_server(OK_RESP);
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/leak\r\nContent-Length: 0\r\n\r\n"
    );
    let (source_port, _source_rx) = spawn_once_server(redirect);
    let mut headers = HashMap::new();
    headers.insert(
        "Authorization".to_string(),
        "Bearer registry-secret".to_string(),
    );

    let response = send_http(
        "GET",
        &format!("http://127.0.0.1:{source_port}/index.json"),
        &headers,
        &HashMap::new(),
        None,
        None,
    )
    .unwrap();

    assert_eq!(response.status, 302);
    assert!(
        target_rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "authorization request must not reach redirect target"
    );
}

// (c) 시크릿 치환 — placeholder 가 실값으로 바뀌어 헤더로 나간다(평문은 이 경계 밖에 안 남는다).
#[test]
fn secret_substituted_into_header_at_boundary() {
    let resolve = resolver_with(&[("plugin-a", "apiKey", "sk-secret-xyz")]);
    let (port, rx) = spawn_once_server(OK_RESP);
    let mut headers = HashMap::new();
    headers.insert(
        "authorization".to_string(),
        "Bearer \0secret:apiKey\0".to_string(),
    );
    let mut subst_map = HashMap::new();
    subst_map.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());

    let resp = request(
        &resolve,
        HttpRequest {
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/y"),
            headers,
            ns: Some("plugin-a".into()),
            secret_subst: Some(subst_map),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(resp.status, 200);
    let received = rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .to_lowercase();
    assert!(
        received.contains("authorization: bearer sk-secret-xyz"),
        "실값이 헤더로 전송됨(경계 주입)"
    );
}

// (d) 미가용 시크릿 → 전송 전 Err. 서버가 요청을 **한 건도** 못 받아야 미해소 placeholder 가
//     밖으로 안 나갔다는 증거가 된다.
#[test]
fn missing_secret_rejected_before_send() {
    let resolve = resolver_with(&[]);
    let (port, rx) = spawn_once_server(OK_RESP);
    let mut subst_map = HashMap::new();
    subst_map.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());

    let r = request(
        &resolve,
        HttpRequest {
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/y"),
            ns: Some("plugin-a".into()),
            secret_subst: Some(subst_map),
            ..Default::default()
        },
    );
    assert!(r.is_err(), "해소 실패 → Err");
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "전송이 아예 일어나지 않았다"
    );
}

// (e) secret_subst 있는데 ns 없음 → Err.
#[test]
fn secret_subst_without_ns_rejected() {
    let resolve = resolver_with(&[]);
    let mut subst_map = HashMap::new();
    subst_map.insert("\0secret:k\0".to_string(), "k".to_string());
    assert!(resolve_secret_subst(&resolve, None, &Some(subst_map)).is_err());
}

// (f) 자격증명 + 위장은 닫아 실패한다 — 위장 공유 client 는 redirect 를 못 끄기 때문이다.
//     전송이 일어나지 않았다는 것까지 봐야 "약화 없이 거절"의 증거가 된다.
#[test]
fn authorization_with_impersonation_fails_closed() {
    let resolve = resolver_with(&[]);
    let (port, rx) = spawn_once_server(OK_RESP);
    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), "Bearer x".to_string());

    let r = request(
        &resolve,
        HttpRequest {
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/z"),
            headers,
            impersonate: Some("chrome".into()),
            ..Default::default()
        },
    );
    assert!(r.is_err(), "Authorization+chrome 은 거절");
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "거절이면 전송도 없다"
    );
}

// (g) impersonate 백엔드 선택 — off 와 chrome 이 실제로 다른 JA3 를 낸다(네트워크, 기본 제외).
#[test]
#[ignore = "network: cargo test -p soksak-net -- --ignored impersonate_off_vs_chrome_changes_ja3"]
fn impersonate_off_vs_chrome_changes_ja3() {
    fn ja3(body: &str) -> String {
        serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["tls"]["ja3_hash"].as_str().map(str::to_string))
            .unwrap_or_default()
    }
    let peet = "https://tls.peet.ws/api/all";
    let h = HashMap::new();
    let q = HashMap::new();
    let off = send_http("GET", peet, &h, &q, None, None).unwrap();
    let chrome = send_http_impersonated("GET", peet, &h, &q, None, None).unwrap();
    assert_eq!(off.status, 200);
    assert_eq!(chrome.status, 200);
    let n = ja3(&off.body);
    let w = ja3(&chrome.body);
    assert!(!n.is_empty(), "off JA3 비어있음");
    assert!(!w.is_empty(), "chrome JA3 비어있음");
    assert_ne!(n, w, "impersonate 가 JA3 를 안 바꿈(off={n}, chrome={w})");
}
