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
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde_json::Value;
use soksak_core::stream;

use crate::wire::Conn;

/// 토큰 → 그 토큰을 만든 **연결**.
///
/// 연결의 사본 fd 가 아니라 연결 자신이다. 사본으로 쥐면 프레임이 그 연결의 쓰기 자리를
/// 지나지 않아, 같은 소켓에 답과 프레임이 동시에 나가 줄이 섞인다(wire::Conn::write_line).
///
/// 약한 참조다 — 여기서 연결을 붙들면 소켓이 끊겨도 살아 남고, 그 좀비는 프로세스가 죽을
/// 때까지 목록에 남는다.
static SINKS: OnceLock<Mutex<HashMap<String, Weak<Conn>>>> = OnceLock::new();

fn sinks() -> &'static Mutex<HashMap<String, Weak<Conn>>> {
    SINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 이 요청이 실어 보낸 토큰들을 이 연결에 매어 둔다. 매어 둔 토큰 이름들을 돌려준다.
pub fn bind(params: &Value, conn: &Arc<Conn>) -> Vec<String> {
    let found = stream::tokens(params);
    if found.is_empty() {
        return Vec::new();
    }
    let mut g = sinks().lock().unwrap_or_else(|e| e.into_inner());
    let mut bound = Vec::new();
    for (_arg, token) in found {
        g.insert(token.clone(), Arc::downgrade(conn));
        bound.push(token);
    }
    bound
}

/// 프레임 하나를 그 토큰의 연결로 민다. 반환 = 닿았는가.
///
/// 짝 없는 토큰은 거짓이다 — 이미 끝난 스트림에 미는 것은 오류가 아니지만, 참으로 올리면
/// 부른 쪽이 "보냈다"고 믿는다.
pub fn push(token: &str, msg: Value) -> bool {
    let mut g = sinks().lock().unwrap_or_else(|e| e.into_inner());
    let Some(weak) = g.get(token) else {
        return false;
    };
    // 연결이 이미 사라졌으면 끝난 스트림이다 — 짝이 없어진 토큰을 남기면 매 프레임마다 같은
    // 조회를 반복한다.
    let Some(conn) = weak.upgrade() else {
        g.remove(token);
        return false;
    };
    let line = stream::frame(token, msg);
    // 답과 **같은 자리**로 쓴다 — 그래야 한 줄이 통째로 나간다.
    if !conn.write_line(&line.to_string()) {
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
