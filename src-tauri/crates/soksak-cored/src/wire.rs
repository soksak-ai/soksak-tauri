//! 소켓 표면 — 요청 한 줄을 응답 한 줄로.
//!
//! 봉투와 판 협상은 앱 소켓과 **같은 계약**이다(soksak-spec-socket). 판 상수를 여기 베끼면
//! 두 프로세스가 서로 다른 숫자를 말하게 된다 — 크레이트에서 읽는다.
//!
//! 봉투는 `{ok, code, message, data}` 이고, `data` 에는 앱의 `invoke` 가 돌려주는 값이
//! **그대로** 실린다. 프레임워크 어댑터는 `data` 를 벗겨 invoke 의 약속에 그대로 얹으면 된다 —
//! cored 를 거쳤다고 값의 모양이 달라지지 않는다.

use serde::Deserialize;
use serde_json::{json, Value};
use soksak_spec_socket::{
    effective_protocol, evaluate_compat, skew_sentence, Lang, MIN_COMPATIBLE_CLIENT_PROTOCOL,
    SOCKET_PROTOCOL_VERSION,
};

use std::io::Write;
use std::sync::Mutex;

use crate::ctx::Ctx;
use crate::registry::{self, Outcome};

/// 요청. 앱 소켓의 요청에서 **창 관련 필드를 뺀 것**이다 — cored 에는 창이 없다.
/// 모르는 필드는 무시한다(계약의 추가-필드 규칙): 창을 실어 보내는 프레임워크도 거절당하지 않는다.
#[derive(Deserialize)]
pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub protocol: Option<u32>,
}

