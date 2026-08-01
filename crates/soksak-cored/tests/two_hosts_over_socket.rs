// 두 프레임워크가 한 cored 에 붙는다 — **실제 소켓 위에서**.
//
// 인프로세스 검사(`control_tests.rs`)가 같은 규칙을 이미 잰다. 그런데 그것은 이 프로세스 안에서
// 함수를 부르는 것이고, 프레임워크가 실제로 지나는 길은 소켓이다. 그 사이에 봉투 조립·연결
// 수명·회신 짝짓기가 있고, 그것들이 인프로세스 검사에는 없다.
//
// 왜 이 파일이 필요한가: "동시 실행 가능"은 주장이고, 그 주장이 서는 자리가 여기다. 저장소를
// 쓰는 주인은 하나여야 하는데(단일 쓰기) 프레임워크는 둘이 동시에 돈다. 그 둘을 세우는 길은
// 하나뿐이다 — **같은 cored 에 창 호스트로 둘 다 붙는다.** 그러면 쓰기 주인은 여전히 하나고
// 창을 가진 쪽만 둘이다. 이 파일이 그 길이 실제로 뚫려 있는지 잰다.
//
// 여기서 재지 않는 것: 어느 프레임워크가 붙느냐. 그것은 각 어댑터의 일이고, 이 계약은 붙는
// 쪽이 누구든 같다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

/// 읽기 상한. 호스트가 둘이면 **한쪽에는 오지 않는 것이 정답**인 검사가 생긴다 — 상한이 없으면
/// 그 정답이 무한 대기로 나타나고, 실패가 아니라 멈춤이 된다.
const READ_LIMIT: Duration = Duration::from_secs(5);

struct Cored {
    child: Child,
    socket: PathBuf,
}

impl Drop for Cored {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

impl Cored {
    /// 스폰한 자식을 **즉시** 감싸고 나서 준비를 기다린다. 그 사이에 패닉이 나면 `Child` 가
    /// 그대로 샌다 — Rust 의 `Child::drop` 은 프로세스를 죽이지 않는다.
    fn start(name: &str) -> Cored {
        let dir = fixture_dir(name);
        let socket = dir.join("h.sock");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).expect("픽스처 홈");
        let mut child = Command::new(env!("CARGO_BIN_EXE_soksak-cored"))
            .args(["--socket".as_ref(), socket.as_os_str()])
            .args(["--home".as_ref(), home.as_os_str()])
            .args(["--identifier", "com.soksak.dev"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("cored 스폰");
        // 준비 완료 = stdout 한 줄. 소켓 파일이 생겼는지 반복해 보는 폴링을 쓰지 않는다 —
        // 파일 존재는 bind 완료가 아니고, 블로킹 read 는 cored 가 먼저 죽으면 EOF 로 드러난다.
        let out = child.stdout.take().expect("stdout");
        let mut line = String::new();
        let ready = BufReader::new(out).read_line(&mut line).is_ok() && !line.trim().is_empty();
        let c = Cored { child, socket };
        assert!(ready, "cored 가 준비를 알리지 않았다");
        c
    }

    /// 밖에서 온 요청 하나 — 프레임워크가 아닌 쪽(하니스·CLI)이 지나는 길이다.
    fn ask(&self, req: Value) -> Value {
        let conn = UnixStream::connect(&self.socket).expect("소켓 연결");
        conn.set_read_timeout(Some(READ_LIMIT)).unwrap();
        let mut w = conn.try_clone().unwrap();
        writeln!(w, "{req}").expect("요청");
        w.flush().unwrap();
        let mut line = String::new();
        BufReader::new(conn).read_line(&mut line).expect("응답");
        serde_json::from_str(line.trim()).expect("한 줄 JSON")
    }
}

/// 테스트 루트는 홈 아래 고정 경로다(재사용·멱등). `CARGO_TARGET_TMPDIR` 을 쓰지 않는 이유:
/// 유닉스 소켓 경로에는 OS 상한이 있어(macOS ~104바이트) 워크트리 아래 target 경로는 그것만으로
/// 상한을 넘는다.
fn fixture_dir(name: &str) -> PathBuf {
    let base = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".soksak-e2e/two-hosts");
    let dir = base.join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("픽스처 디렉터리");
    dir
}

/// 창을 가진 쪽 하나 — 프레임워크가 하는 일을 그대로 한다.
struct Host {
    reader: BufReader<UnixStream>,
    /// 살아 있어야 연결이 유지된다 — 놓으면 cored 가 호스트를 잃는다(그것도 이 파일이 잰다).
    writer: UnixStream,
}

impl Host {
    fn attach(socket: &Path, live: &[&str], focused: &str) -> Host {
        let conn = UnixStream::connect(socket).expect("호스트 연결");
        conn.set_read_timeout(Some(READ_LIMIT)).unwrap();
        let mut writer = conn.try_clone().unwrap();
        let mut reader = BufReader::new(conn);
        writeln!(
            writer,
            "{}",
            json!({"id":"attach","method":"control_host_attach",
                   "params":{"live":live,"focused":focused}})
        )
        .unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).expect("등록 응답");
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["ok"], true, "등록이 서지 않았다: {v}");
        Host { reader, writer }
    }

    /// 이 호스트에 밀려온 한 줄. 안 오면 None — 상한까지 기다린 결과다.
    fn pushed(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(n) if n > 0 => Some(serde_json::from_str(line.trim()).expect("한 줄 JSON")),
            _ => None,
        }
    }

    /// 창이 답했다 — 배달 id 로 짝지어 되돌린다.
    fn reply(&mut self, id: u64, data: Value) {
        writeln!(
            self.writer,
            "{}",
            json!({"id":"r","method":"cmd_result","params":{"id":id,"result":{"ok":true,"data":data}}})
        )
        .unwrap();
    }
}

