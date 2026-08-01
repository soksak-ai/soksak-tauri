// 이 프레임워크가 cored 의 **창 호스트**가 된다.
//
// cored 에는 창이 없다. 그래서 밖에서 온 명령(하니스·sok·에이전트)이 화면에 닿으려면 창을
// 가진 쪽이 자기를 배달 통로로 등록해야 한다 — 그것이 `control_host_attach` 이고, 받는 쪽은
// 이미 서 있다(crates/soksak-cored/src/control.rs). 지금까지 그 등록을 부르는 프레임워크는
// Electron 하나였고, Tauri 는 0 건이었다. 그동안 이 앱은 자기 소켓만 서빙했으므로 "한 백엔드"
// 라는 말은 절반만 참이었다: cored 가 답하는 명령과 앱이 답하는 명령이 서로를 몰랐다.
//
// **소켓을 합치지 않는다.** 이 파일이 하는 것은 붙는 것까지다. 앱의 자기 소켓(ipc.rs)은 그대로
// 서고, 그 철수는 `ipc_socket_path` 계약과 그것을 못박은 오라클을 함께 뒤집는 별개의 일이다.
// 여기서 미리 걷으면 중간 상태에서 앱을 겨눈 하니스가 통째로 주소를 잃는다.
//
// **규칙은 여기 없다.** 어느 창으로 갈지는 코어가 정하고(soksak_core::control), 소켓 뒤에
// 세우는 것은 cored 다. 이 파일이 하는 일은 셋이다:
//   ① cored 에 "창은 내가 갖고 있다"고 등록하고,
//   ② 밀려오는 배달을 그 창에서 실행해 `cmd_result` 로 되돌리고,
//   ③ 창 사실이 바뀌면 `control_windows` 로 알린다.
// 여기서 타겟을 한 번이라도 다시 고르면 그 판정이 두 벌이 되고, 두 벌은 갈리는 순간까지 조용하다.
//
// **창 라벨은 겹칠 수 있다.** 두 프레임워크가 한 홈을 보면 저장된 `w-<uuid>` 를 각자 되살리고,
// `main` 은 둘 다 쓴다. 그때 cored 는 고르지 않고 `AMBIGUOUS_HOST` 로 거절한다 — 고르면 남의
// 프레임워크 창에서 명령이 돌고 성공을 답한다. 그 거절이 옳은 동작이라는 것을 검사가 못박는다
// (tests/attaches_to_cored.rs).
//
// 프레임워크·창·앱 핸들을 이 파일이 직접 만지지 않는 이유는 검증이다: 계약(WindowFactsSource·
// DeliveryExec) 뒤에 두면 GUI 없이 소켓 위에서 그대로 몰 수 있다. GUI 를 띄워야만 검증되는
// 코드는 사실상 검증되지 않는다.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use soksak_core::host_slot::{HostSlot, Rebuild};

/// cored 가 창 호스트를 아는 세 이름. 문자열을 부르는 자리마다 다시 적으면 한쪽만 고쳐질 수
/// 있고, 그 어긋남은 `UNKNOWN_COMMAND` 한 줄로만 나타난다.
pub const ATTACH: &str = "control_host_attach";
pub const WINDOWS: &str = "control_windows";
pub const RESULT: &str = "cmd_result";

/// 등록 요청에 다는 상관 id — cored 가 되울려 주므로 그 응답만 골라낼 수 있다.
/// 등록이 섰는지는 **그 답**이 말한다. 붙었는지 반복해 묻지 않는다(그 질문 자체가 배달로 나가
/// 창이 유령 명령을 받는다 — Electron 쪽 실측).
pub const ATTACH_ID: &str = "attach";

/// cored 바이너리를 지목하는 통로. 지목이 이기고, 없으면 이 실행물의 형제를 본다
/// (soksak-ptyd 와 같은 규칙 — 고르는 규칙은 코어가 소유한다).
pub const CORED_BIN_ENV: &str = "SOKSAK_CORED_BIN";

/// 준비 완료 줄을 기다리는 상한. 넘기면 우리가 띄운 프로세스를 거두고 이름을 달고 실패한다 —
/// 남기면 소켓을 쥔 고아가 되고, 다음 부팅은 그 고아를 "이미 살아 있는 cored" 로 채택한다.
///
/// 페이싱이 아니라 안전망이다: 기다림을 끝내는 것은 **준비 완료 줄**이고(블로킹 read), cored 가
/// 먼저 죽으면 EOF 가 그것도 끝낸다. 이 수는 둘 다 오지 않는 경우에만 쓰인다 — 그 경우에
/// 상한이 없으면 답 없는 헬퍼 하나가 부팅을 영원히 잡는다.
const READY_LIMIT: Duration = Duration::from_secs(15);

// ── 창 사실 ──────────────────────────────────────────────────────────────────

/// 지금 살아 있는 창과 포커스. **값이 아니라 매번 읽는다** — 등록 시점의 사본을 쥐면 다시
/// 붙을 때 낡은 목록으로 등록하고, cored 는 이미 없는 창을 주소로 갖는다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowFacts {
    pub live: Vec<String>,
    pub focused: String,
}

/// 창 사실의 출처. 구현은 호스트마다 하나다.
pub trait WindowFactsSource: Send + Sync + 'static {
    fn facts(&self) -> WindowFacts;
}

/// cored 가 민 배달 하나. 창은 **이미 정해져 있다**.
#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    /// 배달 상관 id — 회신(`cmd_result`)이 이 번호로 짝지어진다.
    pub id: u64,
    /// 봉투 그대로. **필드를 여기서 나열하지 않는다** — 나열하면 하나가 빠지고, 빠진 값은
    /// 실패가 아니라 소멸한다(실측 2026-08-01: `parent` 가 그렇게 사라졌다). 타겟 창은 이미
    /// 해소돼 봉투 안에 있다(cored 가 넣는다).
    pub req: soksak_spec_socket::RequestEnvelope,
}