pub fn ok_reply(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

pub fn err_reply(code: &str, message: &str) -> Value {
    json!({ "ok": false, "code": code, "message": message })
}

/// 이 프로세스 기동 시각(ms) — 부팅에서 한 번 정해진다. hello 의 startedAt.
static STARTED_AT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn started_at_ms() -> u64 {
    *STARTED_AT.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// 이 프로세스가 무엇인지 — 판 숫자는 계약 크레이트에서, 신원은 부팅 인자에서.
///
/// **앱과 같은 축을 답한다.** 부르는 쪽은 규약이 아니라 답으로 위상을 안다 — 축이 빠지면 그
/// 클라이언트는 두 소켓에 서로 다른 코드를 써야 하고, 그것이 두 번째 진실이다.
///
/// `framework` 만 없다. 이 프로세스에는 프레임워크가 없고, 모르는 것을 말하지 않는 것이 이
/// 축의 규칙이다 — `role: "cored"` 가 그 사실을 이미 말한다.
fn hello_facts(ctx: &Ctx) -> Value {
    json!({
        "protocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        // 버전은 이 실행물의 것이다 — 앱의 appVersion 과 같은 자리에, 이 프로세스의 사실로.
        "appVersion": env!("CARGO_PKG_VERSION"),
        "identity": ctx.identity().identifier(),
        "pid": std::process::id(),
        "startedAt": started_at_ms(),
        "role": "cored",
        "backend": env!("CARGO_PKG_NAME"),
        "backendVersion": env!("CARGO_PKG_VERSION"),
        // 전송층 행위만 싣는다 — 기능 발견은 cored.commands 가 정본이다.
        "capabilities": ["hello.v1"],
    })
}

/// transport 즉답 — 명령 표에 닿기 전에 답이 정해지는 것들.
/// ① system.hello: 스큐 게이트 면제. 스큐된 클라이언트가 두 판 숫자를 배울 유일한 통로다.
/// ② VERSION_SKEW: 호환창 밖 요청은 명령을 실행하지 않는다.
fn transport_route(ctx: &Ctx, req: &Request) -> Option<Value> {
    if req.method == "system.hello" {
        let mut reply = hello_facts(ctx);
        if let Some(obj) = reply.as_object_mut() {
            obj.insert("ok".into(), json!(true));
        }
        return Some(reply);
    }
    let declared = effective_protocol(req.protocol);
    let verdict = evaluate_compat(
        SOCKET_PROTOCOL_VERSION,
        MIN_COMPATIBLE_CLIENT_PROTOCOL,
        declared,
    );
    // 이 시선은 cored 가 클라이언트를 판정한다 — self=cored, peer=클라이언트. 문장은 기계가
    // 읽는 자리라 영어로 둔다(사람 언어 해소는 이 문장을 사람에게 보이는 쪽의 몫이다).
    let sentence = skew_sentence(
        verdict,
        "this helper",
        "the client",
        Some("run the helper shipped with this client"),
        Lang::En,
    )?;
    let mut reply = err_reply("VERSION_SKEW", &sentence);
    reply["data"] = json!({
        // 이름은 앱과 같다. 뜻은 "지금 말하고 있는 서버의 판"이고, 어느 서버인지는 hello 의
        // role 이 말한다 — 같은 사실에 이름이 둘이면 클라이언트가 두 소켓에 두 코드를 쓴다.
        // 사람이 읽는 문장은 갈려도 된다("this helper" vs "this app"); 기계가 읽는 자리는 아니다.
        "appProtocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        "clientProtocol": declared,
    });
    Some(reply)
}

/// 서빙하지 않는 이름의 사유 문장. 감사해서 "여기서는 못 한다"고 판정한 이름은 그 이유를
/// 함께 말한다 — 이유 없는 금지는 우회 대상이 되고, 프레임워크 저자는 막힌 것을 다시 조사하거나
/// 더 나쁘게는 조사 없이 흉내를 낸다.
/// **코드가 둘을 가른다.** 한때 둘 다 UNKNOWN_COMMAND 였는데, 사유는 message 에만 실리고
/// 기계는 코드만 본다 — 요구 원장이 코드를 기록하므로(invoke-demand.jsonl) 감사해서 거절한
/// 것과 이름이 없는 것이 한 통에 섞였다. "아직 안 옮겼다"와 "여기서는 못 한다"를 세는 사람이
/// 그 차이를 잃는다(실측 2026-07-29: 사유가 등재된 넷이 미등재와 같은 코드로 나왔다).
fn refusal(method: &str) -> (&'static str, String) {
    match registry::unserved(method) {
        Some(u) => (
            "REFUSED_BY_AUDIT",
            format!("{method} 은(는) 이 프로세스가 서빙하지 않습니다 — {}", u.blocked_by),
        ),
        None => (
            "UNKNOWN_COMMAND",
            format!("{method} 은(는) 이 프로세스가 서빙하지 않습니다 — cored.commands 로 목록을 확인하세요"),
        ),
    }
}

/// 명령 하나를 실행한다. 표에 없으면 **창을 가진 쪽에 배달한다** — 붙은 호스트가 없을 때만
/// 이름을 달고 실패한다. 조용한 no-op 도, 가짜 성공도 없다.
///
/// 이 갈래가 소켓을 하나로 만든다: 부르는 쪽은 어느 명령을 누가 답하는지 몰라도 된다.
/// cored 가 서빙하면 cored 가 답하고, 아니면 창이 답한다 — 봉투는 같다.
#[cfg(unix)]
type ConnRef<'a> = Option<&'a Conn>;
#[cfg(not(unix))]
type ConnRef<'a> = Option<&'a ()>;

fn route(ctx: &Ctx, req: &Request, line: &str, conn: ConnRef<'_>) -> Value {
    if req.method == "cored.commands" {
        return ok_reply(registry::declaration());
    }
    let Some(cmd) = registry::find(&req.method) else {
        // 창의 다리로 온 것은 창으로 되돌리지 않는다 — 물어본 그 창에 배달되어 상한까지 침묵한다.
        let bridge = is_bridge_conn(conn);
        if crate::control::has_host() && !bridge {
            return crate::control::answer(line);
        }
        if bridge {
            return err_reply(
                "NOT_SERVED_HERE",
                &format!(
                    "{} 은(는) 이 프로세스가 서빙하지 않습니다 — 창의 다리로 온 요청이라 창으로 되돌리지 않습니다",
                    req.method
                ),
            );
        }
        let (code, message) = refusal(&req.method);
        return err_reply(code, &message);
    };
    CURRENT.with(|c| c.set(conn.map(|c| c as *const _)));
    let out = (cmd.run)(ctx, &req.params);
    CURRENT.with(|c| c.set(None));
    match out {
        Outcome::Ok(data) => ok_reply(data),
        // 어느 명령의 인자가 틀렸는지 이름을 달고 말한다 — serde 의 사유만으로는 모른다.
        Outcome::InvalidParams(why) => {
            err_reply("INVALID_PARAMS", &format!("{} 인자: {why}", cmd.name))
        }
        Outcome::Failed(why) => err_reply("COMMAND_FAILED", &why),
    }
}

/// 연결 하나가 지고 가는 것 — **값이다.**
///
/// 한때 스레드 지역이었다("연결 하나 = 스레드 하나"). 그 전제가 요청을 직렬로 만들었다:
/// 느린 명령 하나가 같은 연결의 뒤를 전부 막고, 그 증상은 원인에서 한참 떨어져 보인다
/// (실측: 부팅에서 process_spawn 이 30초 상한까지 답을 못 받았는데 직접 부르면 3ms 였다).
///
/// 프로토콜에 id 가 있는 것은 한 연결에 요청을 겹쳐도 짝이 정해진다는 약속이다. 값으로 지고
/// 가면 요청마다 다른 스레드가 답해도 그 약속이 선다.
#[cfg(unix)]
pub struct Conn {
    /// 답을 쓰는 자리. 한 줄이 통째로 나가야 한다 — 여럿이 동시에 쓰면 줄이 섞여 받는 쪽이
    /// 파싱에서 처음 깨진다.
    writer: Mutex<std::os::unix::net::UnixStream>,
    /// 이 연결은 창의 자기 다리인가. 다리로 온 것은 창으로 되돌리지 않는다 — 물어본 그 창에
    /// 배달되어 회신할 자리가 없다.
    bridge: std::sync::atomic::AtomicBool,
    /// 이 연결이 만든 스트림 토큰. 연결이 끝나면 함께 끝난다(죽은 소켓에 계속 쓰지 않는다).
    owned: Mutex<Vec<String>>,
}

#[cfg(unix)]
impl Conn {
    pub fn new(stream: std::os::unix::net::UnixStream) -> Self {
        Conn {
            writer: Mutex::new(stream),
            bridge: std::sync::atomic::AtomicBool::new(false),
            owned: Mutex::new(Vec::new()),
        }
    }

    /// 답 한 줄. 줄 단위로 잠근다 — 섞이면 받는 쪽이 파싱에서 처음 깨진다.
    pub fn reply(&self, v: &Value) -> bool {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writeln!(w, "{v}").is_ok()
    }

    /// 이 연결의 사본 — 배달 통로 등록·스트림 매기가 쓴다.
    pub fn dup(&self) -> Option<std::os::unix::net::UnixStream> {
        self.writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_clone()
            .ok()
    }

    pub fn mark_bridge(&self) {
        self.bridge.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_bridge(&self) -> bool {
        self.bridge.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 연결이 끝났다 — 이 연결이 만든 스트림도 끝난다.
    pub fn release(&self) {
        let mut v = self.owned.lock().unwrap_or_else(|e| e.into_inner());
        crate::streams::release_all(&v);
        v.clear();
    }
}

/// 이 연결에서 한 줄을 답한다. 스트림 토큰은 **실행 전에** 매인다 — 명령이 첫 프레임을 곧바로
/// 밀 수 있고, 그때 자리가 없으면 그 프레임은 조용히 사라진다.
#[cfg(unix)]
pub fn answer_on_conn(ctx: &Ctx, line: &str, conn: &Conn) -> Value {
    if let (Ok(req), Some(sink)) = (serde_json::from_str::<Request>(line), conn.dup()) {
        let bound = crate::streams::bind(&req.params, &sink);
        if !bound.is_empty() {
            conn.owned
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(bound);
        }
    }
    answer_with(ctx, line, Some(conn))
}

/// 한 줄 → 한 줄. 연결 없이도 전부 검증된다 — 부팅 상태는 인자이고, 이 함수가 전역을 읽으면
/// 테스트가 프로세스 하나에 갇힌다.
pub fn answer(ctx: &Ctx, line: &str) -> Value {
    answer_with(ctx, line, None)
}

fn answer_with(ctx: &Ctx, line: &str, conn: ConnRef<'_>) -> Value {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return err_reply("INVALID_PARAMS", &format!("JSON 파싱 실패: {e}")),
    };
    let mut reply = transport_route(ctx, &req).unwrap_or_else(|| route(ctx, &req, line, conn));
    if let (Some(id), Some(obj)) = (req.id.clone(), reply.as_object_mut()) {
        obj.insert("id".into(), id);
    }
    reply
}

// 지금 답하고 있는 **요청**의 연결. 요청 하나 = 스레드 하나라서 스레드 지역이 곧 요청이다.
// (연결 하나 = 스레드 하나였을 때 이 자리가 요청을 직렬로 만들었다 — 그때의 전제와 다르다.)
#[cfg(unix)]
thread_local! {
    static CURRENT: std::cell::Cell<Option<*const Conn>> = const { std::cell::Cell::new(None) };
}

#[cfg(unix)]
fn is_bridge_conn(conn: ConnRef<'_>) -> bool {
    conn.is_some_and(|c| c.is_bridge())
}

#[cfg(not(unix))]
fn is_bridge_conn(_conn: ConnRef<'_>) -> bool {
    false
}

/// 지금 답하고 있는 요청의 연결 사본. 연결을 지고 가야 하는 명령만 부른다(배달 통로 등록).
#[cfg(unix)]
pub fn current_conn() -> Option<std::os::unix::net::UnixStream> {
    CURRENT.with(|c| c.get()).and_then(|p| unsafe { &*p }.dup())
}

/// 이 연결은 창의 다리다 — 여기로 온 것은 창으로 되돌리지 않는다.
#[cfg(unix)]
pub fn mark_bridge() -> bool {
    match CURRENT.with(|c| c.get()) {
        Some(p) => {
            unsafe { &*p }.mark_bridge();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soksak_core::identity::Identity;

    /// 검증용 부팅 상태 — 어느 홈을 서빙하든 봉투·판 협상은 같아야 한다.
    fn ctx() -> Ctx {
        Ctx::new(Identity::new("/tmp/soksak-wire-test", "com.soksak.dev"))
    }

    #[test]
    fn a_broken_line_is_refused_not_ignored() {
        let reply = answer(&ctx(), "{not json");
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "INVALID_PARAMS");
    }

    #[test]
    fn an_unknown_method_names_itself() {
        // 붙은 호스트가 있으면 모르는 이름은 배달된다 — 그것이 이 표면의 설계다.
        // 여기서 재는 것은 **배달할 곳이 없을 때**의 답이다.
        let _serial = crate::control::testing::lock();
        crate::control::testing::detach();
        let reply = answer(&ctx(), r#"{"id":1,"method":"webview_dom_holes"}"#);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "UNKNOWN_COMMAND");
        assert!(
            reply["message"].as_str().unwrap().contains("webview_dom_holes"),
            "{reply}"
        );
        assert_eq!(reply["id"], 1, "실패해도 id 는 되돌아온다");
    }

    #[test]
    fn hello_is_answered_before_the_command_table() {
        let reply = answer(&ctx(), r#"{"id":"h","method":"system.hello"}"#);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["protocol"], SOCKET_PROTOCOL_VERSION);
        assert_eq!(reply["role"], "cored");
        assert_eq!(reply["id"], "h");
    }

    // 스큐된 클라이언트도 hello 로는 숫자를 배울 수 있어야 한다 — 그렇지 않으면
    // 판이 어긋났다는 사실 자체를 알 길이 없다.
    #[test]
    fn hello_is_exempt_from_the_skew_gate() {
        let line = format!(
            r#"{{"method":"system.hello","protocol":{}}}"#,
            SOCKET_PROTOCOL_VERSION + 5
        );
        assert_eq!(answer(&ctx(), &line)["ok"], true);
    }

    #[test]
    fn a_future_client_never_reaches_the_command() {
        let line = format!(
            r#"{{"id":2,"method":"binary_integrity","protocol":{},"params":{{"binPath":"/x","libPath":"/y"}}}}"#,
            SOCKET_PROTOCOL_VERSION + 1
        );
        let reply = answer(&ctx(), &line);
        assert_eq!(reply["code"], "VERSION_SKEW", "{reply}");
        assert_eq!(reply["data"]["clientProtocol"], SOCKET_PROTOCOL_VERSION + 1);
    }

    // 판을 선언하지 않는 클라이언트는 레거시(부재=0)로 통과한다 — 앱 소켓과 같은 규칙.
    #[test]
    fn a_client_that_declares_nothing_still_passes() {
        let reply = answer(&ctx(), r#"{"method":"binary_integrity","params":{"binPath":"/x","libPath":"/y"}}"#);
        assert_eq!(reply["ok"], true, "{reply}");
    }

    #[test]
    fn bad_arguments_name_the_command() {
        let reply = answer(&ctx(), r#"{"method":"binary_integrity","params":{"binPath":5}}"#);
        assert_eq!(reply["code"], "INVALID_PARAMS", "{reply}");
        assert!(
            reply["message"].as_str().unwrap().contains("binary_integrity"),
            "{reply}"
        );
    }

    // 봉투만 cored 의 것이고 `data` 는 앱 invoke 의 값 그대로다. 이게 깨지면 프레임워크 어댑터가
    // 값을 다시 조립해야 하고, 그 조립이 두 경로의 답을 가른다.
    #[test]
    fn data_carries_the_raw_invoke_value() {
        let reply = answer(
            &ctx(),
            r#"{"method":"binary_integrity","params":{"binPath":"/nonexistent-xyz","libPath":"/nonexistent-xyz"}}"#,
        );
        assert_eq!(
            reply["data"],
            json!({ "present": false, "partial": false, "broken": false }),
            "{reply}"
        );
    }

    #[test]
    fn the_command_table_is_askable() {
        let reply = answer(&ctx(), r#"{"method":"cored.commands"}"#);
        assert_eq!(reply["ok"], true);
        assert!(!reply["data"]["commands"].as_array().unwrap().is_empty());
    }

    // id 가 없는 요청에 id 를 지어내지 않는다.
    #[test]
    fn an_absent_id_is_not_invented() {
        let reply = answer(&ctx(), r#"{"method":"cored.commands"}"#);
        assert!(reply.get("id").is_none(), "{reply}");
    }

/// 창의 **자기 다리**로 온 요청은 창으로 되돌리지 않는다.
///
/// 실측(2026-07-29): 렌더러가 `pty_pane_alive` 를 다리로 물었는데 cored 가 그 이름을 서빙하지
/// 않아 창으로 배달했고, 창의 실행기에는 그 이름이 없어 회신이 오지 않았다 — 부른 쪽은
/// UNKNOWN_COMMAND 대신 10초를 기다렸다. 되돌린 곳이 물어본 바로 그 창이었다.
/// (그 이름은 이제 서빙된다 — 여기서는 아직 서빙하지 않는 이름으로 같은 갈래를 잰다.)
///
/// 이름의 철자로 가르지 않는다(점 있음/없음). 사실은 **누가 물었는가**이고, 그것은 연결이 안다.
#[test]
fn a_request_from_the_windows_own_bridge_is_not_delivered_back() {
    let _serial = crate::control::testing::lock();
    let _h = crate::control::testing::fake_host(&["main"], "main");
    // 창의 다리가 자기를 밝힌다 — 이 연결로 온 것은 창이 물은 것이다.
    let (a, _b) = std::os::unix::net::UnixStream::pair().expect("소켓 쌍");
    let conn = Conn::new(a);
    conn.mark_bridge();
    let r = answer_with(
        &ctx(),
        r#"{"id":9,"method":"process_reclaim_window","timeoutMs":80}"#,
        Some(&conn),
    );
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_SERVED_HERE", "{r}");
    assert!(r["message"].as_str().unwrap().contains("process_reclaim_window"));
    crate::control::testing::detach();
}

/// 밝히지 않은 연결은 밖이다 — 그쪽 요청은 그대로 창으로 간다.
#[test]
fn an_outside_connection_still_reaches_the_window() {
    let _serial = crate::control::testing::lock();
    let mut h = crate::control::testing::fake_host(&["main"], "main");
    // 밝히지 않은 연결 — 연결이 없는 것과 같다(밖에서 온 것으로 친다).
    std::thread::spawn(|| {
        let _ = answer(&ctx(), r#"{"id":10,"method":"project.open","timeoutMs":300}"#);
    });
    let mut line = String::new();
    std::io::BufRead::read_line(&mut h, &mut line).expect("배달이 온다");
    assert!(line.contains("project.open"));
    crate::control::testing::detach();
}

}
