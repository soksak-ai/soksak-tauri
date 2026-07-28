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

/// 이 프로세스가 무엇인지 — 판 숫자는 계약 크레이트에서, 신원은 자기 자신에서.
/// `role` 이 있어야 프레임워크가 앱 소켓과 cored 소켓을 답만 보고 구분한다.
fn hello_facts() -> Value {
    json!({
        "protocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        "role": "cored",
        "backend": env!("CARGO_PKG_NAME"),
        "backendVersion": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
    })
}

/// transport 즉답 — 명령 표에 닿기 전에 답이 정해지는 것들.
/// ① system.hello: 스큐 게이트 면제. 스큐된 클라이언트가 두 판 숫자를 배울 유일한 통로다.
/// ② VERSION_SKEW: 호환창 밖 요청은 명령을 실행하지 않는다.
fn transport_route(req: &Request) -> Option<Value> {
    if req.method == "system.hello" {
        let mut reply = hello_facts();
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
        "helperProtocol": SOCKET_PROTOCOL_VERSION,
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
fn route(ctx: &Ctx, req: &Request, line: &str) -> Value {
    if req.method == "cored.commands" {
        return ok_reply(registry::declaration());
    }
    let Some(cmd) = registry::find(&req.method) else {
        // 창의 다리로 온 것은 창으로 되돌리지 않는다 — 물어본 그 창에 배달되어 상한까지 침묵한다.
        if crate::control::has_host() && !is_bridge() {
            return crate::control::answer(line);
        }
        if is_bridge() {
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
    match (cmd.run)(ctx, &req.params) {
        Outcome::Ok(data) => ok_reply(data),
        // 어느 명령의 인자가 틀렸는지 이름을 달고 말한다 — serde 의 사유만으로는 모른다.
        Outcome::InvalidParams(why) => {
            err_reply("INVALID_PARAMS", &format!("{} 인자: {why}", cmd.name))
        }
        Outcome::Failed(why) => err_reply("COMMAND_FAILED", &why),
    }
}

// 이 연결. **연결 하나 = 스레드 하나**라서 스레드 지역이 곧 연결이다.
//
// Ctx 로 나르지 않는다 — Ctx 는 프로세스 하나에 하나이고(정체성·홈·잠금), 연결은 여럿이다.
// 프로세스 상태에 연결을 얹으면 나중에 붙은 연결이 앞의 것을 조용히 덮는다.
#[cfg(unix)]
thread_local! {
    static CONN: std::cell::RefCell<Option<std::os::unix::net::UnixStream>> =
        const { std::cell::RefCell::new(None) };
}

// 이 연결이 **창의 자기 다리**인가.
//
// 창은 자기 명령을 이 소켓으로 묻는다(Electron 에서는 다리도 이 소켓이다). 그 요청을 서빙하지
// 않는다고 창으로 되돌리면, 물어본 바로 그 창에 배달되고 창의 실행기에는 그 이름이 없어 회신이
// 오지 않는다 — 부른 쪽은 이름 대신 상한을 본다(실측: pty_pane_alive 10초).
//
// 이름의 철자로 가르지 않는다. 사실은 "누가 물었는가"이고, 그것은 연결이 안다.
thread_local! {
    static BRIDGE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 이 연결은 창의 다리다 — 여기로 온 것은 창으로 되돌리지 않는다.
pub fn mark_bridge() {
    BRIDGE.with(|b| b.set(true));
}

/// 다시 밖의 연결로 — 검사가 같은 스레드를 재사용해도 앞의 선언이 남지 않게.
pub fn clear_bridge() {
    BRIDGE.with(|b| b.set(false));
}

pub fn is_bridge() -> bool {
    BRIDGE.with(|b| b.get())
}

/// 이 연결을 스레드에 매어 두고 한 줄을 답한다 — 소켓 루프가 부르는 자리.
#[cfg(unix)]
pub fn answer_on_conn(ctx: &Ctx, line: &str, conn: &std::os::unix::net::UnixStream) -> Value {
    if let Ok(c) = conn.try_clone() {
        CONN.with(|slot| *slot.borrow_mut() = Some(c));
    }
    // 스트림 토큰은 **부른 연결**에 맨다. 명령을 실행하기 전에 매어야 한다 — 실행이 첫 프레임을
    // 곧바로 밀 수 있고, 그때 자리가 없으면 그 프레임은 조용히 사라진다.
    if let Ok(req) = serde_json::from_str::<Request>(line) {
        let bound = crate::streams::bind(&req.params, conn);
        if !bound.is_empty() {
            OWNED.with(|o| o.borrow_mut().extend(bound));
        }
    }
    answer(ctx, line)
}

// 이 연결이 만든 스트림 토큰들. 연결이 끝나면 함께 끝난다 — 남기면 죽은 소켓에 계속 쓴다.
#[cfg(unix)]
thread_local! {
    static OWNED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// 연결 하나가 끝났다 — 그 스레드에 남은 선언을 지운다. 스레드가 재사용되면 앞 연결의
/// "나는 창의 다리다"가 다음 연결에 그대로 붙는다.
#[cfg(unix)]
pub fn forget_conn() {
    CONN.with(|slot| *slot.borrow_mut() = None);
    clear_bridge();
    OWNED.with(|o| {
        let mut v = o.borrow_mut();
        crate::streams::release_all(&v);
        v.clear();
    });
}

/// 지금 답하고 있는 연결의 사본. 연결을 지고 가야 하는 명령만 부른다(배달 통로 등록).
#[cfg(unix)]
pub fn current_conn() -> Option<std::os::unix::net::UnixStream> {
    CONN.with(|slot| slot.borrow().as_ref().and_then(|c| c.try_clone().ok()))
}

/// 한 줄 → 한 줄. 소켓 루프가 부르는 유일한 진입점이라 연결 없이도 전부 검증된다.
/// 부팅 상태는 인자다 — 이 함수가 전역을 읽으면 테스트가 프로세스 하나에 갇힌다.
pub fn answer(ctx: &Ctx, line: &str) -> Value {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return err_reply("INVALID_PARAMS", &format!("JSON 파싱 실패: {e}")),
    };
    let mut reply = transport_route(&req).unwrap_or_else(|| route(ctx, &req, line));
    if let (Some(id), Some(obj)) = (req.id.clone(), reply.as_object_mut()) {
        obj.insert("id".into(), id);
    }
    reply
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
    mark_bridge();
    let r = answer(&ctx(), r#"{"id":9,"method":"process_reclaim_window","timeoutMs":80}"#);
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
    clear_bridge();
    std::thread::spawn(|| {
        let _ = answer(&ctx(), r#"{"id":10,"method":"project.open","timeoutMs":300}"#);
    });
    let mut line = String::new();
    std::io::BufRead::read_line(&mut h, &mut line).expect("배달이 온다");
    assert!(line.contains("project.open"));
    crate::control::testing::detach();
}

}