/// 둘이 붙어도 서로를 밀어내지 않고, 각자의 창으로만 배달된다.
#[test]
fn two_frameworks_attach_and_each_serves_its_own_windows() {
    let cored = Cored::start("routing");
    let mut a = Host::attach(&cored.socket, &["w-a"], "w-a");
    let mut b = Host::attach(&cored.socket, &["w-b"], "w-b");

    // 밖에서 온 요청은 창을 지목한다. 그 창을 가진 쪽만 받아야 한다 — 아무 호스트에나 밀면
    // 남의 프레임워크 창에서 명령이 돌고 성공을 답한다. 그 오답은 오류로 보이지 않는다.
    let socket = cored.socket.clone();
    let caller = std::thread::spawn(move || {
        let conn = UnixStream::connect(&socket).unwrap();
        conn.set_read_timeout(Some(READ_LIMIT)).unwrap();
        let mut w = conn.try_clone().unwrap();
        writeln!(w, "{}", json!({"id":1,"method":"x.y","window":"w-a","timeoutMs":4000})).unwrap();
        let mut line = String::new();
        BufReader::new(conn).read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(line.trim()).unwrap()
    });

    let push = a.pushed().expect("자기 창의 배달을 받는다");
    assert_eq!(push["deliver"]["window"], "w-a");
    let id = push["deliver"]["id"].as_u64().expect("배달 id");
    a.reply(id, json!({ "seen": true }));

    let out = caller.join().unwrap();
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["data"]["seen"], true);

    // 남의 창 배달이 이쪽으로 새면 두 프레임워크가 서로의 명령을 실행한다.
    assert!(b.pushed().is_none(), "둘째 호스트에 남의 배달이 왔다");
}