impl Delivery {
    /// 이 배달이 향하는 창 — cored 가 해소해 봉투에 넣은 값이다.
    pub fn window(&self) -> &str {
        self.req.window.as_deref().unwrap_or_default()
    }
}

/// 배달을 실행하는 쪽. cored 가 고른 창으로 **그대로** 간다.
pub trait DeliveryExec: Send + Sync + 'static {
    /// 그 창에서 실행하고 답 봉투를 돌린다. 못 했으면 그 사실도 봉투다 — 답을 안 주면
    /// cored 가 상한까지 기다리고, 부른 쪽은 사유 없는 TIMEOUT 만 본다.
    fn execute(&self, d: &Delivery) -> Value;
    /// 짝 없는 사건을 창 전부에 뿌린다. 반환 = 전부에 닿았는가.
    fn broadcast(&self, event: &str, payload: Value) -> bool;
}

// ── 봉투 ─────────────────────────────────────────────────────────────────────

fn facts_params(f: &WindowFacts) -> Value {
    json!({ "live": f.live, "focused": f.focused })
}

/// "창은 내가 갖고 있다" — 이 연결이 배달 통로가 된다.
pub fn attach_envelope(f: &WindowFacts) -> Value {
    json!({ "id": ATTACH_ID, "method": ATTACH, "params": facts_params(f) })
}

/// 창 사실이 바뀌었다. 자기 창에 대해서만 말한다 — 전체를 갈면 다른 프레임워크의 창이
/// 보고 한 번에 주소를 잃는다.
pub fn windows_envelope(f: &WindowFacts) -> Value {
    json!({ "method": WINDOWS, "params": facts_params(f) })
}

/// 같은 보고에 상관 id 를 단다 — 답을 기다릴 쪽이 자기 답을 골라내는 유일한 방법이다.
/// 보고 자체는 같아야 한다: 모양이 갈리면 기다리는 경로와 안 기다리는 경로가 cored 에
/// 서로 다르게 읽힌다.
pub fn windows_envelope_with(f: &WindowFacts, id: &str) -> Value {
    let mut v = windows_envelope(f);
    v["id"] = json!(id);
    v
}

/// 창이 답했다. 배달 id 로 짝지어 되돌린다.
pub fn result_envelope(id: u64, result: Value) -> Value {
    json!({ "method": RESULT, "params": { "id": id, "result": result } })
}

// ── 밀려오는 줄 ──────────────────────────────────────────────────────────────

/// cored 가 이 연결로 미는 것들. 배달과 방송은 **다른 키**다 — 배달은 답을 기다리는 요청이고
/// 방송은 답이 없다. 같은 것으로 읽으면 방송마다 없는 id 로 회신하게 된다.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 요청의 응답 봉투.
    ///
    /// `data` 를 버리면 이 호스트는 성패만 나르고, 그러면 앱이 저장소 값을 못 받아 자기
    /// 커넥션을 계속 들고 있어야 한다 — 그것이 곧 쓰기 주인이 둘이라는 뜻이다.
    Answer { id: Value, ok: bool, code: String, message: String, data: Value },
    Deliver(Delivery),
    Broadcast { event: String, payload: Value },
}

/// 저장소 요청 봉투 — 밖에서 오는 요청과 **같은 모양**이다(`{id, method, params}`).
///
/// 창을 지목하지 않는다. 이 요청은 창이 아니라 저장소로 가고, 지목하면 cored 가 그것을 창으로
/// 배달하려 한다 — 그러면 이 프로세스가 자기 창에 묻고 상한까지 침묵한다.
pub fn request_envelope(id: &str, method: &str, params: &Value) -> Value {
    json!({ "id": id, "method": method, "params": params })
}

/// 한 줄을 읽는다. JSON 이 아니면 붙은 곳이 cored 가 아니다 — 조용히 넘기면 "명령이 사라진다"
/// 로만 나타난다.
pub fn classify(line: &str) -> Result<Incoming, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("JSON 이 아닌 줄: {e}"))?;
    if let Some(b) = v.get("broadcast") {
        let Some(event) = b.get("event").and_then(Value::as_str) else {
            return Err("방송에 이름이 없다".into());
        };
        return Ok(Incoming::Broadcast {
            event: event.to_string(),
            payload: b.get("payload").cloned().unwrap_or(Value::Null),
        });
    }
    if let Some(d) = v.get("deliver") {
        let Some(id) = d.get("id").and_then(Value::as_u64) else {
            return Err(format!("배달 봉투에 상관 id 가 없다: {d}"));
        };
        // 봉투는 통째로 읽는다 — 키를 골라 담으면 새 필드가 생길 때마다 이 자리가 빠뜨린다.
        let req: soksak_spec_socket::RequestEnvelope =
            serde_json::from_value(d.clone()).map_err(|e| format!("배달 봉투가 모자라다: {e}"))?;
        if req.window.as_deref().unwrap_or_default().is_empty() {
            return Err(format!("배달 봉투가 창을 짚지 않았다: {d}"));
        }
        return Ok(Incoming::Deliver(Delivery { id, req }));
    }
    Ok(Incoming::Answer {
        id: v.get("id").cloned().unwrap_or(Value::Null),
        ok: v.get("ok").and_then(Value::as_bool).unwrap_or(false),
        code: v.get("code").and_then(Value::as_str).unwrap_or_default().to_string(),
        message: v.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        data: v.get("data").cloned().unwrap_or(Value::Null),
    })
}

// ── 붙어 있는 호스트 ─────────────────────────────────────────────────────────

