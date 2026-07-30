//! 예약 명령의 몸 — 시계와 장부는 soksak-schedule 이, 영속은 이 프로세스의 저장소가 진다.
//!
//! 예약은 창이 필요 없다. 껍데기를 갈아도 예약은 안 끊긴다.

use serde_json::Value;

use soksak_core::schedule_spec::{JobSpec, Retry, Trigger};

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Register {
    trigger: Trigger,
    command: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    retry: Option<Retry>,
    #[serde(default)]
    concurrency: Option<u32>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    process_lease: Option<bool>,
    #[serde(default)]
    zombie_backstop_ms: Option<u64>,
    #[serde(default)]
    owner: Option<String>,
}

impl Register {
    fn into_spec(self) -> Result<JobSpec, String> {
        if self.command.is_empty() {
            return Err("command 필요".into());
        }
        Ok(JobSpec {
            id: self.id,
            trigger: self.trigger,
            command: self.command,
            params: self.params.unwrap_or(Value::Object(Default::default())),
            retry: self.retry,
            concurrency: self.concurrency.unwrap_or(1),
            timeout_ms: self.timeout_ms,
            process_lease: self.process_lease.unwrap_or(false),
            zombie_backstop_ms: self.zombie_backstop_ms,
            owner: self.owner,
        })
    }
}

pub(crate) fn run_schedule_register(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Register| {
        Ok(crate::schedule::register(ctx, a.into_spec()?))
    })
}

#[derive(serde::Deserialize)]
struct At {
    at: u64,
    command: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    id: Option<String>,
}

/// 하위호환 — 절대 ms 1회. register 위의 얇은 shim 이라 규율이 갈리지 않는다.
pub(crate) fn run_schedule_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: At| {
        if a.command.is_empty() {
            return Err("command 필요".into());
        }
        Ok(crate::schedule::register(
            ctx,
            JobSpec {
                id: a.id,
                trigger: Trigger::At { at: a.at },
                command: a.command,
                params: a.params.unwrap_or(Value::Object(Default::default())),
                retry: None,
                concurrency: 1,
                timeout_ms: None,
                process_lease: false,
                zombie_backstop_ms: None,
                owner: None,
            },
        ))
    })
}

#[derive(serde::Deserialize)]
struct Poke {
    #[serde(default)]
    id: Option<String>,
}

pub(crate) fn run_schedule_poke(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Poke| {
        crate::schedule::ensure_started(ctx);
        crate::schedule::state().poke(a.id.as_deref(), soksak_service::now_ms());
        Ok(Value::Null)
    })
}

#[derive(serde::Deserialize)]
struct Id {
    id: String,
}

pub(crate) fn run_schedule_cancel(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Id| Ok(crate::schedule::cancel(ctx, &a.id)))
}

pub(crate) fn run_schedule_list(ctx: &Ctx, _params: &Value) -> Outcome {
    crate::schedule::ensure_started(ctx);
    match serde_json::to_value(crate::schedule::state().list()) {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e.to_string()),
    }
}
