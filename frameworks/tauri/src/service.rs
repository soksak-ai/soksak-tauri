// 상주 서비스의 **프레임워크 몫** — 호스트 어댑터와 커맨드 진입점뿐이다.
//
// 몸(bind 원장·프레이밍·라우팅·스폰 seam)은 soksak-service 가 진다. 한때 그 몸이 여기 살았고,
// 1067줄 중 프레임워크를 부르는 줄은 이 아래뿐이었다 — 그 배치는 결정이 아니라 이력이다.
//
// 호스트가 지는 넷은 각각 그 프로세스의 것이라 프로세스를 못 건넌다: 발행(활동 원장), 주인
// 깨우기(예약), 시크릿 해소(볼트), 명령 중개(창 레지스트리 라우팅).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

pub use soksak_service::*;

// ── 앱 배선(실 구현) — 호스트·스포너·부트 ────────────────────────────────────────

// 앱 호스트 어댑터. 네 능력이 서로 다른 통로를 쓴다:
//   publish     → ActivitySink 계약(activity_sink.rs). 발행 구현을 여기서 알지 않는다.
//   poke_owner  · resolve_secret · secret_env → `app.state::<T>()`. 앱이 소유한 상태 레지스트리
//     조회이지 창 의존이 아니다 — 주입형으로 돌리려면 그 상태들이 Arc 공유여야 하고, 그것은
//     lib.rs 의 manage 와 모든 state::<T>() 호출자를 함께 바꾸는 일이라 여기 범위 밖이다.
//   mediate     → ipc::request_command. 창 레지스트리 라우팅 전체가 필요해 WindowOracle
//     (라벨 사실 + 배달) 로는 못 돈다. 여기서 떼어낼 수 있는 것은 신원 스탬프 규칙뿐이다.
pub struct AppServiceHost {
    app: tauri::AppHandle,
    activity: Arc<dyn crate::activity_sink::ActivitySink>,
}

impl AppServiceHost {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            activity: Arc::new(crate::activity_sink::AppSink(app.clone())),
            app,
        }
    }
}

impl ServiceHost for AppServiceHost {
    fn publish(&self, kind: &str, source: &str, payload: Value) {
        let _ = crate::activity_sink::ActivitySink::publish(&*self.activity, kind, source, payload);
    }
    fn poke_owner(&self, owner: &str) {
        use tauri::Manager;
        self.app
            .state::<crate::schedule::ScheduleState>()
            .poke_owner(owner, now_ms());
    }
    fn resolve_secret(&self, ns: &str, name: &str) -> Result<String, String> {
        use tauri::Manager;
        let state = self.app.state::<crate::secrets::SecretsState>();
        crate::secrets::resolve(&state, ns, name)
    }
    fn secret_env(&self, ns: &str) -> Vec<(String, String)> {
        use tauri::Manager;
        let state = self.app.state::<crate::secrets::SecretsState>();
        crate::secrets::env_secrets(&state, ns)
    }
    fn mediate(&self, caller: &str, method: &str, params: Value, under: Option<&str>) -> Value {
        // 게이트는 코어(reader_loop)가 이미 통과시킨 뒤 호출한다. 여기서는 라우팅만:
        // request_command 가 bind:"service" 대상이면 route()에서 직행, 그 외엔 창 registry 로.
        // origin 은 코어가 스탬핑한 "service:<caller>"(자기신고 불신) — 낭독 후보 제외·피드 흐림.
        // parent 는 under(상관 문맥) — request_command 시그니처엔 없어 origin 에 상관만 싣는다.
        let origin = mediation_origin(caller);
        let _ = under; // under 는 서비스측 상관 라벨(로컬) — 코어 신원 스탬핑엔 불사용.
        crate::ipc::request_command(
            &self.app,
            method.to_string(),
            params,
            3_600_000,
            Some(&origin),
            None,
        )
    }
}

// 부트(PS9) — bind 원장을 읽어 각 서비스를 올린다: 스케줄 등록(owner 스탬핑) → bind(스폰).
// 원장이 없으면 서비스 0 — 정상(선언 플러그인 부재). 워크스페이스 창 불요(창-무관).
pub fn boot(app: &tauri::AppHandle) {
    use tauri::Manager;
    // 홈은 정체성이 답한다 — 앰비언트 전역을 읽는 자리는 경계의 이쪽 끝 하나뿐이다(identity.rs).
    let identity = crate::identity::ambient();
    let ledger = match read_ledger(&identity) {
        Ok(Some(l)) => l,
        Ok(None) => return, // 원장 없음 = 서비스 선언 플러그인 없음.
        Err(e) => {
            crate::activity::publish(
                app,
                "service.ledger.invalid",
                "core",
                json!({ "path": ledger_file(&identity).to_string_lossy(), "error": e }),
            );
            return;
        }
    };
    let mgr = app.state::<ServiceManager>();
    for binding in ledger.services {
        register_binding_schedules(app, &binding);
        mgr.bind(binding);
    }
}