/// cored 에 붙은 이 프레임워크의 자리.
///
/// 앱의 명령 다리와 **다른 연결**을 쓴다. 다리 위에서는 응답이 요청의 짝으로만 오는데 배달은
/// 짝 없이 밀려오는 줄이라, 같은 연결에 섞으면 다리의 줄 짝짓기가 어긋난다.
pub struct CoredHost {
    writer: Arc<Mutex<UnixStream>>,
    facts: Arc<dyn WindowFactsSource>,
    socket: PathBuf,
    /// 우리가 띄운 cored — 채택한 것이면 없다. 남의 프로세스를 쥐면 거두는 자리가 두 곳이 된다.
    cored: Mutex<Option<Cored>>,
    /// 답을 기다리는 자리들.
    waiters: Arc<Waiters>,
    /// 등록의 답이 도착하는 자리. 한 번만 온다 — 받는 스레드가 넣고, 묻는 쪽이 꺼낸다.
    answer: Mutex<Option<mpsc::Receiver<Answered>>>,
    /// 꺼낸 답. 묻는 쪽이 여럿이어도 같은 답이어야 한다(채널은 한 번만 준다).
    verdict: OnceLock<Result<(), String>>,
    /// 보고의 상관 id 축. 이 연결 안에서만 유일하면 된다.
    seq: AtomicU64,
    /// 연결이 끝났는가. 받는 스레드가 EOF 를 만나면 세운다 — **끝났다는 사실을 값으로 가진
    /// 쪽이 없으면** 죽은 연결을 든 호스트가 산 것처럼 건네지고, 부른 쪽은 매번 상한까지
    /// 기다린 뒤 사유 없이 실패한다.
    closed: Arc<AtomicBool>,
}

/// 보낸 것의 답을 기다리는 자리 — 상관 id → 기다리는 쪽.
///
/// 기다릴 수 있어야 하는 이유는 **순서**다. 이 프로세스가 보낸 보고와 밖에서 온 요청은 서로
/// 다른 연결로 가고, cored 는 줄마다 일꾼을 띄운다 — 둘 사이에 순서 보장이 없다. 그래서
/// "알렸다"와 "그 알림이 장부에 섰다"는 다른 사실이고, 뒤엣것을 물을 수 없으면 그 사이에서
/// 나는 실패가 무작위로 나타난다(실측: 붙자마자 부른 명령이 `WINDOW_NOT_FOUND` 로 거절됐다).
/// 기다리는 자리는 **값**을 나른다. 성패만 나르면 `data_get` 의 답이 여기서 사라진다.
type Answered = Result<Value, String>;
type Waiters = Mutex<std::collections::HashMap<String, mpsc::Sender<Answered>>>;

/// 잡아 둔 자리에 온 답을 상한 안에 받고, 받았든 못 받았든 그 자리를 거둔다.
fn wait_for(
    waiters: &Waiters,
    id: &str,
    rx: mpsc::Receiver<Answered>,
    within: Duration,
) -> Answered {
    let verdict = match rx.recv_timeout(within) {
        Ok(v) => v,
        // 연결이 먼저 끝났다 — 상한까지 기다릴 이유가 없다. 붙어 있지 않다는 사실이 답이다.
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("답이 오기 전에 연결이 끝났다".into()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("답이 {}ms 안에 오지 않았다", within.as_millis()))
        }
    };
    // 못 받았으면 자리를 거둔다 — 남기면 늦게 온 답이 아무도 안 읽는 채널에 쌓인다.
    waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    verdict
}

