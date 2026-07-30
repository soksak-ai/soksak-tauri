//! 이 프로세스의 예약 — 몸은 soksak-schedule 이 진다.
//!
//! 예약은 시계와 장부다. 창도 웹뷰도 필요 없고, 이 프로세스가 사는 동안 예약도 산다 —
//! 껍데기를 갈아도 예약은 안 끊긴다.
//!
//! 발화는 명령을 부른다. 그 명령이 어디로 가는가는 이 프로세스가 이미 아는 길이다:
//! 서빙하면 여기서 답하고, 아니면 창을 가진 쪽으로 배달된다(control::answer 한 자리).

use std::sync::mpsc::Receiver;
use std::sync::Arc;

use serde_json::{json, Value};

use soksak_core::command_dispatch::CommandDispatch;
use soksak_core::schedule_spec::JobSpec;
use soksak_schedule::ScheduleState;

use crate::ctx::Ctx;

/// 한 프로세스에 스케줄러는 하나다. 둘이면 같은 예약이 두 번 발화한다.
pub fn state() -> &'static ScheduleState {
    static S: std::sync::OnceLock<ScheduleState> = std::sync::OnceLock::new();
    S.get_or_init(ScheduleState::default)
}

/// 발화가 명령을 부르는 길 — 이 프로세스의 단일 갈래를 그대로 탄다.
struct CoredDispatch;

impl CommandDispatch for CoredDispatch {
    fn request(
        &self,
        method: String,
        params: Value,
        _timeout_ms: u64,
        _origin: Option<&str>,
        _key: Option<String>,
    ) -> Value {
        // 한 줄을 만들어 같은 문으로 들여보낸다 — 예약이 부르는 명령과 밖에서 부르는 명령이
        // 다른 길을 타면 같은 이름이 두 결과를 낸다.
        let line = json!({ "method": method, "params": params }).to_string();
        crate::control::answer(&line)
    }

    fn open(
        &self,
        _method: String,
        _params: Value,
        _origin: Option<&str>,
    ) -> Option<(u64, Receiver<Value>)> {
        // 대기를 호출자가 소유하는 발화는 창의 것이다(배달-회신 짝). 여기서는 없다고 답한다 —
        // 가짜 채널을 주면 부른 쪽이 오지 않을 답을 기다린다.
        None
    }

    fn close(&self, _seq: u64) {}
}

/// 예약을 세운다(멱등). 발화 스레드가 이 프로세스보다 오래 살지 않는다.
pub fn ensure_started(ctx: &Ctx) {
    let db = ctx.db_path();
    soksak_schedule::ensure_started(
        state(),
        Arc::new(CoredDispatch),
        Arc::new(move |id: &str| persist_delete(&db, id)),
    );
}

fn persist_key(id: &str) -> String {
    format!("schedule:{id}")
}

/// 영속 해제 — 발화가 끝난 일회 예약이 다음 부팅에 되살아나지 않게 한다.
fn persist_delete(db: &std::path::Path, id: &str) {
    let Ok(conn) = soksak_store::open::connect(db) else {
        return;
    };
    let _ = soksak_store::store::kv_delete(&conn, "core", &persist_key(id));
}

fn persist_save(db: &std::path::Path, spec: &JobSpec) {
    if !soksak_schedule::should_persist(spec) {
        return;
    }
    let Some(id) = spec.id.as_ref() else { return };
    let Ok(conn) = soksak_store::open::connect(db) else {
        return;
    };
    if let Ok(v) = serde_json::to_value(spec) {
        let _ = soksak_store::store::kv_set(&conn, "core", &persist_key(id), &v);
    }
}

/// 예약 하나 — 세우고, 걸고, (시간 기반이면) 남긴다. 셋이 한 자리에 있어야 셋 중 하나가
/// 빠지지 않는다: 남기지 않은 시간 예약은 재기동에서 조용히 사라진다.
pub fn register(ctx: &Ctx, spec: JobSpec) -> String {
    ensure_started(ctx);
    let assigned = state().register(spec.clone(), soksak_service::now_ms());
    let mut saved = spec;
    saved.id = Some(assigned.clone());
    persist_save(&ctx.db_path(), &saved);
    assigned
}

/// 서비스 결속이 딸고 온 예약 — owner 가 있어 영속 대상이 아니다(should_persist 가 가른다).
pub fn register_owned(ctx: &Ctx, spec: JobSpec) -> String {
    register(ctx, spec)
}

/// 취소 — 발화 중이면 대기 자리를 먼저 끊는다(좀비 대기 누수 0). close 는 멱등이라 발화 중이
/// 아니어도 무해하다.
pub fn cancel(ctx: &Ctx, id: &str) -> bool {
    ensure_started(ctx);
    if let Some(seq) = state().take_seq(id) {
        CommandDispatch::close(&CoredDispatch, seq);
    }
    let removed = state().cancel(id);
    persist_delete(&ctx.db_path(), id);
    removed
}
