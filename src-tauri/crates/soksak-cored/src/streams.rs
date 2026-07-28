//! 스트림 밀어내기 — 답 하나로 끝나지 않는 명령의 프레임이 나가는 자리.
//!
//! 규칙(토큰을 찾고 프레임을 만드는 일)은 코어가 소유한다(`soksak_core::stream`). 여기 있는
//! 것은 **어느 연결로 미는가**뿐이다.
//!
//! 프레임은 **부른 연결**로 나간다. 다른 연결로 보내면 그 토큰을 만든 쪽이 아니라 남이 받고,
//! 받은 쪽은 자기가 만들지 않은 토큰이라 버린다 — 그 유실은 오류가 아니라 침묵이다.
//!
//! 연결이 끊기면 그 토큰들도 끝난다. 남겨 두면 죽은 소켓에 계속 쓰고, 그 실패는 명령마다
//! 다른 자리에서 다르게 나타난다.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use soksak_core::stream;

/// 토큰 → 그 토큰을 만든 연결.
static SINKS: OnceLock<Mutex<HashMap<String, UnixStream>>> = OnceLock::new();

fn sinks() -> &'static Mutex<HashMap<String, UnixStream>> {
    SINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 이 요청이 실어 보낸 토큰들을 이 연결에 매어 둔다. 매어 둔 토큰 이름들을 돌려준다.
pub fn bind(params: &Value, conn: &UnixStream) -> Vec<String> {
    let found = stream::tokens(params);
    if found.is_empty() {
        return Vec::new();
    }
    let mut g = sinks().lock().unwrap_or_else(|e| e.into_inner());
    let mut bound = Vec::new();
    for (_arg, token) in found {
        // 연결 사본을 못 뜨면 매어 두지 않는다 — 매어 두고 못 미는 것이 가장 조용한 실패다.
        match conn.try_clone() {
            Ok(c) => {
                g.insert(token.clone(), c);
                bound.push(token);
            }
            Err(_) => continue,
        }
    }
    bound
}

/// 프레임 하나를 그 토큰의 연결로 민다. 반환 = 닿았는가.
///
/// 짝 없는 토큰은 거짓이다 — 이미 끝난 스트림에 미는 것은 오류가 아니지만, 참으로 올리면
/// 부른 쪽이 "보냈다"고 믿는다.
pub fn push(token: &str, msg: Value) -> bool {
    let mut g = sinks().lock().unwrap_or_else(|e| e.into_inner());
    let Some(sink) = g.get_mut(token) else {
        return false;
    };
    let line = stream::frame(token, msg);
    if writeln!(sink, "{line}").is_err() {
        // 못 쓰는 연결은 끝난 연결이다. 남겨 두면 매 프레임마다 같은 실패를 반복한다.
        g.remove(token);
        return false;
    }
    true
}

/// 이 스트림은 끝났다.
pub fn release(token: &str) -> bool {
    sinks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(token)
        .is_some()
}

/// 지금 살아 있는 토큰 수 — 새는지 보는 자리.
pub fn live() -> usize {
    sinks().lock().unwrap_or_else(|e| e.into_inner()).len()
}

/// 이 토큰들을 놓는다. 연결이 끝나면 그 연결이 만든 토큰도 끝난다.
pub fn release_all(tokens: &[String]) {
    let mut g = sinks().lock().unwrap_or_else(|e| e.into_inner());
    for t in tokens {
        g.remove(t);
    }
}

#[cfg(test)]
#[path = "streams_tests.rs"]
mod tests;
