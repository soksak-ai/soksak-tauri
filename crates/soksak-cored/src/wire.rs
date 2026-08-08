//! 소켓 표면 — 요청 한 줄을 응답 한 줄로.
//!
//! 봉투와 판 협상은 앱 소켓과 **같은 계약**이다(soksak-spec-socket). 판 상수를 여기 베끼면
//! 두 프로세스가 서로 다른 숫자를 말하게 된다 — 크레이트에서 읽는다.
//!
//! 봉투는 `{ok, code, message, data}` 이고, `data` 에는 앱의 `invoke` 가 돌려주는 값이
//! **그대로** 실린다. 프레임워크 어댑터는 `data` 를 벗겨 invoke 의 약속에 그대로 얹으면 된다 —
//! cored 를 거쳤다고 값의 모양이 달라지지 않는다.

use serde_json::{json, Value};
use soksak_spec_socket::{
    effective_protocol, evaluate_compat, skew_sentence, Lang, MIN_COMPATIBLE_CLIENT_PROTOCOL,
    SOCKET_PROTOCOL_VERSION,
};

use std::io::Write;
use std::sync::Mutex;

use crate::ctx::Ctx;
use crate::registry::{self, Outcome};

/// 요청 — 봉투는 **계약 크레이트가 소유한다**(판 상수와 같은 규칙: 여기 베끼면 두 프로세스가
/// 다른 것을 말한다).
///
/// 이 프로세스가 안 읽는 필드도 있다(창이 없으므로 pane 은 지나갈 뿐이다). 안 읽는 것과 없는
/// 것은 다르다 — 필드 목록을 여기서 다시 적으면 그 차이가 사라지고, 한쪽에만 있는 필드는
/// 실패가 아니라 **소멸**한다(실측 2026-08-01: `parent` 가 그렇게 사라졌다).
pub use soksak_spec_socket::RequestEnvelope as Request;

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
/// 이 프로세스가 무엇인가 — 판·정체성·역할. 전송층이 선점 응답으로 쓰고, 이름으로 물어도
/// **같은 사실**이 나온다(두 벌이면 어느 쪽이 참인지 부른 쪽이 못 가린다).
pub fn hello_facts_of(ctx: &Ctx) -> Value {
    hello_facts(ctx)
}

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
/// 감사해서 서빙하지 않기로 한 이름인가 — 그렇다면 그 사유를 그대로 싣는다.
///
/// 감사 밖의 이름에는 답하지 않는다. 이 프로세스는 창의 카탈로그를 모르므로 "없는 명령"인지
/// 판정할 수 없고, 그 판정은 창이 붙었을 때 창이 한다.
fn audited_refusal(method: &str) -> Option<(&'static str, String)> {
    registry::unserved(method).map(|u| {
        (
            "REFUSED_BY_AUDIT",
            format!("{method} 은(는) 이 프로세스가 서빙하지 않습니다 — {}", u.blocked_by),
        )
    })
}

/// 이 줄이 **연결의 성질을 선언하는가.** 그렇다면 읽은 순서대로, 동시 처리 밖에서 세워야 한다.
///
/// 실측: 한 연결의 프레임은 각자 스레드로 간다(요청 하나 = 스레드 하나). 그래서 선언이 첫
/// 명령보다 먼저 **줄에 오르고도** 나중에 설 수 있다 — 그 창의 다리로 온 요청이 다리인 줄
/// 모른 채 그 창으로 배달되고, 회신할 자리가 없어 상한까지 침묵한다. 연결 하나 = 스레드
/// 하나였을 때는 읽기 순서가 곧 처리 순서라 이 틈이 없었다.
///
/// 선언은 요청이 아니라 **이 연결이 무엇인가**라서, 읽은 자리에서 즉시 서는 것이 옳다.
pub fn declares_connection(method: &str) -> bool {
    // 구독도 **이 연결이 무엇인가**의 선언이다 — 요청 하나가 아니라 이 연결이 이제부터 원장을
    // 받는다는 사실이라, 읽은 자리에서 즉시 서야 그 뒤에 적히는 것을 하나도 안 놓친다.
    matches!(method, "control_bridge_attach" | "control_host_attach" | "events.subscribe")
}

/// 한 줄을 읽어 선언이면 그 자리에서 세우고 답을 돌려준다. 선언이 아니면 None — 부른 쪽이
/// 평소대로 동시 처리에 넘긴다.
pub fn answer_declaration(ctx: &Ctx, line: &str, state: &std::sync::Arc<Conn>) -> Option<Value> {
    let req: Request = serde_json::from_str(line).ok()?;
    if !declares_connection(&req.method) {
        return None;
    }
    Some(answer_on_conn(ctx, line, state))
}

