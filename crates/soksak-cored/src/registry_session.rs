//! AI 세션 명령의 몸 — 표는 registry_table.rs 가, 판정은 코어·저장소가 진다.
//!
//! 스냅샷 원장(SessionTracker)은 **이 프로세스가 하나만 둔다**. 프로세스마다 두면 같은 dir 에
//! 대해 서로 다른 "직전"을 갖고, 그러면 같은 물음에 다른 답이 나온다.

use std::sync::LazyLock;

use serde_json::Value;

use soksak_core::session::SessionTracker;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

static TRACKER: LazyLock<SessionTracker> = LazyLock::new(SessionTracker::default);

#[derive(serde::Deserialize)]
struct Dir {
    dir: String,
}

pub(crate) fn run_ai_session_active(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Dir| {
        Ok(TRACKER.active(&a.dir))
    })
}

pub(crate) fn run_ai_session_untrack(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Dir| {
        TRACKER.forget(&a.dir);
        Ok(())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lineage {
    cwd: String,
    view_id: Option<String>,
}

pub(crate) fn run_ai_session_lineage(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Lineage| {
        // 읽기는 소유권을 안 본다 — 못 쓰는 것과 못 보는 것은 다른 사실이다(WAL 은 읽기 동시).
        ctx.with_db(|conn| {
            soksak_store::session_lineage::ai_session_lineage(&conn, &a.cwd, a.view_id)
        })
    })
}
