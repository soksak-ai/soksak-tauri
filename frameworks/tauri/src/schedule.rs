// 스케줄러의 **프레임워크 몫** — 조립뿐이다.
//
// 몸(트리거 산술·잡 원장·lease·backoff·발화 경로)은 soksak-schedule 이 진다. 한때 그 몸이 여기
// 살았고, 1344줄 중 프레임워크를 부르는 줄은 이 아래뿐이었다 — 그 배치는 결정이 아니라 이력이다.
//
// 여기 남은 것 셋: 발화 스레드를 세우는 것, 중개자와 상태를 건네는 것, 시간 기반 잡의 영속.
// 셋 다 이 프로세스의 것이라 프로세스를 못 건넌다(상태 레지스트리·저장소 커넥션·런루프).

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::command_dispatch::CommandDispatch;

pub use soksak_schedule::*;

// ── 발화 스레드 ──────────────────────────────────────────────────────────────

/// 발화 스레드를 세운다 — 중개자와 영속 회수만 건넨다. 규칙은 soksak-schedule 이 진다.
///
/// 상태는 `&'static` 이어야 한다(발화 스레드가 앱보다 오래 산다). 앱이 manage 한 상태는 앱
/// 수명이라, 그 참조를 여기서 leak 해 정적으로 만든다 — 한 프로세스에 스케줄러는 하나다.
pub fn ensure_started(app: &AppHandle) {
    use std::sync::Arc;
    let state: &'static ScheduleState = Box::leak(Box::new(ScheduleState::default()));
    let _ = state;
    let managed = app.state::<ScheduleState>();
    // 이미 관리 중인 상태를 쓴다 — 새로 만든 것은 버린다(위 leak 은 타입 고정용).
    let state: &'static ScheduleState =
        unsafe { &*(managed.inner() as *const ScheduleState) };
    let a = app.clone();
    soksak_schedule::ensure_started(
        state,
        Arc::new(crate::command_dispatch::AppDispatch(app.clone())),
        Arc::new(move |id: &str| persist_delete(&a, id)),
    );
}

// ── 영속(app.data, ns="core") ────────────────────────────────────────────────

fn persist_key(id: &str) -> String {
    format!("schedule:{id}")
}


fn persist_save(app: &AppHandle, spec: &JobSpec) {
    if !should_persist(spec) {
        return;
    }
    let Some(id) = spec.id.as_ref() else { return };
    let st = app.state::<crate::data::DbState>();
    let guard = st.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        if let Ok(v) = serde_json::to_value(spec) {
            let _ = soksak_store::store::kv_set(conn, "core", &persist_key(id), &v);
        }
    }
}

fn persist_delete(app: &AppHandle, id: &str) {
    let st = app.state::<crate::data::DbState>();
    let guard = st.conn.lock().unwrap();
    if let Some(conn) = guard.as_ref() {
        let _ = soksak_store::store::kv_delete(conn, "core", &persist_key(id));
    }
}

// 부팅/재개 1회 — 영속된 시간 기반 작업을 다시 무장(crash 복구). 과거 At 은 즉시 발화(at-least-once;
// 멱등은 명령이 보장). 무상태 Reconcile 은 플러그인이 activate 시 재등록한다.
pub fn reload_persisted(app: &AppHandle) {
    let specs: Vec<JobSpec> = {
        let st = app.state::<crate::data::DbState>();
        let guard = st.conn.lock().unwrap();
        let Some(conn) = guard.as_ref() else { return };
        let keys = soksak_store::store::kv_keys(conn, "core", Some("schedule:")).unwrap_or_default();
        keys.iter()
            .filter_map(|k| soksak_store::store::kv_get(conn, "core", k).ok().flatten())
            .filter_map(|v| serde_json::from_value::<JobSpec>(v).ok())
            .collect()
    };
    if specs.is_empty() {
        return;
    }
    let state = app.state::<ScheduleState>();
    let now = now_ms();
    for spec in specs {
        state.register(spec, now);
    }
    ensure_started(app);
}

// ── tauri 명령 ───────────────────────────────────────────────────────────────

// app.scheduler.register — 트리거+명령 등록. 시간 기반은 영속(crash 복구). 반환=id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn schedule_register(
    app: AppHandle,
    state: State<ScheduleState>,
    trigger: Trigger,
    command: String,
    params: Option<Value>,
    id: Option<String>,
    retry: Option<Retry>,
    concurrency: Option<u32>,
    timeout_ms: Option<u64>,
    process_lease: Option<bool>,
    zombie_backstop_ms: Option<u64>,
    owner: Option<String>,
) -> Result<String, String> {
    if command.is_empty() {
        return Err("command 필요".into());
    }
    let spec = JobSpec {
        id,
        trigger,
        command,
        params: params.unwrap_or(Value::Object(Default::default())),
        retry,
        concurrency: concurrency.unwrap_or(1),
        timeout_ms,
        process_lease: process_lease.unwrap_or(false),
        zombie_backstop_ms,
        owner,
    };
    ensure_started(&app);
    let assigned = state.register(spec.clone(), now_ms());
    let mut saved = spec;
    saved.id = Some(assigned.clone());
    persist_save(&app, &saved);
    Ok(assigned)
}

// 서비스 bind 가 원장 스케줄을 등록하는 Rust 내부 경로(PS14) — schedule_register 와 같은 규율
// (ensure_started + 등록 + persist 자기게이트: owner=Some 은 B2 로 persist 대상이 아니다).
pub fn register_owned(app: &AppHandle, spec: JobSpec) -> String {
    ensure_started(app);
    let assigned = app
        .state::<ScheduleState>()
        .register(spec.clone(), now_ms());
    let mut saved = spec;
    saved.id = Some(assigned.clone());
    persist_save(app, &saved);
    assigned
}

// app.scheduler — 즉시 발화 요청(완료 트리거·외부 변화). id 미지정 시 모든 Reconcile 작업.
#[tauri::command]
pub fn schedule_poke(state: State<ScheduleState>, id: Option<String>) -> Result<(), String> {
    state.poke(id.as_deref(), now_ms());
    Ok(())
}

#[tauri::command]
pub fn schedule_cancel(
    app: AppHandle,
    state: State<ScheduleState>,
    id: String,
) -> Result<bool, String> {
    // 발화 중 프로세스 작업이면 seq 로 대기 자리를 끊어 fire_process 의 recv 를 즉시 깨운다(좀비 대기
    // 누수 0). seq 회수는 작업 제거 전. close 는 멱등이라 발화 중이 아니어도 무해.
    if let Some(seq) = state.take_seq(&id) {
        CommandDispatch::close(&crate::command_dispatch::AppDispatch(app.clone()), seq);
    }
    let removed = state.cancel(&id);
    persist_delete(&app, &id);
    Ok(removed)
}

#[tauri::command]
pub fn schedule_list(state: State<ScheduleState>) -> Result<Vec<JobView>, String> {
    Ok(state.list())
}

// 하위호환 — schedule.set: 절대 ms 1회(At). register 위의 얇은 shim.
#[tauri::command]
pub fn schedule_set(
    app: AppHandle,
    state: State<ScheduleState>,
    at: u64,
    command: String,
    params: Option<Value>,
    id: Option<String>,
) -> Result<String, String> {
    schedule_register(
        app,
        state,
        Trigger::At { at },
        command,
        params,
        id,
        None,
        None,
        None,
        None,
        None,
        None, // owner — schedule.set 은 코어 shim
    )
}
// (인자: trigger, command, params, id, retry, concurrency, timeout_ms, process_lease, zombie_backstop_ms)

// ── 테스트 ───────────────────────────────────────────────────────────────────
