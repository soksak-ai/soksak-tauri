//! 저장소 변경 사실의 **모양** — 뿌리는 쪽이 여럿이라 한 자리에 둔다.
//!
//! 이 사실은 최소 두 곳에서 만들어진다: 저장소를 소유한 프로세스(cored)와, 소유를 잡은 앱.
//! 구독자는 그것이 어디서 왔는지 모른다 — 모양이 갈리면 같은 코드가 프레임워크마다 다른 것을
//! 보고, 그 차이는 오류가 아니라 **안 갱신되는 화면**으로 나타난다.
//!
//! 그래서 필드 이름과 빈 값의 뜻을 여기서 정한다. 뿌리는 통로(창 emit·소켓 방송)는 각자의 몫이다.

use serde_json::{json, Value};

/// 무엇이 바뀌었는지 못 짚을 때 쓰는 ns — 구독자는 자기 키를 다시 읽는다.
///
/// 가져오기·되돌리기는 저장소를 통째로 갈아치운다. 그때 아무 말도 안 하면 다른 프로세스가 옛
/// 값을 계속 진실로 알고, 짚은 척하면 구독자가 엉뚱한 키만 다시 읽는다.
pub const WHOLE_STORE: &str = "*";

/// `data-change` 페이로드. `coll`·`scope`·`id` 는 연산에 따라 없다(kv 는 컬렉션이 없다).
pub fn payload(
    ns: &str,
    coll: Option<&str>,
    scope: Option<&str>,
    op: &str,
    id: Option<&str>,
) -> Value {
    json!({ "ns": ns, "coll": coll, "scope": scope, "op": op, "id": id })
}

/// 창·소켓 어느 쪽으로 뿌리든 같은 이름을 쓴다 — 구독자는 한 이름만 안다.
pub const EVENT: &str = "data-change";

/// 연산 이름 — **뿌리는 쪽이 여럿이라 값도 여기서 정한다.**
///
/// 실측(2026-08-01): 앱은 `kv_set`, cored 는 `kv-set` 을 실었다. 지금 구독자는 `ns`/`coll`/`scope`
/// 로만 거르므로 아무도 안 깨졌지만, op 을 보는 구독자가 하나 생기는 순간 어느 프로세스가
/// 답했느냐에 따라 다르게 동작한다 — 그때는 원인이 이 두 문자열까지 되짚어지지 않는다.
pub mod op {
    pub const KV_SET: &str = "kv_set";
    pub const KV_DELETE: &str = "kv_delete";
    pub const NS_REMOVE: &str = "ns_remove";
    pub const PUT: &str = "put";
    pub const DELETE: &str = "delete";
    pub const REAP: &str = "reap";
    pub const TRIM: &str = "trim";
    pub const IMPORT: &str = "import";
    pub const RESTORE: &str = "restore";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 없는_축은_null_로_실린다() {
        // 키를 빼면 받는 쪽에서 "없음"과 "안 보냄"이 같아진다 — 한쪽은 정상이고 한쪽은 결함이다.
        let v = payload("core", None, None, "kv-set", Some("settings"));
        assert_eq!(v["ns"], "core");
        assert!(v["coll"].is_null());
        assert!(v["scope"].is_null());
        assert_eq!(v["op"], "kv-set");
        assert_eq!(v["id"], "settings");
    }

    #[test]
    fn 못_짚는_변경은_전면_갱신을_말한다() {
        let v = payload(WHOLE_STORE, None, None, "restore", None);
        assert_eq!(v["ns"], "*");
        assert!(v["id"].is_null());
    }
}
