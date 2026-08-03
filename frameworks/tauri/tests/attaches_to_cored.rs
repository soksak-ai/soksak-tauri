// 이 프레임워크가 cored 에 붙는다 — **실제 소켓 위에서**.
//
// 재는 것은 하나다: 붙고 나면 cored 가 이 프레임워크의 창을 **주소로 안다**. 그 전까지 이
// 프레임워크는 `control_host_attach` 를 한 번도 부르지 않았고(Electron 만 불렀다), 그래서
// cored 를 지나 온 명령은 이 앱의 화면에 닿을 길이 없었다 — 그런데 그 사실은 오류가 아니라
// `NO_HOST`/`WINDOW_NOT_FOUND` 한 줄로만 나타난다.
//
// **GUI 를 띄우지 않는다.** 창·앱 핸들은 계약 뒤에 있고(`WindowFactsSource`·`DeliveryExec`),
// 이 파일은 그 계약의 자리에 검증용 구현을 끼운다. 그래서 여기서 재는 것은 배선 전부다:
// 등록 봉투가 cored 에 받아들여지는가, 밀려온 배달이 실행기로 넘어가는가, 실행기의 답이
// `cmd_result` 로 짝지어 돌아가는가, 창 사실이 바뀌면 cored 의 주소록이 따라오는가.
// 남는 것은 "그 실행기가 진짜 창을 그린다"뿐이고, 그것은 GUI 검증의 몫이다.
//
// cored 쪽 규칙(호스트 여럿·라벨 소유·방송·회수)은 `crates/soksak-cored/tests/two_hosts_over_socket.rs`
// 가 잰다. 여기는 **붙는 쪽**의 자리다.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use soksak_lib::cored_host::{CoredHost, Delivery, DeliveryExec, WindowFacts, WindowFactsSource};

/// 읽기 상한. "오지 않는 것이 정답"인 검사가 있고(겹친 라벨), 상한이 없으면 그 정답이 실패가
/// 아니라 멈춤으로 나타난다.
const LIMIT: Duration = Duration::from_secs(5);

// ── cored 하나 ───────────────────────────────────────────────────────────────

/// 이 파일의 cored 는 **하나**다.
///
/// cored 의 호스트 장부·포커스 장부는 프로세스 전역이다(control.rs 의 `HOSTS`/`FOCUS`). 소켓을
/// 검사마다 따로 열어도 그 뒤는 같은 장부라, 여러 cored 를 세운 척하면 검사끼리 서로의 호스트를
/// 보게 된다. 그래서 자리는 하나로 두고, 검사마다 **창 라벨을 다르게** 쓴다 — 겹치지 않는 라벨은
/// 검사끼리 격리를 라벨로 세운다(전역을 비우는 방식은 남의 검사가 붙어 있는 동안 그것을 지운다).
fn cored() -> &'static Path {
    static CORED: OnceLock<PathBuf> = OnceLock::new();
    CORED.get_or_init(|| {
        let dir = fixture_dir();
        let socket = dir.join("h.sock");
        let home = dir.join("home");
        std::fs::create_dir_all(&home).expect("픽스처 홈");
        let listener = UnixListener::bind(&socket).expect("cored 소켓 bind");
        // 서빙 상태는 cored 의 것이다 — 신원은 인자로 받는다(이 프로세스가 파생하지 않는다).
        let ctx = Arc::new(soksak_cored::ctx::Ctx::new(soksak_core::identity::Identity::new(
            home,
            "com.soksak.tauri.dev",
        )));
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let ctx = ctx.clone();
                std::thread::spawn(move || serve_conn(&ctx, conn));
            }
        });
        socket
    })
}

/// 연결 하나 = NDJSON 루프. 판정은 전부 cored 의 것이고(`wire::answer_on_conn`), 여기 있는 것은
/// 그 판정을 소켓 뒤에 세우는 배선뿐이다 — 검사가 인프로세스 함수를 부르면 봉투 조립·연결
/// 수명·회신 짝짓기가 검사에서 통째로 빠진다.
fn serve_conn(ctx: &Arc<soksak_cored::ctx::Ctx>, conn: UnixStream) {
    let Ok(read_half) = conn.try_clone() else { return };
    let state = Arc::new(soksak_cored::wire::Conn::new(conn));
    for line in BufReader::new(read_half).lines().map_while(Result::ok) {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        // 요청마다 일꾼을 띄운다 — 배달을 기다리는 요청 하나가 같은 연결의 뒤를 막으면
        // 회신(`cmd_result`)이 영영 읽히지 않는다.
        let (ctx, state) = (ctx.clone(), state.clone());
        std::thread::spawn(move || {
            let reply = soksak_cored::wire::answer_on_conn(&ctx, &line, &state);
            state.reply(&reply)
        });
    }
    // 연결이 끝났다 = 그 호스트가 죽었다. 회수가 여기서 일어나야 떠난 프레임워크의 창이
    // 주소로 남지 않는다.
    state.release();
}