impl CoredHost {
    /// 붙는다 — 지금 창 사실로 등록하고, 밀려오는 줄을 받는 스레드를 세운다.
    ///
    /// 등록 요청을 보내는 것까지가 이 함수다. 답을 여기서 기다리지 않는 이유는 부팅이다:
    /// 기다리면 cored 가 느린 만큼 창이 늦게 뜨고, 그 지연은 원인에서 멀리 떨어져 보인다.
    /// 등록이 서지 않았다는 사실은 받는 스레드가 이름을 달고 남기고, 물으면 값으로 온다
    /// (`attached`) — 기다리지 않는 것과 알 수 없는 것은 다르다.
    pub fn attach(
        socket: &Path,
        facts: Arc<dyn WindowFactsSource>,
        exec: Arc<dyn DeliveryExec>,
    ) -> Result<CoredHost, String> {
        let conn = UnixStream::connect(socket)
            .map_err(|e| format!("cored 에 붙지 못했다({}): {e}", socket.display()))?;
        let read_half = conn
            .try_clone()
            .map_err(|e| format!("연결을 나누지 못했다: {e}"))?;
        let writer = Arc::new(Mutex::new(conn));
        let (tx, rx) = mpsc::channel();
        let waiters: Arc<Waiters> = Arc::new(Mutex::new(std::collections::HashMap::new()));
        // 자리를 **보내기 전에** 잡는다 — 답이 먼저 도착하면 받는 스레드가 놓을 자리를 못 찾고,
        // 그 답은 다시 오지 않는다.
        waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ATTACH_ID.to_string(), tx);
        let host = CoredHost {
            writer: writer.clone(),
            facts: facts.clone(),
            socket: socket.to_path_buf(),
            cored: Mutex::new(None),
            waiters: waiters.clone(),
            answer: Mutex::new(Some(rx)),
            verdict: OnceLock::new(),
            seq: AtomicU64::new(1),
            closed: Arc::new(AtomicBool::new(false)),
        };
        host.send(&attach_envelope(&facts.facts()))?;
        let socket_name = socket.display().to_string();
        let closed = Arc::clone(&host.closed);
        std::thread::spawn(move || pump(read_half, writer, exec, socket_name, waiters, closed));
        Ok(host)
    }

    /// 등록이 섰는가 — **물어서 아는 자리**.
    ///
    /// 부팅은 기다리지 않는다(기다리면 cored 가 느린 만큼 창이 늦게 뜬다). 그러나 "붙었다"가
    /// 로그 한 줄로만 남으면 그것은 주장이지 사실이 아니다. 검증과 진단은 그 사실을 값으로
    /// 받아야 한다 — 안 그러면 안 붙은 상태가 `NO_HOST`·`WINDOW_NOT_FOUND` 로만, 그것도 부른
    /// 쪽에서만 나타난다.
    ///
    /// 상한 안에 답이 없으면 이름을 달고 실패한다. 연결이 먼저 끝나면 기다리지 않는다 —
    /// 받는 스레드가 그 사실을 넣고 끝난다.
    pub fn attached(&self, within: Duration) -> Result<(), String> {
        if let Some(v) = self.verdict.get() {
            return v.clone();
        }
        let mut slot = self.answer.lock().unwrap_or_else(|e| e.into_inner());
        let Some(rx) = slot.take() else {
            // 답을 이미 꺼냈는데 판정이 없다 — 꺼낸 자리가 판정을 넣지 않았다는 뜻이다.
            return Err("등록의 답을 잃었다".into());
        };
        // 등록은 값이 아니라 판정만 쓴다 — 붙었는가 아닌가.
        let verdict = wait_for(&self.waiters, ATTACH_ID, rx, within).map(|_| ());
        // 채널은 한 번만 준다 — 판정을 붙잡아야 두 번째로 묻는 쪽이 같은 답을 듣는다.
        let _ = self.verdict.set(verdict.clone());
        verdict
    }

    /// 창 사실이 바뀌었다고 알린다. 낡은 목록으로 타겟을 고르면 죽은 창에 배달된다 — 그리고
    /// 그 오답은 오류가 아니라 침묵으로 나타난다.
    pub fn windows_changed(&self) -> bool {
        self.report(&self.facts.facts())
    }

    /// 이 사실을 그대로 보고한다. 파괴 사건을 받은 자리는 그 창이 죽었다는 것을 이미 아는데
    /// 프레임워크의 창 목록이 그것을 언제 놓는지는 프레임워크의 사정이라, 목록만 믿으면 죽은
    /// 창을 살아 있다고 보고할 수 있다 — 그리고 cored 는 그 라벨로 다음 명령을 민다.
    ///
    /// 답을 기다리지 않는다: 창 사건은 UI 스레드를 지나고, 거기서 cored 를 기다리면 창이
    /// 나고 닫히는 것이 cored 의 속도에 묶인다.
    pub fn report(&self, f: &WindowFacts) -> bool {
        self.send(&windows_envelope(f)).is_ok()
    }

    /// 같은 보고를 하고, 그것이 **장부에 설 때까지** 기다린다.
    ///
    /// 보낸 것과 선 것은 다른 사실이다: 이 보고는 이 프로세스의 연결로 가고 밖에서 온 요청은
    /// 다른 연결로 오는데, cored 는 줄마다 일꾼을 띄우므로 둘 사이에 순서가 없다. 그래서 창이
    /// 주소가 됐는지 확인해야 하는 자리(검증·진단)는 이 길로 묻는다 — 잠들었다 다시 묻는
    /// 대신 답이 오는 자리에서 기다린다.
    pub fn report_settled(&self, f: &WindowFacts, within: Duration) -> Result<(), String> {
        let id = format!("w{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        if let Err(why) = self.send(&windows_envelope_with(f, &id)) {
            self.waiters
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(why);
        }
        // 창 보고도 판정만 쓴다 — 장부에 섰는가.
        wait_for(&self.waiters, &id, rx, within).map(|_| ())
    }

    /// cored 에 묻고 **값**을 받는다.
    ///
    /// 앱이 자기 저장소 커넥션을 놓는 길이다. 이 길이 없으면 앱은 값을 못 받아 계속 자기가
    /// DB 를 열고, 그러면 저장소를 쓰는 주인이 둘이 된다 — SQLite 는 막지 않고 직렬화만 한다.
    ///
    /// 상한이 있다. 없으면 답하지 않는 cored 하나가 그 명령을 부른 창을 영원히 붙잡는다.
    pub fn ask(&self, method: &str, params: &Value, within: Duration) -> Answered {
        let id = format!("q{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        if let Err(why) = self.send(&request_envelope(&id, method, params)) {
            // 못 보냈으면 기다리는 자리를 거둔다 — 안 거두면 그 자리가 영영 남아 다음 답이
            // 남의 자리를 찾는다.
            self.waiters
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(why);
        }
        wait_for(&self.waiters, &id, rx, within)
    }

    /// 답을 기다리지 않고 보낸다 — **기다리면 교착한다.**
    ///
    /// 이 연결은 양방향이다: cored 가 명령을 밀고 이 프로세스가 답을 돌려준다. 그 배달을
    /// 처리하는 중에 이쪽에서 답을 기다리면, cored 는 이쪽 답을 기다리고 이쪽은 cored 답을
    /// 기다린다(실측 2026-07-31: 앱 UI 가 통째로 미응답). 답이 필요 없는 일은 던지고 끝낸다.
    ///
    /// 보낸 뒤의 실패는 값으로 돌아온다 — 못 보낸 것을 보낸 것으로 세면 유실이 조용해진다.
    pub fn tell(&self, method: &str, params: &Value) -> Result<(), String> {
        // id 는 답을 안 받아도 붙인다 — 받는 쪽 프로토콜이 같은 모양을 요구하고, 로그에서
        // 어느 요청이었는지 가릴 수 있어야 한다.
        let id = format!("t{}", self.seq.fetch_add(1, Ordering::Relaxed));
        self.send(&request_envelope(&id, method, params))
    }

    /// 지금 창 사실을 알리고, 그것이 장부에 설 때까지 기다린다.
    pub fn windows_settled(&self, within: Duration) -> Result<(), String> {
        self.report_settled(&self.facts.facts(), within)
    }

    /// 이 호스트가 붙어 있는 자리 — 어디에 붙었는지는 물어서 알 수 있어야 한다.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// 우리가 띄운 cored 를 이 호스트가 진다. 채택한 것은 넘기지 않는다 — 남의 프로세스를
    /// 우리 수명에 묶으면 그것에 붙어 있던 다른 프레임워크의 창이 함께 주소를 잃는다.
    pub fn own(&self, cored: Cored) {
        *self.cored.lock().unwrap_or_else(|e| e.into_inner()) = Some(cored);
    }

    fn send(&self, v: &Value) -> Result<(), String> {
        write_line(&self.writer, v)
    }
}

