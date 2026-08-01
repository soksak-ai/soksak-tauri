//! 제어면 — 밖에서 온 명령을 창으로 배달하고 회신을 돌려준다.
//!
//! **규칙은 코어가 소유한다**(`soksak_core::control`). 여기 있는 것은 그 규칙을 소켓 뒤에
//! 세우는 배선과, 창을 가진 쪽에게 배달을 되묻는 통로뿐이다.
//!
//! 이 프로세스에는 창이 없다. 그래서 배달은 **창 호스트**가 한다 — 프레임워크가 부팅에서
//! `control_host_attach` 로 자기를 등록하면, 그 연결이 배달 통로가 된다. cored 는 그 연결로
//! 요청을 밀고, 프레임워크는 렌더러에 전하고, 결과를 `cmd_result` 로 되돌린다.
//!
//! 폴링이 아니다: 호스트가 붙어 있는 동안 cored 가 **밀고**, 붙지 않았으면 배달을 시도조차
//! 하지 않고 이름을 달고 거절한다. 조용히 기다리면 하니스가 "명령이 없다"로 읽는다.
//!
//! **호스트는 여럿이다.** 저장소를 쓰는 주인은 하나여야 하는데(단일 쓰기) 프레임워크는 둘이
//! 동시에 돈다. 그 둘을 세우는 길은 하나뿐이다 — 같은 cored 에 창 호스트로 둘 다 붙는다.
//! 그래서 여기서 창은 **어느 호스트의 것인지**까지가 사실이고, 배달은 그 호스트로만 간다.
//! 아무 호스트에나 밀면 남의 프레임워크 창에서 명령이 돌고 성공을 답한다.
//!
//! 포커스 장부는 **하나다**. 화면에서 포커스를 가진 창은 하나뿐이고, 호스트마다 장부를 두면
//! "마지막 워크스페이스"가 프레임워크 수만큼 갈린다.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use soksak_core::control::{self, FocusLedger, NoTarget};

/// 회신 대기 상한 기본값 — **규칙은 코어가 소유한다**(control::reply_wait_ms).
///
/// 값을 여기 다시 적으면 두 벌이고, 실제로 그랬다: 앱은 클램프했고 이 프로세스는 안 했다.
/// 같은 요청이 어느 프로세스를 지나느냐로 상한이 달라진다.
pub use soksak_core::control::DEFAULT_REPLY_WAIT_MS as DEFAULT_TIMEOUT_MS;

/// 붙어 있는 창 호스트 하나. 하나도 없으면 배달할 곳이 없다.
struct Host {
    /// 이 호스트의 이름 = 붙은 연결의 이름. 연결이 끝나면 이 이름으로 회수한다.
    conn_id: u64,
    /// 창으로 나가는 자리 — **연결 자신**이다. 사본 fd 로 쥐면 방송·배달이 그 연결의 답과
    /// 섞여 받는 쪽에 깨진 줄이 된다(wire::Conn::write_line 머리말).
    writer: std::sync::Arc<crate::wire::Conn>,
    /// 이 호스트가 가진 창 라벨 — 호스트가 붙을 때와 창이 바뀔 때 알려 준다.
    live: Vec<String>,
}

static HOSTS: OnceLock<Mutex<Vec<Host>>> = OnceLock::new();
/// 포커스 사실. **장부는 코어의 것이다**(FocusLedger) — "마지막 워크스페이스"를 무엇으로
/// 볼지는 규칙이고, 창을 가진 쪽이 그것을 계산해 보내면 그 규칙이 두 벌이 된다.
/// 호스트는 라벨 하나만 말한다: "지금 이 창이 포커스다." 장부는 호스트 수와 무관하게 하나다.
static FOCUS: OnceLock<Mutex<FocusLedger>> = OnceLock::new();
/// 배달한 요청의 회신을 기다리는 자리 — id → 보내는 쪽.
static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Value>>>> = OnceLock::new();
/// 배달 상관 id. **앱과 같은 축(u64 seq)이다** — 창 쪽 실행기는 받은 id 를 그대로 되울리므로,
/// 여기서 다른 모양(문자열 등)을 쓰면 cmd_result 의 인자 타입이 프로세스마다 갈린다.
static SEQ: OnceLock<Mutex<u64>> = OnceLock::new();