/// 픽스처 뿌리는 홈 아래 고정 경로다(재사용·멱등). `CARGO_TARGET_TMPDIR` 을 쓰지 않는 이유:
/// 유닉스 소켓 경로에는 OS 상한이 있어(macOS ~104바이트) 워크트리 아래 target 경로는 그것만으로
/// 상한을 넘는다. 사용자 정본 홈(`~/.soksak-dev`)에는 쓰지 않는다 — 검사가 사람의 홈을 건드리면
/// 그 사고는 다음 규칙 변경까지 아무도 못 본다.
fn fixture_dir() -> PathBuf {
    let dir = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".soksak-e2e/tauri-cored");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("픽스처 디렉터리");
    dir
}

/// 밖에서 온 요청 하나 — 하니스·`sok`·에이전트가 지나는 길이다. 답 한 줄을 그대로 돌린다.
fn ask(req: Value) -> Value {
    let conn = UnixStream::connect(cored()).expect("소켓 연결");
    conn.set_read_timeout(Some(LIMIT)).expect("읽기 상한");
    let mut w = conn.try_clone().expect("쓰기 사본");
    writeln!(w, "{req}").expect("요청");
    w.flush().expect("흘리기");
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).expect("응답");
    serde_json::from_str(line.trim()).expect("한 줄 JSON")
}

/// 그 창을 겨눈 요청을 **딴 스레드에서** 낸다. 배달은 밀려오고 회신은 이 프로세스가 만드는데,
/// 여기서 답을 기다리면 배달을 받을 사람이 없어 상한까지 아무 일도 일어나지 않는다.
fn ask_async(req: Value) -> std::thread::JoinHandle<Value> {
    std::thread::spawn(move || ask(req))
}

// ── 창을 가진 쪽(검증용) ─────────────────────────────────────────────────────

/// 이 프레임워크의 창 사실. 값이 아니라 **매번 읽는다** — 창이 나고 죽는 것이 이 출처에 반영되고,
/// 호스트는 그때그때 읽어 보고한다.
struct Facts(Mutex<WindowFacts>);

impl Facts {
    fn new(live: &[&str], focused: &str) -> Arc<Facts> {
        Arc::new(Facts(Mutex::new(WindowFacts {
            live: live.iter().map(|s| s.to_string()).collect(),
            focused: focused.to_string(),
        })))
    }

    fn set(&self, live: &[&str], focused: &str) {
        let mut f = self.0.lock().expect("창 사실");
        f.live = live.iter().map(|s| s.to_string()).collect();
        f.focused = focused.to_string();
    }
}

impl WindowFactsSource for Facts {
    fn facts(&self) -> WindowFacts {
        self.0.lock().expect("창 사실").clone()
    }
}

/// 배달을 실행하는 자리(검증용). 실제로는 창의 명령 다리가 여기 온다.
struct Windows {
    ran: AtomicUsize,
    delivered: Mutex<Sender<Delivery>>,
    broadcast: Mutex<Sender<(String, Value)>>,
    /// 이 창이 답하는 값 — 봉투가 그대로 부른 쪽에 닿는지 재기 위해 표식을 싣는다.
    answer: Value,
}

impl Windows {
    fn new(answer: Value) -> (Arc<Windows>, Receiver<Delivery>, Receiver<(String, Value)>) {
        let (dtx, drx) = channel();
        let (btx, brx) = channel();
        (
            Arc::new(Windows {
                ran: AtomicUsize::new(0),
                delivered: Mutex::new(dtx),
                broadcast: Mutex::new(btx),
                answer,
            }),
            drx,
            brx,
        )
    }

    fn ran(&self) -> usize {
        self.ran.load(Ordering::SeqCst)
    }
}

impl DeliveryExec for Windows {
    fn execute(&self, d: &Delivery) -> Value {
        self.ran.fetch_add(1, Ordering::SeqCst);
        let _ = self.delivered.lock().expect("배달 통로").send(d.clone());
        self.answer.clone()
    }
    fn broadcast(&self, event: &str, payload: Value) -> bool {
        let _ = self
            .broadcast
            .lock()
            .expect("방송 통로")
            .send((event.to_string(), payload));
        true
    }
}

/// 붙은 호스트 하나가 지고 오는 것: 그 자리, 창 사실의 출처, 실행기, 그리고 실행기에 도착한
/// 배달과 방송. 도착한 것을 채널로 받는 이유는 기다림을 잠으로 때우지 않기 위해서다.
type Attached = (
    CoredHost,
    Arc<Facts>,
    Arc<Windows>,
    Receiver<Delivery>,
    Receiver<(String, Value)>,
);