fn write_line(writer: &Arc<Mutex<UnixStream>>, v: &Value) -> Result<(), String> {
    // 잠금이 깨져도 연결은 멀쩡하다 — 여기서 포기하면 남은 명령이 전부 침묵한다.
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    writeln!(w, "{v}").map_err(|e| format!("cored 로 쓰지 못했다: {e}"))?;
    w.flush().map_err(|e| format!("cored 로 흘리지 못했다: {e}"))
}

/// 밀려오는 줄을 받아 나른다. 연결이 끝나면 끝난다 — **다시 붙지 않는다.**
/// 재접속을 여기서 흉내내면 그때마다 새 연결이 새 호스트로 등록되어 같은 창을 든 호스트가
/// 둘이 되고, cored 는 그것을 `AMBIGUOUS_HOST` 로 거절한다(우리가 만든 겹침이다).
fn pump(
    read_half: UnixStream,
    writer: Arc<Mutex<UnixStream>>,
    exec: Arc<dyn DeliveryExec>,
    socket: String,
    waiters: Arc<Waiters>,
    closed: Arc<AtomicBool>,
) {
    let reader = BufReader::new(read_half);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match classify(&line) {
            Err(why) => eprintln!("[cored-host] {why} — {}", line.chars().take(200).collect::<String>()),
            Ok(Incoming::Answer { id, ok, code, message, data }) => {
                // 안 붙으면 밖에서 부른 명령이 상한으로만 끝난다. 왜 그런지는 이 줄이
                // 유일한 자국이고, 묻는 쪽에는 값으로 간다(attached).
                if id == json!(ATTACH_ID) && !ok {
                    eprintln!("[cored-host] 등록이 서지 않았다 — {code}: {message}");
                }
                // 기다리는 자리가 있으면 답을 놓는다. 없으면 지나간다 — 답을 안 기다리고
                // 보낸 것(창 사건의 보고)이 이 길로 온다.
                if let Some(key) = id.as_str() {
                    let waiter = waiters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(key);
                    if let Some(tx) = waiter {
                        let _ = tx.send(if ok {
                            Ok(data)
                        } else {
                            Err(format!("{code}: {message}"))
                        });
                    }
                }
            }
            Ok(Incoming::Broadcast { event, payload }) => {
                if !exec.broadcast(&event, payload) {
                    eprintln!("[cored-host] 방송이 일부 창에 닿지 못했다 — {event}");
                }
            }
            Ok(Incoming::Deliver(d)) => {
                // 배달마다 일꾼을 띄운다. 여기서 답을 기다리면 느린 명령 하나가 뒤에 오는
                // 배달을 전부 막고, 그 증상은 원인에서 한참 떨어져 보인다(cored 자신이 같은
                // 이유로 요청마다 스레드를 띄운다).
                let (writer, exec) = (writer.clone(), exec.clone());
                std::thread::spawn(move || {
                    let out = exec.execute(&d);
                    if let Err(why) = write_line(&writer, &result_envelope(d.id, out)) {
                        eprintln!("[cored-host] 회신이 cored 에 닿지 못했다({}): {why}", d.req.method);
                    }
                });
            }
        }
    }
    // 끝났다는 사실을 먼저 세운다 — 기다리던 쪽을 깨우기 전에 세워야, 그 답을 받고 곧바로
    // 다시 묻는 쪽이 죽은 호스트를 한 번 더 잡지 않는다.
    closed.store(true, Ordering::Release);
    // 기다리는 쪽을 상한까지 세워 두지 않는다 — 연결이 끝났다는 것 자체가 답이고, 그 답이
    // 늦으면 부팅 진단이 "느리다"와 "안 붙었다"를 구분하지 못한다.
    let left: Vec<_> = waiters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .collect();
    for (_, tx) in left {
        let _ = tx.send(Err(format!("연결이 끝났다: {socket}")));
    }
    eprintln!("[cored-host] 연결이 끝났다 — 밖에서 오는 명령이 이 창들에 닿지 않는다: {socket}");
}

// ── cored 를 세운다 ──────────────────────────────────────────────────────────

/// 이 cored 가 누구 것인가. 남의 것을 거두면 그 프로세스에 붙어 있던 다른 프레임워크의 창이
/// 통째로 주소를 잃는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// 이미 살아 있던 것 — 우리 것이 아니다.
    Adopted,
    /// 우리가 띄운 것.
    Spawned,
}

/// 세운 결과.
///
/// **떨어뜨려도 죽지 않는다.** 우리가 띄운 cored 는 이 프로세스보다 오래 살아도 되고, 다음
/// 부팅이 그것을 채택한다(soksak-ptyd 와 같은 모양). Drop 이 거두면 창 하나 닫는 경로에서
/// 값이 스쳐 지나가기만 해도 백엔드가 죽고, 그 죽음은 "명령이 안 먹는다"로만 나타난다.
/// 거두는 것은 부팅이 실패한 자리처럼 **거두기로 정한 곳**뿐이다.
///
/// `Debug` 는 실패를 값으로 읽기 위한 것이다 — 세운 결과가 `Err` 여야 하는 자리에서 `Ok` 가
/// 나오면 무엇을 세웠는지(어느 자리·채택인가 띄움인가)가 사유에 실려야 한다.
#[derive(Debug)]
pub struct Cored {
    pub socket: PathBuf,
    pub origin: Origin,
    child: Option<Child>,
}

