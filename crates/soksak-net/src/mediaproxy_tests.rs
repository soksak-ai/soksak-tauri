// 프록시 검사 — 업스트림은 이 프로세스 안에 세운다(외부망 비의존).

use super::*;
use std::io::Read;
use std::time::Duration;

const PROXY: &str = "http://127.0.0.1:9/t";

// 두 번 세우면 둘이 각자의 포트와 토큰을 갖는다.
//
// 전역 한 칸이 프로세스를 대표하던 동안 두 번째 기동은 조용히 무시됐고(첫 번째의 포트가 답으로
// 나갔다), 그래서 검사는 자기 프록시를 세울 수 없었다. 손잡이를 돌려주는 지금은 세운 쪽이 답한다.
#[test]
fn starting_twice_yields_independent_proxies() {
    let first = MediaProxy::start().unwrap();
    let second = MediaProxy::start().unwrap();
    assert_ne!(first.port(), second.port(), "두 프록시가 같은 포트를 답한다");
    assert_ne!(first.token(), second.token(), "두 프록시가 같은 토큰을 답한다");
    assert!(first.base().starts_with(&format!("http://127.0.0.1:{}/", first.port())));
    assert!(first.base().ends_with(first.token()));
}

#[test]
fn rewrite_relative_and_absolute_segments() {
    let pl = "#EXTM3U\n#EXTINF:5,\nseg0.ts\n#EXTINF:5,\nhttps://cdn.other/x/seg1.ts\n";
    let out = rewrite_m3u8(pl, "https://cdn.example/a/b/play.m3u8", PROXY, None, None);
    assert!(out.contains(&format!(
        "{PROXY}/stream?url={}",
        enc("https://cdn.example/a/b/seg0.ts")
    )));
    assert!(out.contains(&format!(
        "{PROXY}/stream?url={}",
        enc("https://cdn.other/x/seg1.ts")
    )));
    assert!(out.contains("#EXTINF:5,"));
    assert!(out.starts_with("#EXTM3U"));
}

#[test]
fn rewrite_root_relative_segment() {
    let pl = "#EXTM3U\n/v/seg.ts\n";
    let out = rewrite_m3u8(pl, "https://cdn.example/a/b/play.m3u8", PROXY, None, None);
    assert!(out.contains(&enc("https://cdn.example/v/seg.ts")));
}

#[test]
fn rewrite_nested_variant_goes_to_m3u8_route() {
    let pl = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub/var.m3u8\n";
    let out = rewrite_m3u8(pl, "https://cdn.example/a/play.m3u8", PROXY, None, None);
    assert!(out.contains(&format!(
        "{PROXY}/m3u8?url={}",
        enc("https://cdn.example/a/sub/var.m3u8")
    )));
}

#[test]
fn rewrite_key_uri_attribute() {
    let pl =
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://cdn.example/k/key.bin\",IV=0x1\nseg.ts\n";
    let out = rewrite_m3u8(pl, "https://cdn.example/a/play.m3u8", PROXY, None, None);
    assert!(out.contains(&format!(
        "URI=\"{PROXY}/stream?url={}",
        enc("https://cdn.example/k/key.bin")
    )));
    assert!(out.contains("METHOD=AES-128"));
    assert!(out.contains("IV=0x1"));
}

#[test]
fn rewrite_media_audio_uri_routes_to_m3u8() {
    // 대체 오디오 렌디션은 별도 .m3u8 — /m3u8(재귀)로 가야 내부 세그먼트도 리라이트된다.
    let pl = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/eng.m3u8\"\n";
    let out = rewrite_m3u8(pl, "https://cdn.example/a/master.m3u8", PROXY, None, None);
    assert!(out.contains(&format!(
        "URI=\"{PROXY}/m3u8?url={}",
        enc("https://cdn.example/a/audio/eng.m3u8")
    )));
}

#[test]
fn rewrite_carries_referer_and_ua() {
    let pl = "#EXTM3U\nseg.ts\n";
    let out = rewrite_m3u8(
        pl,
        "https://cdn.example/play.m3u8",
        PROXY,
        Some("https://ref.example/page"),
        Some("UA/1"),
    );
    assert!(out.contains(&format!("&referer={}", enc("https://ref.example/page"))));
    assert!(out.contains(&format!("&ua={}", enc("UA/1"))));
}

