//! 봉인 명령의 몸 — 규칙은 soksak_store::encryption 이, 열쇠는 이 프로세스의 볼트가 진다.
//!
//! 여기 있는 것은 배선뿐이다. 열쇠 순서(S 를 보관한 뒤에만 P 를 등록한다)를 여기에 다시
//! 적으면 앱 경로와 이 경로가 다른 순서를 갖고, 그 차이는 오류가 아니라 영구 손실이다.

use serde_json::Value;

use soksak_store::encryption;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};
use crate::registry_store::deny_without_write_ownership;
use crate::vault::VaultKeys;

#[derive(serde::Deserialize)]
struct Scope {
    scope: String,
}

pub(crate) fn run_data_encrypt_enable(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Scope| {
        deny_without_write_ownership(ctx)?;
        crate::vault::install(ctx);
        ctx.with_db(|conn| encryption::data_encrypt_enable(conn, &VaultKeys, a.scope))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recover {
    scope: String,
    recovery_code: String,
}

pub(crate) fn run_data_encrypt_recover(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Recover| {
        deny_without_write_ownership(ctx)?;
        crate::vault::install(ctx);
        ctx.with_db(|conn| encryption::data_encrypt_recover(conn, &VaultKeys, a.scope, a.recovery_code))
    })
}

pub(crate) fn run_data_encrypt_rotate(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Scope| {
        deny_without_write_ownership(ctx)?;
        crate::vault::install(ctx);
        ctx.with_db(|conn| encryption::data_encrypt_rotate(conn, &VaultKeys, a.scope))
    })
}

pub(crate) fn run_data_encrypt_change_recovery(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Scope| {
        deny_without_write_ownership(ctx)?;
        crate::vault::install(ctx);
        ctx.with_db(|conn| encryption::data_encrypt_change_recovery(conn, &VaultKeys, a.scope))
    })
}

#[derive(serde::Deserialize)]
struct Convert {
    ns: String,
    coll: String,
    scope: String,
}

pub(crate) fn run_data_encrypt_convert(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Convert| {
        deny_without_write_ownership(ctx)?;
        ctx.with_db(|conn| encryption::data_encrypt_convert(conn, a.ns, a.coll, a.scope))
    })
}

pub(crate) fn run_data_encrypt_status(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Scope| {
        // 상태는 읽기다 — 쓰기 소유권을 요구하지 않는다. 다만 볼트는 서야 unlocked 를 답한다.
        crate::vault::install(ctx);
        ctx.with_db(|conn| encryption::data_encrypt_status(conn, &VaultKeys, a.scope))
    })
}