/// 붙은 호스트 하나 — 프레임워크 부팅이 하는 그 걸음이다(`stand_up` 의 마지막 줄).
///
/// 등록이 설 때까지 기다린다. 부팅은 기다리지 않지만(창이 늦게 뜬다) 검사는 기다려야 한다 —
/// 등록은 이 프로세스의 연결로 가고 요청은 **다른 연결**로 가서, 둘 사이에 순서 보장이 없다.
/// 기다리지 않으면 이 파일의 단언들이 무작위로 `WINDOW_NOT_FOUND` 를 보고 실패한다(실측).
/// 잠들었다 다시 묻는 대신 답이 오는 자리에서 기다린다 — 그 자리는 호스트가 준다(`attached`).
fn attach(live: &[&str], focused: &str, answer: Value) -> Attached {
    let facts = Facts::new(live, focused);
    let (windows, delivered, broadcast) = Windows::new(answer);
    let host = CoredHost::attach(cored(), facts.clone(), windows.clone()).expect("cored 에 붙는다");
    host.attached(LIMIT).expect("등록이 선다");
    (host, facts, windows, delivered, broadcast)
}

// ── 재는 것 ──────────────────────────────────────────────────────────────────

/// 붙고 나면 cored 가 이 프레임워크의 창을 **주소로 안다** — 그리고 그 창의 답이 부른 쪽에
/// 그대로 닿는다.
///
/// 안 붙으면 cored 는 배달할 곳이 없다고 답하고(`NO_HOST`), 밖에서 온 명령은 화면에 닿지 않는다.
/// 그 실패는 앱 로그 한 줄도 남기지 않는다 — 부른 쪽에만 나타난다.
#[test]
fn attaching_makes_this_frameworks_window_an_address_in_cored() {
    let (_host, _facts, windows, delivered, _b) =
        attach(&["t-attach"], "t-attach", json!({ "ok": true, "data": { "ran": "여기" } }));

    let caller = ask_async(json!({
        "id": 1, "method": "panel.split", "params": { "side": "right" },
        "pane": "p-1", "window": "t-attach", "timeoutMs": 4000
    }));

    // 배달은 **밀려온다**(폴링이 아니다). 상한은 답 없는 한쪽이 검사를 멈추게 하지 않기 위한 것이다.
    let d = delivered.recv_timeout(LIMIT).expect("배달이 실행기로 온다");
    assert_eq!(d.window(), "t-attach", "cored 가 고른 창이 그대로 와야 한다");
    assert_eq!(d.req.method, "panel.split");
    assert_eq!(d.req.params, json!({ "side": "right" }));
    assert_eq!(d.req.pane.as_deref(), Some("p-1"), "pane 은 배달의 일부다");

    // 회신은 배달 id 로 짝지어 돌아간다 — 짝이 어긋나면 부른 쪽은 사유 없는 TIMEOUT 만 본다.
    let out = caller.join().expect("부른 쪽");
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["data"]["ran"], "여기", "창의 답이 그대로 닿아야 한다: {out}");
    assert_eq!(out["id"], 1, "요청의 id 가 되돌아온다");
    assert_eq!(windows.ran(), 1, "배달은 한 번 실행된다");
}

/// 붙은 뒤에 난 창도 주소가 된다 — 알리지 않으면 cored 의 주소록은 부팅 시점에 멈춘다.
///
/// 새 창 생성 경로가 `control_windows`의 상관 응답까지 기다린다. 포커스 없는 복원 창도 같은
/// 경로를 지나야 하며, 포커스 사건에 기대면 그 창만 "창 없음"으로 거절된다.
#[test]
fn a_window_that_opens_after_the_attach_becomes_an_address() {
    let (host, facts, _w, delivered, _b) =
        attach(&["t-grow"], "t-grow", json!({ "ok": true, "data": null }));

    // 아직 없는 창이다 — 여기서 이미 배달되면 뒤의 단언이 아무것도 안 지킨다.
    let before = ask(json!({ "id": 2, "method": "x.y", "window": "t-grow-2", "timeoutMs": 500 }));
    assert_eq!(before["code"], "WINDOW_NOT_FOUND", "{before}");

    facts.set(&["t-grow", "t-grow-2"], "t-grow-2");
    // 알린 것과 선 것은 다른 사실이다. 보내고 끝내면 뒤의 요청이 **다른 연결**로 먼저 닿아
    // 아직 없는 창으로 거절되고, 그 실패는 무작위로 나타난다.
    host.windows_settled(LIMIT).expect("창 사실이 장부에 선다");

    let caller = ask_async(json!({ "id": 3, "method": "x.y", "window": "t-grow-2", "timeoutMs": 4000 }));
    let d = delivered.recv_timeout(LIMIT).expect("새 창으로 배달된다");
    assert_eq!(d.window(), "t-grow-2");
    assert_eq!(caller.join().expect("부른 쪽")["ok"], true);
}