// ── 프론트와 Rust 가 각자 조립하는 프록시 URL 의 인코딩이 갈리지 않는가 ──────────
//
// 조립이 두 벌이다: `src/commands/catalogMedia.ts` 는 `encodeURIComponent`, 여기는
// `form_urlencoded::byte_serialize`. 디코더는 `form_urlencoded::parse` 하나뿐이라, 둘 중
// 한쪽만 그 디코더와 어긋나면 그 문자가 든 미디어만 조용히 안 열린다 — `+` 와 공백이
// 그 자리다(`parse` 는 `+` 를 공백으로 읽는다).
//
// 아래 문자열은 node 로 실측한 `encodeURIComponent` 의 출력을 그대로 박은 것이다. 프론트
// 조립이 바뀌면 이 값이 실물과 갈리고, 그때 이 검사가 아니라 재생이 먼저 깨지지 않게 한다.
#[test]
fn both_url_encoders_survive_the_one_decoder() {
    for (raw, from_js) in [
        ("https://cdn.x/a+b.ts", "https%3A%2F%2Fcdn.x%2Fa%2Bb.ts"),
        ("https://cdn.x/a b.ts", "https%3A%2F%2Fcdn.x%2Fa%20b.ts"),
        (
            "https://cdn.x/q?x=1&y=2",
            "https%3A%2F%2Fcdn.x%2Fq%3Fx%3D1%26y%3D2",
        ),
    ] {
        let from_rust = enc(raw);
        assert_eq!(
            parse_query(&format!("url={from_rust}")).get("url"),
            Some(&raw.to_string()),
            "Rust 조립이 자기 디코더로 안 돌아온다: {raw}"
        );
        assert_eq!(
            parse_query(&format!("url={from_js}")).get("url"),
            Some(&raw.to_string()),
            "프론트 조립(encodeURIComponent)이 같은 디코더로 안 돌아온다: {raw}"
        );
    }
}

// ── 통합: 로컬 upstream → 프록시 → 클라이언트. Range 중계 + CORS + 토큰 ────────

// Range 를 이해하는 최소 upstream(루프, 연결마다 1응답). 바디 "0123456789A"(11바이트).
fn spawn_upstream() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            let resp = if req.contains("range:") {
                // bytes=0-3 만 처리(테스트 충분).
                "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp2t\r\nContent-Range: bytes 0-3/11\r\nAccept-Ranges: bytes\r\nContent-Length: 4\r\nConnection: close\r\n\r\n0123".to_string()
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nAccept-Ranges: bytes\r\nContent-Length: 11\r\nConnection: close\r\n\r\n0123456789A".to_string()
            };
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

fn wait_ready(port: u16) {
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

// 검사용 클라이언트 — 코어와 같은 정직 wreq 로 로컬 프록시(plain HTTP)를 친다.
fn proxy_req(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
) -> (u16, HashMap<String, String>, Vec<u8>) {
    let rt = transport::rt().unwrap();
    let client = transport::honest_client().unwrap();
    let m = wreq::Method::from_bytes(method.as_bytes()).unwrap();
    rt.block_on(async {
        let mut rb = client.request(m, url);
        for (k, v) in headers {
            rb = rb.header(*k, *v);
        }
        let resp = rb.send().await.unwrap();
        let status = resp.status().as_u16();
        let hmap: HashMap<String, String> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body = resp.bytes().await.unwrap().to_vec();
        (status, hmap, body)
    })
}

#[test]
fn stream_relays_range_206_and_cors() {
    let up = spawn_upstream();
    let px = MediaProxy::start().unwrap();
    wait_ready(up);
    wait_ready(px.port());
    let upstream_url = format!("http://127.0.0.1:{up}/seg.ts");
    let proxy_url = format!("{}/stream?url={}", px.base(), enc(&upstream_url));
    let (status, headers, body) = proxy_req("GET", &proxy_url, &[("range", "bytes=0-3")]);
    assert_eq!(status, 206, "206 중계");
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "*",
        "CORS 헤더"
    );
    assert_eq!(
        headers.get("content-range").unwrap(),
        "bytes 0-3/11",
        "Content-Range 중계"
    );
    assert_eq!(String::from_utf8_lossy(&body), "0123", "부분 바디 스트리밍");
}

