// 한 연결에 쓰는 자리는 하나다.
//
// RED 근거(실측 2026-07-28, 살아있는 앱 로그): 프레임워크가 "파싱 못 한 응답 줄"을 쏟아냈고,
// 그 줄들은 두 JSON 이 **글자 단위로 뒤섞인** 것이었다:
//
//   {{""streamdata":{"":{"kindmsg"":"boot.step",...
//
// 응답은 연결의 뮤텍스를 잡고 쓰지만, 스트림 프레임은 `dup()` 로 뜬 **다른 fd** 로 나갔다.
// fd 는 둘이어도 소켓은 하나다 — 두 쓰기가 서로의 중간에 끼어들면 받는 쪽에는 한 줄이
// 두 줄로도, 두 줄이 한 줄로도 보이지 않는다. 그냥 깨진 줄이 된다.
//
// 그 유실은 오류로 보고되지 않는다: 보낸 쪽은 성공했고, 받는 쪽은 "이상한 줄"을 로그에
// 한 줄 남기고 버린다. 그 버려진 것이 어떤 명령의 회신이었는지는 아무 데도 남지 않는다.
//
// 이 검사는 부하로 재현한다 — 경합은 한 번으로 안 나오지만, 두 경로가 각자의 fd 로 쓰는 한
// 반복이면 반드시 난다. 통과 기준은 "받은 모든 줄이 JSON 이다" 하나다.

#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixStream;
use std::sync::Arc;

use serde_json::{json, Value};
use soksak_cored::{streams, wire::Conn};

/// 한 줄을 길게 만든다 — 짧은 줄은 한 번의 write 로 나가 경합이 드러나지 않는다.
fn long_text(tag: &str, i: usize) -> String {
    format!("{tag}-{i}-{}", "x".repeat(4096))
}

#[test]
fn replies_and_stream_frames_never_interleave() {
    let (a, b) = UnixStream::pair().expect("소켓 짝");
    let conn = Arc::new(Conn::new(a));

    // 이 요청이 스트림 토큰을 하나 실어 보냈다 — 실제 경로와 같게 연결에 매어 둔다.
    let token = "t-interleave";
    let params = json!({ "sink": { "__frameworkStream": token } });
    let bound = streams::bind(&params, &conn);
    assert_eq!(bound, vec![token.to_string()], "토큰이 이 연결에 매여야 한다");

    const ROUNDS: usize = 200;

    // 읽는 쪽을 **먼저** 돌린다. 소켓 버퍼는 유한해서, 다 쓰고 나서 읽으면 쓰는 쪽이 버퍼가
    // 찬 자리에서 멈춘다 — 그 멈춤은 결함이 아니라 이 검사의 설계 실수다.
    let reader = std::thread::spawn(move || {
        let mut lines = 0usize;
        let mut broken = Vec::new();
        for line in BufReader::new(b).lines() {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            lines += 1;
            if serde_json::from_str::<Value>(&line).is_err() {
                // 깨진 줄의 앞머리만 남긴다 — 4KB 를 통째로 실으면 실패 메시지를 못 읽는다.
                broken.push(line.chars().take(120).collect::<String>());
            }
        }
        (lines, broken)
    });

    let writer = {
        let conn = Arc::clone(&conn);
        std::thread::spawn(move || {
            for i in 0..ROUNDS {
                conn.reply(&json!({ "id": i, "ok": true, "data": long_text("reply", i) }));
            }
        })
    };
    let pusher = std::thread::spawn(move || {
        for i in 0..ROUNDS {
            streams::push(token, json!({ "b64": long_text("frame", i) }));
        }
    });

    writer.join().expect("응답 스레드");
    pusher.join().expect("스트림 스레드");
    streams::release(token);
    drop(conn); // 쓰는 쪽을 닫아야 읽는 쪽이 EOF 를 본다

    let (lines, broken) = reader.join().expect("읽기 스레드");

    // 오라클 생존 — 한 줄도 안 왔으면 이 검사는 아무것도 지키지 않으면서 통과한다.
    assert_eq!(lines, ROUNDS * 2, "보낸 만큼 도착해야 한다");
    assert!(
        broken.is_empty(),
        "깨진 줄 {}개 — 한 연결에 쓰는 자리가 둘이다:\n{}",
        broken.len(),
        broken.join("\n")
    );
}