/// 명령 하나를 실행한다. 표에 없으면 **창을 가진 쪽에 배달한다** — 붙은 호스트가 없을 때만
/// 이름을 달고 실패한다. 조용한 no-op 도, 가짜 성공도 없다.
///
/// 이 갈래가 소켓을 하나로 만든다: 부르는 쪽은 어느 명령을 누가 답하는지 몰라도 된다.
/// cored 가 서빙하면 cored 가 답하고, 아니면 창이 답한다 — 봉투는 같다.
#[cfg(unix)]
type ConnRef<'a> = Option<&'a std::sync::Arc<Conn>>;
#[cfg(not(unix))]
type ConnRef<'a> = Option<&'a ()>;

fn route(ctx: &Ctx, req: &Request, line: &str, conn: ConnRef<'_>) -> Value {
    if req.method == "cored.commands" {
        return ok_reply(registry::declaration());
    }
    #[cfg(unix)]
    if req.method == "events.subscribe" {
        let Some(c) = conn else {
            return err_reply(
                "NO_CONNECTION",
                "events.subscribe 는 연결이 있어야 합니다 — 밀어 줄 자리가 없습니다",
            );
        };
        let kinds: Vec<String> = req
            .params
            .get("kinds")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let sink = std::sync::Arc::clone(c);
        crate::ledger::subscribe(
            c.id(),
            kinds.clone(),
            Box::new(move |line| sink.write_line(line)),
        );
        return ok_reply(serde_json::json!({
            "subscribed": true,
            "kinds": kinds,
            "subscribers": crate::ledger::subscriber_count(),
        }));
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
        if let Some((code, message)) = audited_refusal(&req.method) {
            return err_reply(code, &message);
        }
        // 감사 밖의 이름은 **창이 답할 이름**이다. 창이 안 붙었으면 그 사실을 말한다 —
        // "없는 명령"으로 답하면 부른 쪽은 재시도할 이유를 못 찾는다: 없는 명령은 기다려도
        // 안 생기고, 부팅 중인 창은 기다리면 생긴다. 그리고 이 프로세스는 창의 카탈로그를
        // 모르므로 애초에 "없다"를 판정할 자격이 없다.
        return err_reply(
            "NO_HOST",
            &format!(
                "{} 은(는) 창이 답할 이름인데 붙은 창이 없습니다 — 부팅 중이면 잠시 뒤 다시 부르십시오",
                req.method
            ),
        );
    };
    CURRENT.with(|c| c.set(conn.map(|c| c as *const _)));
    ENVELOPE_WINDOW.with(|w| *w.borrow_mut() = req.window.clone());
    let out = (cmd.run)(ctx, &req.params);
    ENVELOPE_WINDOW.with(|w| w.borrow_mut().take());
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
    /// 이 연결의 이름 — 프로세스 안에서 유일하고 재사용되지 않는다.
    id: u64,
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
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Conn {
            id: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            writer: Mutex::new(stream),
            bridge: std::sync::atomic::AtomicBool::new(false),
            owned: Mutex::new(Vec::new()),
        }
    }

    /// 이 연결의 이름. 창 호스트 장부가 **어느 연결이 붙었는지**를 이것으로 안다 —
    /// 주소 비교로 하면 연결이 사라진 뒤 같은 주소에 난 다른 연결을 같은 것으로 본다.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// 이 연결로 나가는 **유일한 쓰기**. 줄 단위로 잠근다.
    ///
    /// 답이든 스트림 프레임이든 방송이든 여기를 지난다. 사본 fd 로 따로 쓰면 fd 는 둘이어도
    /// 소켓은 하나라, 두 쓰기가 서로의 중간에 끼어들어 받는 쪽에는 **깨진 줄** 하나가 된다
    /// (실측: 살아있는 앱이 "파싱 못 한 응답 줄"을 쏟았고, 그 안에는 응답 본문이 스트림
    /// 프레임 구조 안쪽에 박혀 있었다). 그 유실은 어디에도 사유를 남기지 않는다.
    pub fn write_line(&self, line: &str) -> bool {
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writeln!(w, "{line}").is_ok()
    }

    /// 답 한 줄.
    pub fn reply(&self, v: &Value) -> bool {
        self.write_line(&v.to_string())
    }

    pub fn mark_bridge(&self) {
        self.bridge.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_bridge(&self) -> bool {
        self.bridge.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 연결이 끝났다 — 이 연결이 만든 스트림도 끝난다.
    /// 연결이 끝났다. 이 연결이 지고 있던 것을 전부 놓는다.
    ///
    /// 창 호스트도 여기서 놓는다 — 호스트가 여럿이면 죽은 것이 장부에 남고, 그 자리로 간
    /// 배달은 실패가 아니라 **상한까지 침묵**으로 나타난다(쓰기는 성공하고 답이 없다).
    pub fn release(&self) {
        crate::control::detach_host(self.id);
        crate::ledger::unsubscribe(self.id);
        let mut v = self.owned.lock().unwrap_or_else(|e| e.into_inner());
        crate::streams::release_all(&v);
        v.clear();
    }
}

/// 이 연결에서 한 줄을 답한다. 스트림 토큰은 **실행 전에** 매인다 — 명령이 첫 프레임을 곧바로
/// 밀 수 있고, 그때 자리가 없으면 그 프레임은 조용히 사라진다.
#[cfg(unix)]
pub fn answer_on_conn(ctx: &Ctx, line: &str, conn: &std::sync::Arc<Conn>) -> Value {
    if let Ok(req) = serde_json::from_str::<Request>(line) {
        let bound = crate::streams::bind(&req.params, conn);
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

// 지금 답하고 있는 요청의 **봉투 창**. 프레임워크가 창 핸들을 주입하는 자리에 대응한다 —
// 부른 쪽은 어느 창에서 불렀는지 봉투로 말하지 이름마다 인자로 싣지 않는다. 인자로 받으면
// 같은 이름이 두 프로세스에서 다른 모양이 되고, UI 는 자기가 누구와 말하는지 알아야 한다.
thread_local! {
    static ENVELOPE_WINDOW: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

/// 이 요청이 어느 창에서 왔는가. 봉투가 비었으면 없다 — 창 없이 부른 것이다.
pub fn envelope_window() -> Option<String> {
    ENVELOPE_WINDOW.with(|w| w.borrow().clone())
}

// 지금 답하고 있는 **요청**의 연결. 요청 하나 = 스레드 하나라서 스레드 지역이 곧 요청이다.
// (연결 하나 = 스레드 하나였을 때 이 자리가 요청을 직렬로 만들었다 — 그때의 전제와 다르다.)
#[cfg(unix)]
thread_local! {
    static CURRENT: std::cell::Cell<Option<*const std::sync::Arc<Conn>>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(unix)]
fn is_bridge_conn(conn: ConnRef<'_>) -> bool {
    conn.is_some_and(|c| c.is_bridge())
}

#[cfg(not(unix))]
fn is_bridge_conn(_conn: ConnRef<'_>) -> bool {
    false
}

/// 지금 답하고 있는 요청의 **연결**. 연결을 지고 가야 하는 명령만 부른다(배달 통로 등록).
///
/// 사본 fd 가 아니라 연결 자신이다 — 사본으로 쥐면 그쪽 쓰기가 답과 섞인다(write_line 머리말).
#[cfg(unix)]
pub fn current_conn() -> Option<std::sync::Arc<Conn>> {
    CURRENT.with(|c| c.get()).map(|p| unsafe { &*p }.clone())
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
        // 여기서 재는 것은 **배달할 곳이 없을 때**의 답이고, 그 답은 "없는 명령"이 아니다:
        // 이 프로세스는 창의 카탈로그를 모르므로 없다고 판정할 자격이 없다.
        let _serial = crate::control::testing::lock();
        crate::control::testing::detach();
        let reply = answer(&ctx(), r#"{"id":1,"method":"webview_dom_holes"}"#);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "NO_HOST");
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
    let conn = std::sync::Arc::new(Conn::new(a));
    conn.mark_bridge();
    let r = answer_with(
        &ctx(),
        r#"{"id":9,"method":"media_proxy_info","timeoutMs":80}"#,
        Some(&conn),
    );
    assert_eq!(r["ok"], false);
    assert_eq!(r["code"], "NOT_SERVED_HERE", "{r}");
    assert!(r["message"].as_str().unwrap().contains("media_proxy_info"));
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


/// 창이 아직 안 붙었을 때의 답은 **"없는 명령"이 아니다.**
///
/// 그 둘이 같은 코드로 나오면 부른 쪽은 재시도할 이유를 못 찾는다 — 없는 명령은 기다려도
/// 안 생기고, 부팅 중인 창은 기다리면 생긴다. 같은 답을 받은 도구는 앞의 뜻으로 읽고 포기한다
/// (실측: 창이 명령 등록을 끝내기 전에 물으면 UNKNOWN_COMMAND 가 왔다).
#[test]
fn a_name_that_needs_a_window_says_no_host_not_unknown() {
    let _serial = crate::control::testing::lock();
    crate::control::testing::detach();
    // 이 프로세스가 서빙하지 않고 감사 거절도 아닌 이름 — 창이 답할 이름이다.
    let r = answer(&ctx(), r#"{"id":1,"method":"project.open","timeoutMs":80}"#);
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(
        r["code"], "NO_HOST",
        "창이 안 붙은 것과 없는 명령은 다른 사실이다: {r}"
    );
}

}