fn hosts() -> &'static Mutex<Vec<Host>> {
    HOSTS.get_or_init(|| Mutex::new(Vec::new()))
}
/// 마지막으로 포커스했던 워크스페이스 창. 붙은 호스트가 자기 창 사실을 보고할 때 갱신된다.
///
/// None 은 "워크스페이스 창을 포커스한 적 없다"는 뜻이다 — 붙은 호스트가 없어서 모르는 것과
/// 구분되지 않으므로, 부르는 쪽이 그 차이를 알아야 하면 호스트 유무를 따로 물어야 한다.
pub fn last_workspace_window() -> Option<String> {
    focus()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_workspace()
        .map(|s| s.to_string())
}

fn focus() -> &'static Mutex<FocusLedger> {
    FOCUS.get_or_init(|| Mutex::new(FocusLedger::new()))
}

/// 창 목록은 호스트들의 **합집합**이다. 한 호스트의 목록만으로 판정하면 다른 프레임워크의
/// 멀쩡한 창이 "창 없음"이 된다.
fn union_live(hs: &[Host]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in hs {
        for l in &h.live {
            if !out.iter().any(|x| x == l) {
                out.push(l.clone());
            }
        }
    }
    out
}
/// 지금 붙어 있는 창들 — **라벨마다 그 라벨을 든 호스트 수와 함께.**
///
/// 합쳐서 하나로 답하지 않는다. 창 복원은 라벨을 새로 만들지 않고 저장된 `w-<uuid>` 를
/// 되쓰므로(NAMING 4b), 한 홈을 두 프레임워크가 보면 같은 슬롯을 각자 되살려 라벨이 겹친다.
/// 그때 목록이 하나로 답하면 부른 쪽은 창이 하나라고 읽고, 그 위에 세운 판단이 전부 틀린다 —
/// **어느 창인지 못 고르는 것과 창이 하나인 것은 다른 사실이다.**
///
/// 배달은 이미 이 겹침을 이름으로 거절한다(AMBIGUOUS_HOST). 이 자리는 그 거절을 **보기 전에**
/// 알 수 있게 하는 관측면이다: 부른 쪽이 실패로 배우지 않아도 된다.
pub fn window_census() -> Vec<soksak_core::window_census::WindowRow> {
    let g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    let f = focus().lock().unwrap_or_else(|e| e.into_inner());
    let focused = f.focused().to_string();
    // 모양은 코어가 소유한다 — 만드는 쪽이 둘이라(cored·홀로 도는 프레임워크) 여기서 손으로
    // 적으면 두 벌이 되고, 갈리면 소비자 한쪽에서만 조용히 파싱이 빈다.
    soksak_core::window_census::fold(
        g.iter()
            .flat_map(|h| soksak_core::window_census::of_labels(&h.live, Some(&focused))),
    )
}

fn pending() -> &'static Mutex<HashMap<u64, Sender<Value>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    let m = SEQ.get_or_init(|| Mutex::new(0));
    let mut n = m.lock().unwrap_or_else(|e| e.into_inner());
    *n += 1;
    *n
}

/// 배달할 곳이 있는가. 하나도 없으면 소켓 표면은 지금까지처럼 이름을 달고 거절한다.
pub fn has_host() -> bool {
    !hosts().lock().unwrap_or_else(|e| e.into_inner()).is_empty()
}

/// 프레임워크가 자기를 창 호스트로 등록한다. 이 연결이 그 프레임워크의 배달 통로가 된다.
///
/// 같은 연결이 다시 등록하면 덮는다(재부팅한 호스트가 같은 연결을 쓰는 경우). 다른 연결이면
/// **더한다** — 이미 붙은 호스트를 밀어내지 않는다. 밀어내면 그쪽 창이 통째로 주소를 잃는다.
pub fn attach_host(writer: std::sync::Arc<crate::wire::Conn>, live: Vec<String>, focused: String) {
    let id = writer.id();
    let mut g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    match g.iter_mut().find(|h| h.conn_id == id) {
        Some(h) => {
            h.writer = writer;
            h.live = live;
        }
        None => g.push(Host { conn_id: id, writer, live }),
    }
    let union = union_live(&g);
    let mut f = focus().lock().unwrap_or_else(|e| e.into_inner());
    f.note_focus(&focused);
    f.reconcile(&union);
}