impl Cored {
    /// 우리가 띄운 것만 거둔다(멱등). 채택한 것은 건드리지 않는다.
    pub fn stop(&mut self) {
        let Some(mut child) = self.child.take() else { return };
        if child.try_wait().map(|s| s.is_some()).unwrap_or(false) {
            let _ = child.wait();
            return;
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// 살아 있는가 — 우리가 띄운 것에 한해 답한다(채택한 것은 우리 프로세스의 자식이 아니다).
    pub fn spawned_alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

/// cored 부팅 인자 — 이 프로세스가 아는 값을 **넘긴다**.
///
/// cored 는 자기 정체성을 파생하지 않는다. 파생하는 순간 홈이 갈릴 때 조용히 다른 홈에 답하고,
/// 그 오답은 오류가 아니라 빈 결과로 나타난다. 로그인 셸과 OS 사용자 홈도 마찬가지다 —
/// `$SHELL` 은 프로세스 속성이 아니라 사용자 계정 속성이고, `~` 는 정체성 홈과 다른 값이다.
pub fn spawn_args(
    socket: &Path,
    home: &Path,
    identifier: &str,
    data_dir: &Path,
    user_home: Option<&Path>,
    login_shell: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--socket".to_string(),
        socket.display().to_string(),
        "--home".to_string(),
        home.display().to_string(),
        "--identifier".to_string(),
        identifier.to_string(),
        // 저장소 위치는 **넘기는 값**이다. 규칙을 양쪽에 두면 한쪽만 옮겨지고, 그때 두
        // 프로세스는 다른 파일을 연다 — 쓰기 소유권 잠금도 서로 다른 디렉터리에서 잡혀
        // 무의미해지고, 증상은 오류가 아니라 "저장한 것이 안 보인다"다.
        // Option 이 아닌 이유: Option 은 "안 넘겨도 된다"는 뜻이고 그 결과가 지금 상태였다.
        "--data-dir".to_string(),
        data_dir.display().to_string(),
    ];
    if let Some(u) = user_home {
        args.push("--user-home".to_string());
        args.push(u.display().to_string());
    }
    if let Some(s) = login_shell.filter(|s| !s.is_empty()) {
        args.push("--login-shell".to_string());
        args.push(s.to_string());
    }
    args
}

/// 준비 완료 줄은 **그 소켓**을 말해야 한다. 다른 것을 말하면 우리가 부른 것이 cored 가
/// 아니거나 다른 자리에 붙은 것이다 — 둘 다 "붙은 척"으로 넘어가면 안 된다.
pub fn readiness_names_socket(line: &str, socket: &Path) -> bool {
    line.contains(&socket.display().to_string())
}

/// 그 자리를 지금 누가 서빙하고 있는가. 파일 존재가 아니라 **연결**로 판정한다 — 죽은 소켓
/// 파일은 남고, 그것을 살아 있음으로 읽으면 아무도 없는 자리에 붙는다.
pub fn is_served(socket: &Path) -> bool {
    UnixStream::connect(socket).is_ok()
}

/// 이 정체성의 cored 를 세운다 — 채택하거나, 띄운다.
///
/// 이미 서빙 중이면 띄우지 않는다. 같은 자리에 둘을 띄우면 나중 것이 스스로 물러나거나
/// (cored 자신의 싱글턴 프로브) 남의 서빙을 끊는다.
pub fn ensure_cored(
    socket: &Path,
    home: &Path,
    identifier: &str,
    binary: &Path,
    data_dir: &Path,
    user_home: Option<&Path>,
    login_shell: Option<&str>,
) -> Result<Cored, String> {
    if is_served(socket) {
        return Ok(Cored { socket: socket.to_path_buf(), origin: Origin::Adopted, child: None });
    }
    if !binary.is_file() {
        return Err(format!(
            "cored 바이너리가 없다: {} ({CORED_BIN_ENV}=<경로> 로 지목하거나 이 실행물 옆에 둔다)",
            binary.display()
        ));
    }
    let mut child = Command::new(binary)
        .args(spawn_args(socket, home, identifier, data_dir, user_home, login_shell))
        .stdout(Stdio::piped())
        // stderr 는 물려준다 — cored 가 마지막에 말한 사유가 이 프로세스의 로그에 그대로 남는다.
        .stderr(Stdio::inherit())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("cored 를 띄우지 못했다({}): {e}", binary.display()))?;

    // 준비 완료 = stdout 첫 줄. 소켓 파일이 생겼는지 반복해 보는 폴링을 쓰지 않는다 —
    // 파일 존재는 bind 완료가 아니고, 블로킹 read 는 cored 가 먼저 죽으면 EOF 로 드러난다.
    // 상한은 별 스레드로 건다: 여기서 그냥 read 하면 답 없는 cored 하나가 부팅을 영원히 잡는다.
    let out = child.stdout.take().ok_or("cored 의 stdout 을 잡지 못했다")?;
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(out).lines();
        let first = lines.next().and_then(Result::ok);
        let _ = tx.send(first);
        // 첫 줄 뒤에도 읽기를 놓지 않는다. 파이프의 읽는 쪽을 닫으면 cored 가 다음에 stdout 에
        // 쓸 때 SIGPIPE 로 죽는다 — 그 죽음은 우리가 만든 것이고, 원인에서 멀리 떨어져 보인다.
        for line in lines.map_while(Result::ok) {
            eprintln!("[cored] {line}");
        }
    });

    let mut owned = Cored {
        socket: socket.to_path_buf(),
        origin: Origin::Spawned,
        child: Some(child),
    };
    match rx.recv_timeout(READY_LIMIT) {
        Ok(Some(line)) if readiness_names_socket(&line, socket) => Ok(owned),
        Ok(Some(line)) => {
            owned.stop();
            Err(format!(
                "준비 완료 줄이 소켓({})을 말하지 않는다: {}",
                socket.display(),
                line.trim()
            ))
        }
        // 아무 말 없이 끝났다 — cored 는 남이 그 자리를 서빙하면 스스로 물러난다(exit 0, 줄 없음).
        // 그때는 서빙되는 소켓을 버릴 이유가 없다. 다만 정말 서빙되는지는 우리가 확인한다.
        Ok(None) => {
            owned.stop();
            if is_served(socket) {
                return Ok(Cored { socket: socket.to_path_buf(), origin: Origin::Adopted, child: None });
            }
            Err(format!(
                "cored 가 준비 완료를 알리기 전에 끝났고 {} 를 서빙하는 것도 없다",
                socket.display()
            ))
        }
        Err(_) => {
            // 상한을 넘긴 것은 우리가 띄운 프로세스다 — 남기면 소켓을 쥔 고아가 된다.
            owned.stop();
            Err(format!(
                "cored 가 {}ms 안에 준비 완료를 알리지 않았다: {} (거둠)",
                READY_LIMIT.as_millis(),
                binary.display()
            ))
        }
    }
}

