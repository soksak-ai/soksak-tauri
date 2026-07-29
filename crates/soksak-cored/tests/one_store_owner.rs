// 한 홈에 저장소 주인은 **하나**다 — 둘째는 거절이 아니라 위임이다.
//
// 이것이 두 프레임워크를 동시에 켜는 조건이다. 둘이 각자 DB 를 열면 쓰기자가 둘이 되고,
// SQLite 는 막지 않고 직렬화만 한다 — `store_lock` 이 시끄럽게 만들려던 그 조용한 경우다.
//
// 여기서 재는 것: 먼저 선 쪽이 주인이고, 나중 온 쪽은 **살아서 읽는다.** 둘째가 죽거나
// 오류를 내면 "동시에 켠다"가 성립하지 않는다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

struct Proc(Child, PathBuf);

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        let _ = std::fs::remove_file(&self.1);
    }
}

fn home(name: &str) -> PathBuf {
    let d = PathBuf::from(std::env::var("HOME").expect("HOME"))
        .join(".soksak-e2e/one-owner")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("data")).expect("픽스처 홈");
    d
}

/// 한 홈에 cored 를 하나 세운다. 소켓 이름만 다르게 준다 — 홈은 **같다**(그것이 요점이다).
fn stand_up(h: &Path, sock: &str) -> Proc {
    let socket = h.join(sock);
    let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
        .args(["--socket".as_ref(), socket.as_os_str()])
        .args(["--home".as_ref(), h.as_os_str()])
        .args(["--identifier", "com.soksak.dev"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("cored 스폰");
    let out = child.stdout.take().expect("stdout");
    let mut line = String::new();
    let ready = BufReader::new(out).read_line(&mut line).is_ok() && !line.trim().is_empty();
    let p = Proc(child, socket);
    assert!(ready, "cored 가 준비를 알리지 않았다");
    p
}

fn ask(socket: &Path, req: Value) -> Value {
    let conn = UnixStream::connect(socket).expect("소켓 연결");
    conn.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut w = conn.try_clone().unwrap();
    writeln!(w, "{req}").expect("요청");
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).expect("응답");
    serde_json::from_str(line.trim()).expect("한 줄 JSON")
}

/// 같은 홈에 둘이 서고, **둘 다 산다.** 둘째는 읽고, 쓰기는 주인이 한다.
#[test]
fn a_second_process_on_the_same_home_lives_and_reads() {
    let h = home("two");
    let first = stand_up(&h, "a.sock");
    let second = stand_up(&h, "b.sock");

    // 둘째가 살아 있다 — 죽거나 부팅을 거부하면 "동시에 켠다"가 성립하지 않는다.
    let hello = ask(&second.1, json!({ "id": 1, "method": "cored.commands" }));
    assert_eq!(hello["ok"], true, "둘째가 답하지 않는다: {hello}");

    // 주인이 쓴다.
    let w = ask(
        &first.1,
        json!({ "id": 2, "method": "data_kv_set", "params": { "ns": "t", "key": "k", "value": 7 } }),
    );
    assert_eq!(w["ok"], true, "주인이 쓰지 못했다: {w}");

    // 둘째가 그것을 **읽는다** — 같은 저장소를 보고 있다는 증거다.
    let r = ask(
        &second.1,
        json!({ "id": 3, "method": "data_kv_get", "params": { "ns": "t", "key": "k" } }),
    );
    assert_eq!(r["ok"], true, "둘째가 읽지 못했다: {r}");
    assert_eq!(r["data"], 7, "둘째가 다른 저장소를 보고 있다: {r}");
}

/// 둘째의 쓰기는 **이름을 달고 거절된다** — 조용히 성공하면 그것이 이중 쓰기다.
#[test]
fn the_second_process_refuses_to_write_by_name() {
    let h = home("write");
    let _owner = stand_up(&h, "a.sock");
    let second = stand_up(&h, "b.sock");

    let w = ask(
        &second.1,
        json!({ "id": 4, "method": "data_kv_set", "params": { "ns": "t", "key": "k", "value": 1 } }),
    );
    assert_eq!(w["ok"], false, "둘째가 조용히 썼다 — 이것이 이중 쓰기다: {w}");
    let msg = w["message"].as_str().unwrap_or_default();
    assert!(
        msg.contains("소유") || w["code"] == "COMMAND_FAILED",
        "거절 사유가 소유권을 말하지 않는다: {w}"
    );
}