/// 연결이 끝났다 — 그 호스트를 장부에서 지운다. 없는 이름이면 조용히 지나간다(호스트로 붙지
/// 않은 연결도 이 길을 지난다).
pub fn detach_host(conn_id: u64) {
    let mut g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    let before = g.len();
    g.retain(|h| h.conn_id != conn_id);
    if g.len() != before {
        let union = union_live(&g);
        focus()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconcile(&union);
    }
}

/// 창 사실이 바뀌었다 — 그 호스트가 알려 준다. 낡은 목록으로 타겟을 고르면 죽은 창에 배달한다.
///
/// 사라진 창은 목록으로 낫는다(reconcile). 창 하나가 닫혔다는 사건을 놓쳐도 다음 보고에서
/// 회복되도록 **멱등**이다 — 사건을 세는 방식이면 놓친 하나가 영영 남는다.
///
/// 보고는 **자기 창에 대해서만**이다. 한 호스트의 목록으로 전체를 갈면 다른 프레임워크의
/// 창이 그 보고 한 번에 전부 사라진다.
pub fn update_windows(conn_id: u64, live: Vec<String>, focused: String) -> bool {
    let mut g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    let Some(h) = g.iter_mut().find(|h| h.conn_id == conn_id) else {
        return false;
    };
    h.live = live;
    let union = union_live(&g);
    let mut f = focus().lock().unwrap_or_else(|e| e.into_inner());
    f.note_focus(&focused);
    f.reconcile(&union);
    true
}

/// 렌더러의 회신이 도착했다. 짝이 없으면 조용히 버린다 — 이미 상한에서 끝난 늦은 회신이고,
/// 그것은 오류가 아니다. 오류로 만들면 정상 경로가 로그를 물들인다.
pub fn deliver_result(id: u64, result: Value) -> bool {
    // 자리를 **걷지 않고** 보낸다. 한 배달이 여러 호스트로 갔으면 답도 여럿이고, 첫 답에
    // 자리를 걷으면 나머지는 "짝 없는 늦은 회신"으로 버려진다 — 부른 쪽은 하나만 돈 것으로
    // 읽는다. 자리를 거두는 것은 기다림이 끝나는 쪽의 일이다(거기서 한 번만 거둔다).
    let p = pending().lock().unwrap_or_else(|e| e.into_inner());
    match p.get(&id) {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
}

/// 사건 하나를 창 전부에 뿌린다 — 짝 없는 밀어내기다(요청의 답이 아니다).
///
/// 이 프로세스에는 창이 없다. 그래서 파일 변경·데몬 사망처럼 **누구에게랄 것 없는 사실**은
/// 창을 가진 쪽에 넘겨 뿌리게 한다. 반환 = 넘겼는가.
///
/// 배달(`deliver`)과 다른 키를 쓴다: 배달은 답을 기다리는 요청이고 이것은 답이 없다. 같은
/// 키로 보내면 받는 쪽이 회신할 자리를 찾다가 없는 id 로 cmd_result 를 부른다.
pub fn broadcast(event: &str, payload: Value) -> bool {
    push_to_all(&json!({ "broadcast": { "event": event, "payload": payload } }))
}

/// 밖에서 온 한 줄을 처리해 답 한 줄을 만든다.
pub fn answer(line: &str) -> Value {
    let req = match control::parse(line) {
        Ok(r) => r,
        // 연결을 끊지 않는다 — 끊으면 부른 쪽이 "앱이 죽었다"로 읽는다.
        Err(why) => return json!({ "ok": false, "code": "BAD_REQUEST", "message": why }),
    };
    let echo = req.id.clone();
    let reply = route(req);
    match echo {
        Some(id) => merge_id(reply, id),
        None => reply,
    }
}

fn merge_id(mut v: Value, id: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("id".into(), id);
    }
    v
}