// ── 이 프로세스의 앰비언트 ───────────────────────────────────────────────────

/// 이 프로세스가 아는 cored 실행 파일 — **후보를 만들어 넘긴다.**
///
/// 지목(`SOKSAK_CORED_BIN`) > 이 실행물의 형제 `soksak-cored`(dev 의 cargo 산출·번들 동봉 공통
/// 규칙). 고르는 규칙은 코어의 것이고(soksak_core::ptyd::pick_source — ptyd 와 같은 규칙이라
/// 사본을 만들지 않는다), 여기서는 이 프로세스만 아는 두 사실(환경·자기 경로)을 읽어 준다.
fn cored_source() -> Option<PathBuf> {
    let declared = std::env::var(CORED_BIN_ENV)
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("soksak-cored")));
    soksak_core::ptyd::pick_source(declared.as_deref(), sibling.as_deref())
}

/// 이 프레임워크의 창 사실 — 살아 있는 창 목록과 포커스 창.
struct AppFacts(tauri::AppHandle);

impl WindowFactsSource for AppFacts {
    fn facts(&self) -> WindowFacts {
        WindowFacts {
            live: crate::window_oracle::WindowOracle::live_labels(&self.0),
            focused: crate::ipc::active_window(),
        }
    }
}

/// 배달을 실행하는 이 프레임워크의 자리 — 창은 cored 가 골랐고, 여기서 다시 고르지 않는다.
struct AppExec(tauri::AppHandle);

impl DeliveryExec for AppExec {
    fn execute(&self, d: &Delivery) -> Value {
        // 봉투를 그대로 넘긴다 — 여기서 필드를 골라 다시 조립하면 그것이 두 번째 계약이다.
        crate::ipc::request_delivered(&self.0, d.req.clone())
    }
    fn broadcast(&self, event: &str, payload: Value) -> bool {
        crate::window_oracle::WindowOracle::broadcast(&self.0, event, payload)
    }
}

/// 부팅 한 걸음 — cored 를 세우고 이 프레임워크의 창을 그 cored 에 등록한다.
///
// ── 이 프로세스의 호스트 ──────────────────────────────────────────────────────
//
// 하나다. 이 프레임워크는 cored 에 **한 번** 붙는다 — 여럿을 두면 같은 창을 든 호스트가
// 둘이 되고, cored 는 그것을 AMBIGUOUS_HOST 로 거절한다(우리가 만든 겹침이다).
//
// 부팅이 세우고, 저장소를 위임한 명령이 이 자리로 묻는다. 세우기 전에는 **없다** — 없는 것을
// 있는 척하면 부른 쪽이 상한까지 기다린다.
//
// 한 번에 하나지, 한 번뿐이 아니다. cored 는 죽을 수 있고(판올림·강제종료·크래시) 그때 이
// 자리의 호스트는 **죽은 연결을 든 껍데기**가 된다. 갈아탈 수 없는 자리에 두면 그 앱은 남은
// 수명 내내 저장소를 잃는다 — 읽기도 쓰기도 실패하고, 실패한 읽기를 "비어 있음"으로 적는
// 소비자가 하나라도 있으면 그것이 곧 사용자 데이터 소실이다(실측 2026-08-01).
// 규칙(한 번에 하나·죽으면 비운다·비면 요구가 다시 세운다)은 **코어가 진다** — 이 자리는
// 그 규칙에 이 프레임워크의 호스트 타입을 끼우는 배선뿐이다.
static HOST: HostSlot<CoredHost> = HostSlot::with_floor(REBUILD_FLOOR);

/// 재건 시도 사이의 최소 간격. 저장은 사용자 변경마다 오므로, 주인이 안 서는 동안 그 수만큼
/// 세우려 들면 스폰이 몰린다. 폴링이 아니다 — 시도는 **부를 일이 있을 때만** 일어난다.
const REBUILD_FLOOR: Duration = Duration::from_secs(1);

/// 붙어 있는 것은 스스로 답한다 — 자리는 무엇에 붙었는지 모른다.
impl soksak_core::host_slot::Attachment for CoredHost {
    fn is_open(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }
}

/// 부팅이 세운 호스트를 프로세스 자리에 둔다.
pub fn install(host: Arc<CoredHost>) {
    HOST.install(host);
}

/// 자리가 비었을 때 다시 세우는 법 — 부팅이 넣는다.
pub fn rebuild_with(f: Rebuild<CoredHost>) {
    HOST.rebuild_with(f);
}