/// 방송은 주인 없는 사실이다 — 창을 가진 쪽 **전부**가 받아야 한다.
///
/// 하나만 받으면 나머지 프레임워크의 창은 파일이 바뀐 줄 모르고 낡은 화면을 계속 보여 준다.
#[test]
fn a_broadcast_reaches_both_frameworks() {
    let cored = Cored::start("broadcast");
    let mut a = Host::attach(&cored.socket, &["w-a"], "w-a");
    let mut b = Host::attach(&cored.socket, &["w-b"], "w-b");

    // 파일 변경 감시를 세우면 cored 가 그 사실을 창 쪽으로 민다.
    let dir = cored.socket.parent().unwrap().join("watched");
    std::fs::create_dir_all(&dir).unwrap();
    let r = cored.ask(json!({
        "id": 2, "method": "watch_dir", "params": { "path": dir.to_string_lossy() }
    }));
    if r["ok"] != true {
        // 이 프로세스가 감시를 안 서빙하면 이 검사는 잴 것이 없다. 그것을 통과로 위장하지 않는다.
        panic!("watch_dir 가 서지 않아 방송 경로를 잴 수 없다: {r}");
    }
    std::fs::write(dir.join("a.txt"), "x").unwrap();

    for (h, who) in [(&mut a, "첫째"), (&mut b, "둘째")] {
        let v = h.pushed().unwrap_or_else(|| panic!("{who} 호스트가 방송을 못 받았다"));
        assert!(v.get("broadcast").is_some(), "{who}: 방송이 아니다 — {v}");
    }
}

/// 같은 라벨을 둘이 들면 **둘 다에게 간다.**
///
/// 겹침은 우연이 아니라 필연이다: `main` 은 오케스트레이터 역할이라 앱 프로세스마다 하나씩
/// 있고, 워크스페이스 창 복원은 저장된 `w-<uuid>` 를 되쓴다. 홈을 공유하면 두 프레임워크가
/// 같은 라벨을 각자 든다.
///
/// 한때 그때 거절했는데, 그러면 두 앱을 함께 켠 순간 **어느 쪽도 밖에서 못 부른다**(실측
/// 2026-08-01: 저장소 조회조차 막혔다). 고르지 않는다는 판단은 옳고 결론이 틀렸다 — 고를 수
/// 없으면 전부에게 보내고 전부의 답을 돌린다. 하나만 원하면 유일한 주소를 쓰면 된다.
#[test]
fn a_label_both_frameworks_claim_goes_to_both() {
    let cored = Cored::start("ambiguous");
    let mut a = Host::attach(&cored.socket, &["w-same"], "w-same");
    let mut b = Host::attach(&cored.socket, &["w-same"], "w-same");

    let r = cored.ask(json!({"id":3,"method":"x.y","window":"w-same","timeoutMs":600}));
    assert_eq!(r["data"]["hosts"], 2, "{r}");
    assert!(a.pushed().is_some(), "첫째 호스트가 못 받았다");
    assert!(b.pushed().is_some(), "둘째 호스트가 못 받았다");
}

/// 한쪽이 끊겨도 나머지는 계속 서빙한다 — 그리고 떠난 쪽의 창은 주소가 아니다.
#[test]
fn losing_one_framework_leaves_the_other_serving() {
    let cored = Cored::start("teardown");
    let gone = Host::attach(&cored.socket, &["w-gone"], "w-gone");
    let mut stays = Host::attach(&cored.socket, &["w-stays"], "w-stays");

    drop(gone); // 연결이 끝난다 = 그 프레임워크가 죽었다.

    // 회수는 연결이 끝나는 자리에서 일어난다. 그 신호가 cored 에 닿을 때까지는 한 왕복이 든다.
    let mut refused = None;
    for _ in 0..40 {
        let r = cored.ask(json!({"id":4,"method":"x.y","window":"w-gone","timeoutMs":300}));
        if r["code"] == "WINDOW_NOT_FOUND" {
            refused = Some(r);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(refused.is_some(), "떠난 호스트의 창이 아직 주소로 남아 있다");

    // 남은 쪽은 그대로 받는다.
    let socket = cored.socket.clone();
    std::thread::spawn(move || {
        let conn = UnixStream::connect(&socket).unwrap();
        let mut w = conn.try_clone().unwrap();
        writeln!(w, "{}", json!({"id":5,"method":"x.y","window":"w-stays","timeoutMs":3000})).unwrap();
        let mut line = String::new();
        let _ = BufReader::new(conn).read_line(&mut line);
    });
    let push = stays.pushed().expect("남은 호스트는 계속 받는다");
    assert_eq!(push["deliver"]["window"], "w-stays");
}
