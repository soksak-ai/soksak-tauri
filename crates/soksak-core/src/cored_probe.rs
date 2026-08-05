//! cored 자리의 생존 판정.
//!
//! Unix socket `connect` 성공은 서버 생존이 아니다. listener FD를 상속한 다른 프로세스가
//! 연결만 받고 프로토콜에는 답하지 않을 수 있다. 채택과 싱글턴 판정은 `system.hello`의
//! cored 응답까지 확인한 동일 함수만 사용한다.

use std::path::Path;
use std::time::Duration;

#[cfg(unix)]
pub fn is_cored_served(socket: &Path, timeout: Duration) -> bool {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let Ok(mut stream) = UnixStream::connect(socket) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
        || stream
            .write_all(b"{\"id\":\"cored-probe\",\"method\":\"system.hello\"}\n")
            .is_err()
    {
        return false;
    }
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line).is_err() {
        return false;
    }
    let Ok(reply) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return false;
    };
    reply.get("id").and_then(|value| value.as_str()) == Some("cored-probe")
        && reply.get("ok").and_then(|value| value.as_bool()) == Some(true)
        && reply.get("role").and_then(|value| value.as_str()) == Some("cored")
        && reply
            .get("protocol")
            .and_then(|value| value.as_u64())
            .is_some()
}

#[cfg(not(unix))]
pub fn is_cored_served(_socket: &Path, _timeout: Duration) -> bool {
    false
}
