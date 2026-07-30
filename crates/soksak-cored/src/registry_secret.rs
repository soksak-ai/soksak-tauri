//! 시크릿 명령의 몸 — 볼트가 진다. 여기 있는 것은 배선뿐이다.
//!
//! 값 자체는 이 프로세스를 떠난다(부른 쪽이 쓴다). 그것이 이 표면의 목적이라 숨길 수 없고,
//! 대신 **누가 물었는지**를 봉투가 지고 저장은 볼트가 봉인해 둔다.

use serde_json::Value;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

fn vault(ctx: &Ctx) -> &'static soksak_vault::SecretsState {
    crate::vault::install(ctx);
    crate::vault::secrets()
}

#[derive(serde::Deserialize)]
struct NsKey {
    ns: String,
    key: String,
}

#[derive(serde::Deserialize)]
struct NsKeyValue {
    ns: String,
    key: String,
    value: String,
}

#[derive(serde::Deserialize)]
struct Ns {
    ns: String,
}

pub(crate) fn run_secret_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: NsKeyValue| {
        vault(ctx).set(&a.ns, &a.key, &a.value)
    })
}

pub(crate) fn run_secret_has(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: NsKey| vault(ctx).has(&a.ns, &a.key))
}

pub(crate) fn run_secret_delete(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: NsKey| vault(ctx).delete(&a.ns, &a.key))
}

pub(crate) fn run_secret_keys(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Ns| vault(ctx).keys(&a.ns))
}

pub(crate) fn run_secret_status(ctx: &Ctx, _params: &Value) -> Outcome {
    match serde_json::to_value(vault(ctx).status()) {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// 구 backend 조회(호환) — status 를 축약한 같은 사실이다. 형제가 답하는데 이것만 못 답하면
/// 부른 쪽은 "볼트가 없다"로 읽는다.
pub(crate) fn run_secret_backend(ctx: &Ctx, _params: &Value) -> Outcome {
    let info: soksak_vault::BackendInfo = vault(ctx).status().into();
    match serde_json::to_value(info) {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// HTTP — 몸은 soksak-net 이 진다. 여기 남는 것은 열린 볼트를 **인자로 올리는** 한 걸음뿐이다.
/// 규칙이 볼트를 앰비언트로 캐면 같은 코드가 프로세스마다 다른 시크릿을 집는다.
pub(crate) fn run_net_http_request(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |req: soksak_net::http::HttpRequest| {
        let v = vault(ctx);
        soksak_net::http::request(&|ns, key| v.resolve(ns, key), req)
    })
}
