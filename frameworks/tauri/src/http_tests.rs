// 배선 검사 — 규칙(soksak-net)이 **이 프로세스의 볼트**를 실제로 지나는가.
//
// 치환·거절 규칙 자체는 soksak-net 이 자기 검사로 지킨다. 여기서 볼 것은 하나뿐이다: 명령이
// 받은 열린 볼트가 해소 함수로 묶여 규칙에 닿는가. 이 한 걸음이 어긋나면 규칙은 멀쩡한데
// 실값이 안 실려 나가고, 그 실패는 "이 프로세스에서만 401" 로 나타난다.

use super::*;
use soksak_net::http::HttpRequest;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

fn spawn_once_server(response: &str) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    let response = response.to_string();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, rx)
}

const OK_RESP: &str =
    "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: application/json\r\n\r\n{\"v\":\"hello\"}";

#[test]
fn open_vault_reaches_the_rule_and_the_real_value_goes_out() {
    let dir = std::env::temp_dir().join(format!(
        "soksak-http-secret-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let state = secrets::test_state_with_secret(
        dir.join("secrets.vault"),
        "pw",
        "plugin-a",
        "apiKey",
        "sk-secret-xyz",
    );

    let (port, rx) = spawn_once_server(OK_RESP);
    let mut headers = HashMap::new();
    headers.insert(
        "authorization".to_string(),
        "Bearer \0secret:apiKey\0".to_string(),
    );
    let mut subst = HashMap::new();
    subst.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());

    let resp = request_with(
        &state,
        HttpRequest {
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/y"),
            headers,
            ns: Some("plugin-a".into()),
            secret_subst: Some(subst),
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
        "열린 볼트의 실값이 헤더로 나갔다"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// 잠긴 볼트는 전송 전에 막는다 — 미해소 placeholder 가 나가면 그것은 실패가 아니라 유출이다.
#[test]
fn locked_vault_is_rejected_before_send() {
    let state = SecretsState::default(); // 잠김.
    let (port, rx) = spawn_once_server(OK_RESP);
    let mut subst = HashMap::new();
    subst.insert("\0secret:apiKey\0".to_string(), "apiKey".to_string());

    let r = request_with(
        &state,
        HttpRequest {
            method: "GET".into(),
            url: format!("http://127.0.0.1:{port}/y"),
            ns: Some("plugin-a".into()),
            secret_subst: Some(subst),
            ..Default::default()
        },
    );
    assert!(r.is_err(), "잠김 볼트 → Err");
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "전송이 아예 일어나지 않았다"
    );
}
