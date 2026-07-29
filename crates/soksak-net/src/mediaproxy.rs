// 범용 미디어 스트리밍 프록시 — 루프백 HTTP 서버(127.0.0.1, OS 할당 포트). webview 의 hls.js/<video>
// 는 forbidden header(Referer)를 못 박고 cross-origin CORS 에 막혀서 hotlink 보호 미디어(HLS m3u8 +
// 바이너리 .ts/fMP4 세그먼트, Range 가 걸린 mp4)를 직접 못 받는다. 이 프록시가 호출자가 준 헤더로
// 업스트림에서 바이트를 받아 CORS-안전(ACAO:*)하게 다시 내보낸다.
//
// 특정 사이트 지식 0: url + referer/ua 만 받는다. 어떤 사이트를 프록시할지는 호출자(플러그인)가
// 정한다. 경로 토큰으로 로컬 타 프로세스 접근을 막는다(127.0.0.1 바인드가 1차 방어, 토큰이 2차).
//
// ── 기동한 쪽이 손잡이를 든다 ────────────────────────────────────────────────
// 포트와 토큰은 전역에 두지 않는다. 그 둘은 자원이 아니라 **답**이다 — OS 가 할당한 포트와
// 기동 때 뽑은 난수라 규칙으로 되짚을 수 없고, 전역 한 칸에 넣으면 그 칸이 프로세스 전체를
// 대표하게 된다. 그러면 두 번째 기동이 조용히 무시되고(첫 번째의 포트가 답으로 나간다) 검사도
// 자기 프록시를 못 세운다. 대신 `start()` 가 `MediaProxy` 를 돌려주고, 그것을 든 쪽이 답한다.
//
// 종료 시 정리할 것은 없다 — 루프백 TCP 는 프로세스 종료 시 OS 가 회수한다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

use rand::Rng;

use crate::transport;

const CORS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: range, content-type\r\n\
Access-Control-Expose-Headers: content-length, content-range, accept-ranges, content-type\r\n";

// 도는 프록시 한 벌의 손잡이. 이것을 든 쪽만 그 프록시의 주소를 답할 수 있다.
#[derive(Debug, Clone)]
pub struct MediaProxy {
    port: u16,
    token: String,
}

impl MediaProxy {
    // 루프백 서버 기동. OS 할당 포트 + 세션 랜덤 토큰. 실패는 호출측이 로깅한다(재생만 실패, 앱은 산다).
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = gen_token();
        let serving = token.clone();
        std::thread::spawn(move || serve(listener, port, serving));
        Ok(Self { port, token })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    // 호출자는 이 base 로 프록시 URL 을 조립한다: {base}/m3u8?url=&referer=&ua= / {base}/stream?...
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }
}

fn gen_token() -> String {
    let mut r = rand::thread_rng();
    (0..32)
        .map(|_| char::from_digit(r.gen_range(0..16), 16).unwrap())
        .collect()
}

fn serve(listener: TcpListener, port: u16, token: String) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, port, &token);
        });
    }
}

fn handle_conn(stream: TcpStream, port: u16, token: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();

    let mut range: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }

    if method.eq_ignore_ascii_case("OPTIONS") {
        return write_preflight(&mut writer);
    }
    let head = method.eq_ignore_ascii_case("HEAD");

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target.as_str(), ""),
    };

    let prefix = format!("/{token}/");
    if !path.starts_with(&prefix) {
        return write_simple(&mut writer, 404, "not found");
    }
    let kind = &path[prefix.len()..];

    let params = parse_query(query);
    let url = match params.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return write_simple(&mut writer, 400, "missing url"),
    };
    let referer = params.get("referer").map(|s| s.as_str());
    let ua = params.get("ua").map(|s| s.as_str());

    match kind {
        "m3u8" => serve_m3u8(&mut writer, &url, referer, ua, port, token, head),
        "stream" => serve_stream(&mut writer, &url, referer, range.as_deref(), head),
        _ => write_simple(&mut writer, 404, "not found"),
    }
}

enum WreqStreamErr {
    SendFailed,
    Io(std::io::Error),
}

fn wreq_stream_to(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
    head: bool,
) -> Result<(), WreqStreamErr> {
    let rt = transport::rt().ok_or(WreqStreamErr::SendFailed)?;
    let client = transport::impersonating_client().ok_or(WreqStreamErr::SendFailed)?;
    rt.block_on(async {
        let mut rb = client.get(url);
        if let Some(r) = referer {
            rb = rb.header("referer", r);
            if let Some(o) = transport::origin_of(r) {
                rb = rb.header("origin", o);
            }
        }
        if let Some(rg) = range {
            rb = rb.header("range", rg);
        }
        let resp = rb.send().await.map_err(|_| WreqStreamErr::SendFailed)?;
        let status = resp.status().as_u16();
        let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
        for h in [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
        ] {
            if let Some(v) = resp.headers().get(h).and_then(|v| v.to_str().ok()) {
                out.push_str(&format!("{h}: {v}\r\n"));
            }
        }
        out.push_str(CORS);
        out.push_str("Connection: close\r\n\r\n");
        writer.write_all(out.as_bytes()).map_err(WreqStreamErr::Io)?;
        if !head {
            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| WreqStreamErr::Io(std::io::Error::other(e)))?;
                writer.write_all(&chunk).map_err(WreqStreamErr::Io)?;
            }
        }
        writer.flush().map_err(WreqStreamErr::Io)
    })
}