fn route(req: control::Request) -> Value {
    let live = {
        let g = hosts().lock().unwrap_or_else(|e| e.into_inner());
        if g.is_empty() {
            return json!({
                "ok": false,
                "code": "NO_HOST",
                "message": "창을 가진 쪽이 붙지 않았다 — 배달할 곳이 없다"
            });
        }
        union_live(&g)
    };
    let (focused, last_ws) = {
        let f = focus().lock().unwrap_or_else(|e| e.into_inner());
        (f.focused().to_string(), f.last_workspace().map(|s| s.to_string()))
    };

    // 창을 지목했으면 그 창이어야 한다. 없는데 아무 창에나 보내면 남의 창에서 명령이 돌고
    // 성공을 답한다 — 그 오답은 오류로 보이지 않는다.
    let target = match req.window.as_deref() {
        Some(w) if live.iter().any(|l| l == w) => w.to_string(),
        Some(w) => {
            return json!({
                "ok": false, "code": "WINDOW_NOT_FOUND", "message": format!("창 없음: {w}")
            })
        }
        None => match control::resolve_target(&req.method, &focused, last_ws.as_deref(), &live) {
            Ok(t) => t,
            Err(e) => {
                let windows = match &e {
                    NoTarget::Ambiguous(c) => c.clone(),
                    _ => Vec::new(),
                };
                return json!({
                    "ok": false,
                    "code": e.code(),
                    "message": format!("타겟 창을 정하지 못했다: {}", e.code()),
                    "windows": windows,
                });
            }
        },
    };

    let id = next_id();
    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);

    // 봉투는 코어가 만든다 — 여기서 리터럴로 적으면 필드를 빠뜨려도 오류가 안 나고, 빠진
    // 값은 실패가 아니라 소멸한다(soksak_core::control::deliver_envelope 머리말).
    let push = soksak_core::control::deliver_envelope(id, &req, &target);
    // 그 창을 가진 호스트로만 민다. 아무 호스트에나 밀면 남의 프레임워크 창에서 명령이 돌고
    // 성공을 답한다 — 그 오답은 오류로 보이지 않는다.
    // 그 이름을 든 **전부**에게 민다.
    //
    // 겹침은 우연이 아니다: `main` 은 오케스트레이터 역할이라 앱 프로세스마다 하나씩 있고,
    // 워크스페이스 창은 저장된 `w-<uuid>` 를 의도적으로 되쓴다(NAMING 4b). 한때 여기서 겹치면
    // 거절했는데, 그러면 두 앱을 함께 켠 순간 **어느 쪽 오케스트레이터도 밖에서 못 부른다**
    // (실측 2026-08-01: 저장소 조회조차 막혔다). 고르지 않는다는 판단은 옳고 결론이 틀렸다 —
    // 고를 수 없으면 전부에게 보낸다. 하나만 원하는 부름은 유일한 주소를 쓰면 된다.
    let sent = match push_to_owner(&target, &push) {
        Delivered::To(n) => n,
        Delivered::NoOwner => {
            pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return json!({
                "ok": false, "code": "DELIVER_FAILED",
                "message": format!("창 호스트에 배달하지 못했다: {target}")
            });
        }
    };

    // 무한대기 금지도 규칙의 일부다 — 접지 않으면 답 안 하는 창 하나가 이 연결을 영원히 붙잡는다.
    let wait = Duration::from_millis(control::reply_wait_ms(req.timeout_ms));
    // 여럿에게 보냈으면 **여럿의 답**을 모은다. 첫 답만 돌리면 나머지가 어디로 갔는지 아무도
    // 모르고, 부른 쪽은 하나만 돈 것으로 읽는다.
    if sent > 1 {
        let mut answers = Vec::with_capacity(sent);
        let until = std::time::Instant::now() + wait;
        while answers.len() < sent {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(v) => answers.push(v),
                Err(_) => break,
            }
        }
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return json!({
            "ok": true,
            "data": { "hosts": sent, "answers": answers },
        });
    }
    let single = rx.recv_timeout(wait);
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match single {
        Ok(v) => v,
        Err(_) => {
            // 상한이 없으면 답하지 않는 창 하나가 그 연결을 영원히 붙잡는다.
            json!({
                "ok": false, "code": "TIMEOUT",
                "message": format!("회신 없음({}ms): {}", wait.as_millis(), req.method)
            })
        }
    }
}

/// 배달을 시도한 결과. "못 했다"를 한 가지로 뭉치면 부른 쪽이 사유를 못 듣는다.
enum Delivered {
    /// 이만큼의 주인에게 갔다(하나 이상).
    To(usize),
    /// 그 라벨을 든 호스트가 없다(또는 쓰기가 전부 실패했다).
    NoOwner,
}

