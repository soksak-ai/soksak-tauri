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

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use soksak_core::control::{self, FocusLedger, NoTarget};

/// 회신 대기 상한 기본값. 원본과 같다 — 느린 명령은 요청이 timeoutMs 로 늘린다.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// 붙어 있는 창 호스트. 없으면 배달할 곳이 없다.
struct Host {
    writer: UnixStream,
    /// 살아 있는 창 라벨 — 호스트가 붙을 때와 창이 바뀔 때 알려 준다.
    live: Vec<String>,
    /// 포커스 사실. **장부는 코어의 것이다**(FocusLedger) — "마지막 워크스페이스"를 무엇으로
    /// 볼지는 규칙이고, 창을 가진 쪽이 그것을 계산해 보내면 그 규칙이 두 벌이 된다.
    /// 호스트는 라벨 하나만 말한다: "지금 이 창이 포커스다."
    focus: FocusLedger,
}

static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
/// 배달한 요청의 회신을 기다리는 자리 — id → 보내는 쪽.
static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Value>>>> = OnceLock::new();
/// 배달 상관 id. **앱과 같은 축(u64 seq)이다** — 창 쪽 실행기는 받은 id 를 그대로 되울리므로,
/// 여기서 다른 모양(문자열 등)을 쓰면 cmd_result 의 인자 타입이 프로세스마다 갈린다.
static SEQ: OnceLock<Mutex<u64>> = OnceLock::new();

fn host() -> &'static Mutex<Option<Host>> {
    HOST.get_or_init(|| Mutex::new(None))
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

/// 배달할 곳이 있는가. 없으면 소켓 표면은 지금까지처럼 이름을 달고 거절한다.
pub fn has_host() -> bool {
    host().lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// 프레임워크가 자기를 창 호스트로 등록한다. 이 연결이 배달 통로가 된다.
pub fn attach_host(writer: UnixStream, live: Vec<String>, focused: String) {
    let mut focus = FocusLedger::new();
    focus.note_focus(&focused);
    focus.reconcile(&live);
    let mut g = host().lock().unwrap_or_else(|e| e.into_inner());
    *g = Some(Host { writer, live, focus });
}

/// 창 사실이 바뀌었다 — 호스트가 알려 준다. 낡은 목록으로 타겟을 고르면 죽은 창에 배달한다.
///
/// 사라진 창은 목록으로 낫는다(reconcile). 창 하나가 닫혔다는 사건을 놓쳐도 다음 보고에서
/// 회복되도록 **멱등**이다 — 사건을 세는 방식이면 놓친 하나가 영영 남는다.
pub fn update_windows(live: Vec<String>, focused: String) -> bool {
    let mut g = host().lock().unwrap_or_else(|e| e.into_inner());
    match g.as_mut() {
        Some(h) => {
            h.focus.note_focus(&focused);
            h.focus.reconcile(&live);
            h.live = live;
            true
        }
        None => false,
    }
}

/// 렌더러의 회신이 도착했다. 짝이 없으면 조용히 버린다 — 이미 상한에서 끝난 늦은 회신이고,
/// 그것은 오류가 아니다. 오류로 만들면 정상 경로가 로그를 물들인다.
pub fn deliver_result(id: u64, result: Value) -> bool {
    let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
    match p.remove(&id) {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
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
    let (live, focused, last_ws) = {
        let g = host().lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some(h) => (
                h.live.clone(),
                h.focus.focused().to_string(),
                h.focus.last_workspace().map(|s| s.to_string()),
            ),
            None => {
                return json!({
                    "ok": false,
                    "code": "NO_HOST",
                    "message": "창을 가진 쪽이 붙지 않았다 — 배달할 곳이 없다"
                })
            }
        }
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

    let push = json!({
        "deliver": {
            "id": id, "method": req.method, "params": req.params,
            "pane": req.pane, "window": target,
        }
    });
    if !push_to_host(&push) {
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return json!({
            "ok": false, "code": "DELIVER_FAILED",
            "message": format!("창 호스트에 배달하지 못했다: {target}")
        });
    }

    let wait = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    match rx.recv_timeout(wait) {
        Ok(v) => v,
        Err(_) => {
            pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            // 상한이 없으면 답하지 않는 창 하나가 그 연결을 영원히 붙잡는다.
            json!({
                "ok": false, "code": "TIMEOUT",
                "message": format!("회신 없음({}ms): {}", wait.as_millis(), req.method)
            })
        }
    }
}

fn push_to_host(v: &Value) -> bool {
    let mut g = host().lock().unwrap_or_else(|e| e.into_inner());
    match g.as_mut() {
        Some(h) => writeln!(h.writer, "{v}").is_ok(),
        None => false,
    }
}

/// 검사용 직렬화. **호스트는 프로세스 전역이다**(cored 하나에 창 호스트 하나) — 그래서
/// 호스트를 만지는 검사는 서로를 덮는다. wire 의 거절 검사도 여기 걸린다: 호스트가 붙어
/// 있으면 모르는 이름은 거절이 아니라 배달이 되고, 그 실패는 무작위로 나타난다.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub static SERIAL: Mutex<()> = Mutex::new(());

    pub fn lock() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 호스트 없는 상태로 되돌린다 — 검사 하나가 남긴 호스트가 다음 검사의 전제를 바꾼다.
    pub fn detach() {
        *host().lock().unwrap_or_else(|e| e.into_inner()) = None;
        pending().lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
