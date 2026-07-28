//! 소켓 표면 — 요청 한 줄을 응답 한 줄로.
//!
//! 봉투와 판 협상은 앱 소켓과 **같은 계약**이다(soksak-spec-socket). 판 상수를 여기 베끼면
//! 두 프로세스가 서로 다른 숫자를 말하게 된다 — 크레이트에서 읽는다.
//!
//! 봉투는 `{ok, code, message, data}` 이고, `data` 에는 앱의 `invoke` 가 돌려주는 값이
//! **그대로** 실린다. 셸 어댑터는 `data` 를 벗겨 invoke 의 약속에 그대로 얹으면 된다 —
//! 헬퍼를 거쳤다고 값의 모양이 달라지지 않는다.

use serde::Deserialize;
use serde_json::{json, Value};
use soksak_spec_socket::{
    effective_protocol, evaluate_compat, skew_sentence, Lang, MIN_COMPATIBLE_CLIENT_PROTOCOL,
    SOCKET_PROTOCOL_VERSION,
};

use crate::ctx::Ctx;
use crate::registry::{self, Outcome};

/// 요청. 앱 소켓의 요청에서 **창 관련 필드를 뺀 것**이다 — 헬퍼에는 창이 없다.
/// 모르는 필드는 무시한다(계약의 추가-필드 규칙): 창을 실어 보내는 셸도 거절당하지 않는다.
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
/// `role` 이 있어야 셸이 앱 소켓과 헬퍼 소켓을 답만 보고 구분한다.
fn hello_facts() -> Value {
    json!({
        "protocol": SOCKET_PROTOCOL_VERSION,
        "minClientProtocol": MIN_COMPATIBLE_CLIENT_PROTOCOL,
        "role": "helper",
        "helper": env!("CARGO_PKG_NAME"),
        "helperVersion": env!("CARGO_PKG_VERSION"),
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
    // 이 시선은 헬퍼가 클라이언트를 판정한다 — self=헬퍼, peer=클라이언트. 문장은 기계가
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

/// 명령 하나를 실행한다. 표에 없으면 이름을 달고 실패한다 — 조용한 no-op 도, 가짜 성공도 없다.
fn route(ctx: &Ctx, req: &Request) -> Value {
    if req.method == "helper.commands" {
        return ok_reply(registry::declaration());
    }
    let Some(cmd) = registry::find(&req.method) else {
        return err_reply(
            "UNKNOWN_COMMAND",
            &format!(
                "{} 은(는) 이 헬퍼가 서빙하지 않습니다 — helper.commands 로 목록을 확인하세요",
                req.method
            ),
        );
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

/// 한 줄 → 한 줄. 소켓 루프가 부르는 유일한 진입점이라 연결 없이도 전부 검증된다.
/// 부팅 상태는 인자다 — 이 함수가 전역을 읽으면 테스트가 프로세스 하나에 갇힌다.
pub fn answer(ctx: &Ctx, line: &str) -> Value {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return err_reply("INVALID_PARAMS", &format!("JSON 파싱 실패: {e}")),
    };
    let mut reply = transport_route(&req).unwrap_or_else(|| route(ctx, &req));
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
        assert_eq!(reply["role"], "helper");
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

    // 봉투만 헬퍼의 것이고 `data` 는 앱 invoke 의 값 그대로다. 이게 깨지면 셸 어댑터가
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
        let reply = answer(&ctx(), r#"{"method":"helper.commands"}"#);
        assert_eq!(reply["ok"], true);
        assert!(!reply["data"]["commands"].as_array().unwrap().is_empty());
    }

    // id 가 없는 요청에 id 를 지어내지 않는다.
    #[test]
    fn an_absent_id_is_not_invented() {
        let reply = answer(&ctx(), r#"{"method":"helper.commands"}"#);
        assert!(reply.get("id").is_none(), "{reply}");
    }
}