/// 이 창을 가진 호스트에게만 민다.
///
/// 주인이 둘이면 고르지 않는다. 첫 매치를 고르면 남의 프레임워크 창에서 명령이 돌고 성공을
/// 답한다 — 그 오답은 오류로 보이지 않는다. 그리고 그 라벨은 PTY 재접속 키이기도 해서,
/// 조용히 고른 결과가 남의 셸에 닿는다.
///
/// 겹침은 우연이 아니다: 창 복원은 라벨을 새로 만들지 않고 저장된 `w-<uuid>` 를 의도적으로
/// 되쓴다(NAMING 4b). 한 홈을 두 프레임워크가 보면 같은 슬롯을 각자 되살린다.
fn push_to_owner(label: &str, v: &Value) -> Delivered {
    let g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    let mut sent = 0usize;
    for h in g.iter().filter(|h| h.live.iter().any(|l| l == label)) {
        if h.writer.write_line(&v.to_string()) {
            sent += 1;
        }
    }
    if sent == 0 {
        Delivered::NoOwner
    } else {
        Delivered::To(sent)
    }
}

/// 창을 가진 쪽 **전부**에게 민다. 하나라도 받았으면 넘긴 것이다.
///
/// 실패한 호스트를 여기서 지우지 않는다 — 회수는 연결이 끝나는 자리(`Conn::release`)의 일이고,
/// 쓰기 한 번 실패를 죽음으로 읽으면 잠깐 막힌 소켓이 멀쩡한 호스트를 장부에서 지운다.
fn push_to_all(v: &Value) -> bool {
    let g = hosts().lock().unwrap_or_else(|e| e.into_inner());
    let line = v.to_string();
    let mut any = false;
    for h in g.iter() {
        any |= h.writer.write_line(&line);
    }
    any
}

/// 검사용 직렬화. **호스트 장부는 프로세스 전역이다** — 그래서 호스트를 만지는 검사는
/// 서로를 덮는다. wire 의 거절 검사도 여기 걸린다: 호스트가 붙어 있으면 모르는 이름은
/// 거절이 아니라 배달이 되고, 그 실패는 무작위로 나타난다.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::os::unix::net::UnixStream;

    pub static SERIAL: Mutex<()> = Mutex::new(());

    pub fn lock() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 읽기 상한. 호스트가 둘이면 **한쪽에는 오지 않는 것이 정답**인 검사가 생긴다 —
    /// 상한이 없으면 그 정답이 무한 대기로 나타나고, 실패가 아니라 멈춤이 된다.
    const READ_LIMIT: Duration = Duration::from_secs(2);

    /// 창 호스트를 흉내낸다 — 한쪽 끝을 cored 에 주고, 다른 끝에서 배달을 읽는다.
    pub fn fake_host(live: &[&str], focused: &str) -> std::io::BufReader<UnixStream> {
        fake_host_id(live, focused).1
    }

    /// 붙은 호스트의 이름까지 준다 — 창 사실 갱신은 **어느 호스트가 말하는지**가 인자다.
    pub fn fake_host_id(
        live: &[&str],
        focused: &str,
    ) -> (u64, std::io::BufReader<UnixStream>) {
        let (a, b) = UnixStream::pair().expect("소켓 쌍");
        b.set_read_timeout(Some(READ_LIMIT)).expect("읽기 상한");
        let conn = std::sync::Arc::new(crate::wire::Conn::new(a));
        let id = conn.id();
        attach_host(conn, live.iter().map(|s| s.to_string()).collect(), focused.to_string());
        (id, std::io::BufReader::new(b))
    }

    /// 이 호스트에는 아무것도 오지 않아야 한다. 상한까지 기다려 확인한다 —
    /// "안 왔다"를 즉시 단언하면 아직 안 온 것과 오지 않을 것을 구분하지 못한다.
    pub fn nothing_arrives(r: &mut std::io::BufReader<UnixStream>, who: &str) {
        use std::io::BufRead;
        let mut line = String::new();
        match r.read_line(&mut line) {
            Ok(0) => {}
            Ok(_) => panic!("{who} 에 오면 안 되는 것이 왔다: {line}"),
            Err(_) => {} // 상한 — 오지 않았다
        }
    }

    /// 호스트 없는 상태로 되돌린다 — 검사 하나가 남긴 호스트가 다음 검사의 전제를 바꾼다.
    /// 포커스 장부도 함께 비운다: 장부는 전역이라 남으면 다음 검사의 타겟 해소가 달라진다.
    pub fn detach() {
        hosts().lock().unwrap_or_else(|e| e.into_inner()).clear();
        *focus().lock().unwrap_or_else(|e| e.into_inner()) = FocusLedger::new();
        pending().lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