/// 죽은 창은 주소가 아니다 — 살아 있는 목록을 그대로 보고하면 장부가 스스로 맞춘다(멱등).
///
/// 안 놓으면 cored 는 없는 창으로 명령을 밀고, 답은 오지 않는다. 부른 쪽이 보는 것은 상한이고,
/// 그 상한은 "왜"를 말하지 않는다.
#[test]
fn a_window_that_died_stops_being_an_address() {
    let (host, _facts, _w, delivered, _b) =
        attach(&["t-gone", "t-stays"], "t-gone", json!({ "ok": true, "data": null }));

    // 파괴 사건이 지나는 자리와 같은 모양 — 방금 죽은 라벨을 뺀 목록을 보고한다.
    host.report_settled(
        &WindowFacts { live: vec!["t-stays".into()], focused: "t-stays".into() },
        LIMIT,
    )
    .expect("창 사실이 장부에 선다");

    let refused = ask(json!({ "id": 4, "method": "x.y", "window": "t-gone", "timeoutMs": 500 }));
    assert_eq!(refused["code"], "WINDOW_NOT_FOUND", "{refused}");

    // 남은 창은 그대로 받는다 — 보고 한 번이 이 프레임워크의 창을 통째로 지우지 않는다.
    let caller = ask_async(json!({ "id": 5, "method": "x.y", "window": "t-stays", "timeoutMs": 4000 }));
    assert_eq!(delivered.recv_timeout(LIMIT).expect("남은 창").window(), "t-stays");
    assert_eq!(caller.join().expect("부른 쪽")["ok"], true);
}

/// 같은 라벨을 두 프레임워크가 들면 **둘 다 실행하고 둘의 답이 온다.**
///
/// 겹침은 우연이 아니라 필연이다: 창 복원은 저장된 `w-<uuid>` 를 되쓰고, `main` 은 오케스트
/// 레이터 역할이라 두 프레임워크가 각자 하나씩 든다. 한 홈을 둘이 보면 반드시 겹친다.
///
/// 한때 그때 거절했는데, 그러면 두 앱을 함께 켠 순간 어느 쪽도 밖에서 못 부른다(실측
/// 2026-08-01). 고를 수 없으면 전부에게 보낸다 — 하나만 원하면 유일한 주소를 쓰면 된다.
#[test]
fn a_label_both_frameworks_claim_runs_on_both() {
    let (_h1, _f1, w1, _d1, _b1) = attach(&["t-same"], "t-same", json!({ "ok": true, "data": 1 }));
    let (_h2, _f2, w2, _d2, _b2) = attach(&["t-same"], "t-same", json!({ "ok": true, "data": 2 }));

    let r = ask(json!({ "id": 6, "method": "x.y", "window": "t-same", "timeoutMs": 2000 }));
    assert_eq!(r["data"]["hosts"], 2, "{r}");
    let answers = r["data"]["answers"].as_array().cloned().unwrap_or_default();
    assert_eq!(answers.len(), 2, "둘의 답이 다 와야 한다: {r}");
    assert_eq!(w1.ran(), 1, "첫째가 실행하지 않았다");
    assert_eq!(w2.ran(), 1, "둘째가 실행하지 않았다");
}

/// 방송은 주인 없는 사실이다 — 붙은 쪽이 받아 자기 창에 뿌린다.
///
/// 이 길이 없으면 cored 가 아는 사실(파일 변경·데몬 사망)이 창까지 오지 않고, 화면은 낡은 것을
/// 계속 보여 준다. 그것은 오류가 아니라 **갱신 안 됨**으로 나타난다.
#[test]
fn a_broadcast_reaches_this_frameworks_windows() {
    let (_host, _facts, windows, _d, broadcast) =
        attach(&["t-cast"], "t-cast", json!({ "ok": true, "data": null }));

    assert!(
        soksak_cored::control::broadcast("fs.changed", json!({ "path": "/x" })),
        "붙은 호스트가 있으니 넘어간다"
    );

    let (event, payload) = broadcast.recv_timeout(LIMIT).expect("방송이 온다");
    assert_eq!(event, "fs.changed");
    assert_eq!(payload["path"], "/x");
    // 방송은 답이 없다 — 배달로 읽으면 없는 id 로 회신하게 되고, 그 회신은 짝 없는 줄로 버려진다.
    assert_eq!(windows.ran(), 0, "방송을 실행기로 넘겼다");
}