#[test]
fn stream_full_200_passthrough() {
    let up = spawn_upstream();
    let px = MediaProxy::start().unwrap();
    wait_ready(up);
    wait_ready(px.port());
    let upstream_url = format!("http://127.0.0.1:{up}/seg.ts");
    let proxy_url = format!("{}/stream?url={}", px.base(), enc(&upstream_url));
    let (status, _, body) = proxy_req("GET", &proxy_url, &[]);
    assert_eq!(status, 200);
    assert_eq!(String::from_utf8_lossy(&body), "0123456789A");
}

#[test]
fn wrong_token_404() {
    let px = MediaProxy::start().unwrap();
    wait_ready(px.port());
    let proxy_url = format!(
        "http://127.0.0.1:{}/WRONG/stream?url=http://x/y.ts",
        px.port()
    );
    let (status, _, _) = proxy_req("GET", &proxy_url, &[]);
    assert_eq!(status, 404);
}

#[test]
fn options_preflight_204() {
    let px = MediaProxy::start().unwrap();
    wait_ready(px.port());
    let proxy_url = format!("{}/stream?url=http://x/y.ts", px.base());
    let (status, headers, _) = proxy_req("OPTIONS", &proxy_url, &[]);
    assert_eq!(status, 204);
    assert_eq!(
        headers.get("access-control-allow-methods").unwrap(),
        "GET, HEAD, OPTIONS"
    );
}

#[test]
fn missing_url_400() {
    let px = MediaProxy::start().unwrap();
    wait_ready(px.port());
    let proxy_url = format!("{}/stream", px.base());
    let (status, _, _) = proxy_req("GET", &proxy_url, &[]);
    assert_eq!(status, 400);
}

// 라이브 종단 검증 — 외부 공개 HLS(Apple). 기본 suite 비포함:
// `cargo test -p soksak-net -- --ignored live_apple_hls_through_proxy` 로만.
#[test]
#[ignore = "live: 외부 공개 HLS 의존, --ignored 로만"]
fn live_apple_hls_through_proxy() {
    let px = MediaProxy::start().unwrap();
    wait_ready(px.port());
    let master = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
    let proxied_master = format!("{}/m3u8?url={}", px.base(), enc(master));
    let (_, _, mb) = proxy_req("GET", &proxied_master, &[]);
    let master_body = String::from_utf8_lossy(&mb).into_owned();
    assert!(
        master_body.contains(&format!("/{}/m3u8?url=", px.token())),
        "변형 플레이리스트가 프록시로 리라이트됨"
    );
    let variant = master_body
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("http") && l.contains(&format!("/{}/m3u8?url=", px.token())))
        .expect("변형 .m3u8")
        .to_string();
    let (_, _, mb2) = proxy_req("GET", &variant, &[]);
    let media_body = String::from_utf8_lossy(&mb2).into_owned();
    assert!(
        media_body.contains(&format!("/{}/stream?url=", px.token())),
        "세그먼트가 프록시로 리라이트됨"
    );
    let seg = media_body
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("http") && l.contains(&format!("/{}/stream?url=", px.token())))
        .expect("세그먼트")
        .to_string();
    let (s, _, body) = proxy_req("GET", &seg, &[("range", "bytes=0-1023")]);
    assert!(s == 200 || s == 206, "세그먼트 스트리밍 status={s}");
    assert!(!body.is_empty(), "세그먼트 바이트 수신");
}

// 임퍼소네이션이 실제로 핑거프린트를 바꾸는지 — 중립 TLS 에코(tls.peet.ws)로 정직/위장 JA3 대조.
// 특정 사이트 비의존. 네트워크 — 기본 제외.
#[test]
#[ignore = "network: cargo test -p soksak-net -- --ignored ja3_impersonation_changes_fingerprint"]
fn ja3_impersonation_changes_fingerprint() {
    fn ja3(json: &str) -> String {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|v| v["tls"]["ja3_hash"].as_str().map(str::to_string))
            .unwrap_or_default()
    }
    let peet = "https://tls.peet.ws/api/all";
    let (_, _, nb) = proxy_req("GET", peet, &[]);
    let honest = String::from_utf8_lossy(&nb).into_owned();
    let (_st, _h, body) = transport::impersonated_fetch(peet, None, None).unwrap();
    let imp = String::from_utf8_lossy(&body).into_owned();

    let n = ja3(&honest);
    let w = ja3(&imp);
    assert!(!n.is_empty(), "정직 wreq JA3 비어있음");
    assert!(!w.is_empty(), "위장 wreq JA3 비어있음");
    assert_ne!(n, w, "임퍼소네이션이 JA3 를 안 바꿈(off={n}, imp={w})");
}