/// 지금 붙어 있는 호스트. 부팅 전이거나 연결이 끝났으면 없다.
pub fn current() -> Option<Arc<CoredHost>> {
    HOST.current()
}

/// 저장소 주인에게 묻는다 — 이 프로세스가 저장소를 위임했을 때 지나는 길.
///
/// 붙어 있지 않으면 **다시 붙어 본다.** 주인은 판올림이나 크래시로 갈릴 수 있고, 그때 한 번
/// 끊겼다는 이유로 남은 수명 내내 저장소를 잃으면 그 앱은 읽지도 쓰지도 못한다.
///
/// 그래도 물을 곳이 없으면 **이름을 달고** 실패한다. 조용한 실패는 "명령이 사라진다"로만
/// 보이고, 그때 사람은 저장소가 아니라 명령을 의심한다.
pub fn ask_owner(method: &str, params: &Value) -> Result<Value, String> {
    let Some(host) = HOST.live() else {
        return Err(format!(
            "cored 에 붙지 않았다 — {method} 를 물을 곳이 없다(이 프로세스는 저장소를 위임했다)"
        ));
    };
    host.ask(method, params, OWNER_ASK_LIMIT)
}

/// 주인의 답을 기다리는 상한. 없으면 답하지 않는 cored 하나가 그 명령을 부른 창을 영원히
/// 붙잡는다. 저장소 한 번의 왕복이라 짧게 잡는다 — 길면 UI 가 멈춘 것처럼 보인다.
pub const OWNER_ASK_LIMIT: Duration = Duration::from_secs(10);

/// 실패해도 앱은 선다. 이 프레임워크는 아직 자기 소켓으로 자기 창을 서빙하고 있고, 여기서
/// 죽으면 그 서빙까지 함께 죽는다. 대신 조용히 지나가지 않는다 — 못 한 것은 이름을 달고 남고,
/// 부른 쪽이 그 사유를 값으로 받는다.
pub fn stand_up(app: &tauri::AppHandle) -> Result<CoredHost, String> {
    let identity = crate::identity::ambient();
    let socket = identity.cored_socket();
    let binary = cored_source().ok_or_else(|| {
        format!("cored 바이너리를 못 찾았다 — {CORED_BIN_ENV}=<경로> 로 지목하거나 이 실행물 옆에 둔다")
    })?;
    // OS 사용자 홈과 로그인 셸은 **이 프로세스가 상속한 값**이다. cored 가 자기 환경에서 읽으면
    // 자기를 띄운 쪽의 환경을 사용자의 것인 양 답한다.
    let user_home = std::env::var("HOME").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let login_shell = crate::login_shell::ambient();
    let cored = ensure_cored(
        &socket,
        identity.home(),
        // **홈 이름으로 띄운다** — cored 는 홈에 하나뿐인 공용 프로세스다. 띄운 프레임워크의
        // 이름으로 부르면 그 이름이 공용 자원에 박히고, 붙는 쪽마다 "저건 남의 앱인가"를
        // 우회로 가려야 한다(실측 2026-08-01: CLI 가 그 우회를 갖고 있었다).
        &soksak_core::identity::home_identity_of(identity.identifier()),
        &binary,
        // 저장소 위치는 앱이 해소해 넘긴다 — cored 가 다시 파생하면 두 프로세스가 다른 파일을 연다.
        &crate::data::data_dir(),
        user_home.as_deref(),
        Some(&login_shell),
    )?;
    let host = CoredHost::attach(
        &cored.socket,
        Arc::new(AppFacts(app.clone())),
        Arc::new(AppExec(app.clone())),
    )?;
    eprintln!(
        "[cored-host] cored {} — {}",
        match cored.origin {
            Origin::Adopted => "이미 살아 있음",
            Origin::Spawned => "띄움",
        },
        cored.socket.display()
    );
    host.own(cored);
    Ok(host)
}

/// 창 사실이 바뀌었다고 알린다. 아직 안 붙었으면 할 일이 없다 — 붙을 때 지금 사실로 등록한다.
///
/// 호스트는 **한 자리**(HOST)에서만 온다. 예전에는 이 자리가 Tauri State 를 봤는데, 부팅은
/// `Arc<CoredHost>` 를 실었고 여기서는 `CoredHost` 를 꺼냈다 — 타입 키가 달라 **언제나 없었다.**
/// 그래서 창이 나고 죽어도 cored 는 못 들었고, 죽은 라벨이 센서스에 남았다. 같은 사실을 두
/// 자리에 두면 그중 하나는 답하지 않고, 그 침묵은 아무 데도 오류로 나타나지 않는다.
pub fn announce_windows(_app: &tauri::AppHandle) {
    if let Some(host) = current() {
        host.windows_changed();
    }
}

/// 방금 죽은 창을 빼고 알린다.
///
/// 파괴 사건을 받은 자리는 그 창이 죽었다는 것을 이미 아는데, 프레임워크의 창 목록이 그것을
/// 언제 놓는지는 프레임워크의 사정이다. 목록만 믿고 보고하면 죽은 라벨이 그대로 남고, cored 는
/// 그 라벨로 다음 명령을 민다 — 답은 오지 않고 부른 쪽은 사유 없는 TIMEOUT 만 본다.
pub fn announce_windows_without(_app: &tauri::AppHandle, gone: &str) {
    let Some(host) = current() else { return };
    let mut f = host.facts.facts();
    f.live.retain(|l| l != gone);
    // 포커스도 죽은 창을 가리킬 수 있다. 코어의 장부가 살아 있는 목록으로 스스로 맞추므로
    // (FocusLedger::reconcile) 여기서 다음 포커스를 고르지 않는다 — 고르면 그 선택이 두 벌이 된다.
    host.report(&f);
}

#[cfg(test)]
#[path = "cored_host_tests.rs"]
mod tests;