// 원장 스케줄 → 코어 스케줄러(PS14): owner=플러그인 id 스탬핑, id 는 안정("svc:<plugin>:<name>").
// bind 후 poke 는 reader 의 ready 전이가 쏜다(poke_owner) — 부팅 스캔은 서비스가 준비된 뒤에만.
fn register_binding_schedules(app: &tauri::AppHandle, binding: &ServiceBinding) {
    for s in &binding.schedules {
        crate::schedule::register_owned(app, job_spec_for(&binding.plugin, s));
    }
}

// ── Tauri 커맨드 ─────────────────────────────────────────────────────────────

// 창 발원(프록시) 디스패치 — route() 직행과 같은 ServiceManager 로 수렴(실행 진실 1개, PS11).
// origin 은 코어가 스탬핑한 실행 문맥을 그대로 물려받는다(프록시 핸들러의 ctx).
#[tauri::command]
pub fn service_dispatch(
    mgr: tauri::State<ServiceManager>,
    method: String,
    params: Value,
    parent: Option<String>,
    origin: Option<String>,
    timeout_ms: Option<u64>,
) -> Value {
    mgr.dispatch(
        &method,
        params,
        None,
        origin.as_deref().unwrap_or("window"),
        parent,
        timeout_ms.unwrap_or(soksak_spec_service::DEFAULT_REQ_TIMEOUT_MS),
        3_600_000,
    )
    .unwrap_or_else(|| {
        json!({ "ok": false, "code": "UNKNOWN_COMMAND", "message": format!("서비스 소유 커맨드가 아님: {method}") })
    })
}

// 창 bus 이벤트를 서비스로 브리지(PS15) — 각 창의 로더가 구독 토픽에 리스너를 걸고 발행 시
// 이 커맨드로 코어에 올린다. 코어(ServiceManager)가 seq dedup 후 구독 서비스로 1회 push.
// dedup_key 는 논리적 이벤트 식별자(플러그인이 실으면 창 간 중복 제거) — 부재면 항상 전달.
#[tauri::command]
pub fn service_bus_push(
    mgr: tauri::State<ServiceManager>,
    topic: String,
    payload: Value,
    dedup_key: Option<String>,
) -> usize {
    mgr.push_bus(&topic, dedup_key.as_deref(), payload)
}

// 상주 서비스 상태 조회(투명성) — 플러그인별 status·ops·in-flight·세대. 크래시/드레인/백오프가
// 무음이 아니라 관측 가능해야 한다(PS10). AI/E2E 가 `sok service.status` 로 읽는다. plugin 지정 시
// 그 하나의 상태만(대상 조회), 부재 시 전체 스냅샷.
#[tauri::command]
pub fn service_status(mgr: tauri::State<ServiceManager>, plugin: Option<String>) -> Value {
    match plugin {
        Some(p) => match mgr.status_of(&p) {
            Some(s) => json!({ "plugin": p, "status": status_label(&s) }),
            None => {
                json!({ "ok": false, "code": "NOT_FOUND", "message": format!("상주 서비스 없음: {p}") })
            }
        },
        None => json!({ "services": mgr.snapshot() }),
    }
}

// bind 원장 동기화(PS9) — 프론트(단일 심판 parseManifest 의 판정 결과)가 파생 원장을 내리면
// 코어가 원자 교체로 쓰고 bind 델타를 적용한다: 제거된 서비스는 unbind+owner 스케줄 회수,
// 새 서비스는 스케줄 등록+bind. 내용 동일이면 no-op(멱등 — 창 여러 개가 불러도 무해).
#[tauri::command]
pub fn service_ledger_sync(
    app: tauri::AppHandle,
    mgr: tauri::State<ServiceManager>,
    ledger: BindLedger,
) -> Result<(), String> {
    use tauri::Manager;
    // 홈은 정체성이 답한다 — 원장 파일 규칙(경로·비교·원자 교체)은 read/write_ledger 가 쥔다.
    if !write_ledger(&crate::identity::ambient(), &ledger)? {
        return Ok(()); // 내용 동일 — 멱등.
    }

    let wanted: std::collections::HashSet<String> =
        ledger.services.iter().map(|s| s.plugin.clone()).collect();
    for plugin in mgr.bound_plugins() {
        if !wanted.contains(&plugin) {
            mgr.unbind(&plugin);
            let n = app
                .state::<crate::schedule::ScheduleState>()
                .cancel_by_owner(&plugin);
            crate::activity::publish(
                &app,
                "service.schedules.cancelled",
                &plugin,
                json!({ "count": n }),
            );
        }
    }
    let bound: std::collections::HashSet<String> = mgr.bound_plugins().into_iter().collect();
    for binding in ledger.services {
        if !bound.contains(&binding.plugin) {
            register_binding_schedules(&app, &binding);
            mgr.bind(binding);
        }
    }
    Ok(())
}