fn serve_stream(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
    head: bool,
) -> std::io::Result<()> {
    match wreq_stream_to(writer, url, referer, range, head) {
        Ok(()) => Ok(()),
        Err(WreqStreamErr::Io(e)) => Err(e),
        Err(WreqStreamErr::SendFailed) => write_simple(writer, 502, "upstream 연결 실패"),
    }
}

fn serve_m3u8(
    writer: &mut TcpStream,
    url: &str,
    referer: Option<&str>,
    ua: Option<&str>,
    port: u16,
    token: &str,
    head: bool,
) -> std::io::Result<()> {
    let body = match transport::impersonated_fetch(url, referer, None) {
        Ok((st, _, b)) if (200..300).contains(&st) => String::from_utf8_lossy(&b).into_owned(),
        Ok((st, _, _)) => return write_simple(writer, st, "upstream m3u8"),
        Err(_) => return write_simple(writer, 502, "upstream m3u8 연결 실패"),
    };
    let proxy_base = format!("http://127.0.0.1:{port}/{token}");
    let rewritten = rewrite_m3u8(&body, url, &proxy_base, referer, ua);

    let mut out = String::from("HTTP/1.1 200 OK\r\n");
    out.push_str("Content-Type: application/vnd.apple.mpegurl\r\n");
    out.push_str(&format!("Content-Length: {}\r\n", rewritten.len()));
    out.push_str(CORS);
    out.push_str("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
    writer.write_all(out.as_bytes())?;
    if !head {
        writer.write_all(rewritten.as_bytes())?;
    }
    writer.flush()
}

pub fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(q.as_bytes())
        .into_owned()
        .collect()
}

fn split_base(playlist_url: &str) -> (String, String) {
    let no_q = playlist_url.split('?').next().unwrap_or(playlist_url);
    let dir = match no_q.rfind('/') {
        Some(i) => &no_q[..i],
        None => no_q,
    };
    let origin = transport::origin_of(playlist_url).unwrap_or_default();
    (origin, dir.to_string())
}

fn join_url(origin: &str, dir: &str, line: &str) -> String {
    if line.starts_with("http://") || line.starts_with("https://") {
        line.to_string()
    } else if let Some(rest) = line.strip_prefix("//") {
        let scheme = origin.split(':').next().unwrap_or("https");
        format!("{scheme}://{rest}")
    } else if line.starts_with('/') {
        format!("{origin}{line}")
    } else {
        format!("{dir}/{line}")
    }
}

fn build_proxied(
    proxy_base: &str,
    kind: &str,
    abs: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let mut s = format!("{proxy_base}/{kind}?url={}", enc(abs));
    if let Some(r) = referer {
        s.push_str(&format!("&referer={}", enc(r)));
    }
    if let Some(u) = ua {
        s.push_str(&format!("&ua={}", enc(u)));
    }
    s
}

fn rewrite_uri_attr(
    line: &str,
    origin: &str,
    dir: &str,
    proxy_base: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> Option<String> {
    let needle = "URI=\"";
    let start = line.find(needle)?;
    let vstart = start + needle.len();
    let vend = line[vstart..].find('"')? + vstart;
    let abs = join_url(origin, dir, &line[vstart..vend]);
    let kind = if abs.split('?').next().unwrap_or("").ends_with(".m3u8") {
        "m3u8"
    } else {
        "stream"
    };
    let proxied = build_proxied(proxy_base, kind, &abs, referer, ua);
    Some(format!("{}{}{}", &line[..vstart], proxied, &line[vend..]))
}

pub fn rewrite_m3u8(
    playlist: &str,
    playlist_url: &str,
    proxy_base: &str,
    referer: Option<&str>,
    ua: Option<&str>,
) -> String {
    let (origin, dir) = split_base(playlist_url);
    let mut out = String::with_capacity(playlist.len() * 2);
    for raw in playlist.lines() {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            match rewrite_uri_attr(line, &origin, &dir, proxy_base, referer, ua) {
                Some(r) => out.push_str(&r),
                None => out.push_str(line),
            }
            out.push('\n');
            continue;
        }
        let abs = join_url(&origin, &dir, line);
        let kind = if abs.split('?').next().unwrap_or("").ends_with(".m3u8") {
            "m3u8"
        } else {
            "stream"
        };
        out.push_str(&build_proxied(proxy_base, kind, &abs, referer, ua));
        out.push('\n');
    }
    out
}

fn reason(s: u16) -> &'static str {
    match s {
        200 => "OK",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn write_preflight(w: &mut TcpStream) -> std::io::Result<()> {
    let mut out = String::from("HTTP/1.1 204 No Content\r\n");
    out.push_str(CORS);
    out.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
    w.write_all(out.as_bytes())?;
    w.flush()
}

fn write_simple(w: &mut TcpStream, status: u16, msg: &str) -> std::io::Result<()> {
    let body = msg.as_bytes();
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    out.push_str(CORS);
    out.push_str("Connection: close\r\n\r\n");
    w.write_all(out.as_bytes())?;
    w.write_all(body)?;
    w.flush()
}

#[cfg(test)]
#[path = "mediaproxy_tests.rs"]
mod tests;
