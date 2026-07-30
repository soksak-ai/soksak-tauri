//! 상주 서비스의 몸 — 매니저는 soksak-service 가, 호스트 능력은 이 프로세스가 진다.
//!
//! 상주 서비스는 OS 프로세스다. 창도 웹뷰도 필요 없고, 이 프로세스가 사는 동안 자식도 산다.
//! 적혀 있던 벽("매니저가 요구하는 호스트 능력에 대응하는 계약이 코어에 없다")은 사실이 아니게
//! 됐다 — 계약(ServiceHost)은 크레이트에 있고, 그 다섯 중 넷을 이 프로세스가 이미 진다:
//! 활동 발행은 브로드캐스트, 예약 깨우기는 이 프로세스의 스케줄러, 시크릿 둘은 이 프로세스의
//! 볼트다. 다섯째(중개)는 이 프로세스의 단일 갈래 그 자체다.

use serde_json::{json, Value};

use soksak_service::{
    status_label, BindLedger, ServiceBinding, ServiceHost, ServiceManager, ProcessServiceSpawner,
};

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

/// 호스트 능력 다섯 — 전부 이 프로세스가 이미 지는 것들이다.
struct CoredServiceHost;

impl ServiceHost for CoredServiceHost {
    fn publish(&self, kind: &str, source: &str, payload: Value) {
        crate::control::broadcast(
            "activity",
            json!({ "kind": kind, "ns": source, "payload": payload }),
        );
    }

    fn poke_owner(&self, owner: &str) {
        crate::schedule::state().poke_owner(owner, soksak_service::now_ms());
    }

    fn resolve_secret(&self, ns: &str, name: &str) -> Result<String, String> {
        crate::vault::secrets().resolve(ns, name)
    }

    fn secret_env(&self, ns: &str) -> Vec<(String, String)> {
        soksak_vault::env_secrets(crate::vault::secrets(), ns)
    }

    fn mediate(&self, caller: &str, method: &str, params: Value, under: Option<&str>) -> Value {
        // 게이트(의존성)는 코어가 이미 통과시킨 뒤 부른다. 여기서는 라우팅만 — 이 프로세스가
        // 서빙하면 여기서 답하고, 아니면 창을 가진 쪽으로 배달된다(같은 문 하나).
        let _ = (soksak_service::mediation_origin(caller), under);
        let line = json!({ "method": method, "params": params }).to_string();
        crate::control::answer(&line)
    }
}

/// 이 프로세스의 매니저 하나. 둘이면 같은 플러그인에 자식이 둘 생기고, 그 둘은 서로를 모른다.
fn manager(ctx: &Ctx) -> &'static ServiceManager {
    static M: std::sync::OnceLock<ServiceManager> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        crate::vault::install(ctx);
        crate::schedule::ensure_started(ctx);
        ServiceManager::new(
            std::sync::Arc::new(CoredServiceHost),
            std::sync::Arc::new(ProcessServiceSpawner::for_identity(ctx.identity().clone())),
        )
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dispatch {
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

pub(crate) fn run_service_dispatch(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Dispatch| {
        let method = a.method.clone();
        Ok(manager(ctx)
            .dispatch(
                &a.method,
                a.params,
                None,
                a.origin.as_deref().unwrap_or("window"),
                a.parent,
                a.timeout_ms
                    .unwrap_or(soksak_spec_service::DEFAULT_REQ_TIMEOUT_MS),
                // 백스톱 — 상한이 없으면 답 없는 자식 하나가 그 자리를 영원히 잡는다.
                3_600_000,
            )
            .unwrap_or_else(|| {
                json!({
                    "ok": false, "code": "UNKNOWN_COMMAND",
                    "message": format!("서비스 소유 커맨드가 아님: {method}")
                })
            }))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BusPush {
    topic: String,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    dedup_key: Option<String>,
}

pub(crate) fn run_service_bus_push(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: BusPush| {
        Ok(manager(ctx).push_bus(&a.topic, a.dedup_key.as_deref(), a.payload))
    })
}

#[derive(serde::Deserialize)]
struct StatusArg {
    #[serde(default)]
    plugin: Option<String>,
}

pub(crate) fn run_service_status(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: StatusArg| {
        let mgr = manager(ctx);
        Ok(match a.plugin {
            Some(p) => match mgr.status_of(&p) {
                Some(s) => json!({ "plugin": p, "status": status_label(&s) }),
                None => json!({
                    "ok": false, "code": "NOT_FOUND",
                    "message": format!("상주 서비스 없음: {p}")
                }),
            },
            None => json!({ "services": mgr.snapshot() }),
        })
    })
}

#[derive(serde::Deserialize)]
struct LedgerArg {
    ledger: BindLedger,
}

pub(crate) fn run_service_ledger_sync(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: LedgerArg| {
        // 파일 쓰기와 결속 맞춤은 **한 손**이어야 한다. 쓰기만 하고 절반을 빼면 원장은 새
        // 내용인데 도는 서비스는 옛 결속이고, 그 어긋남은 "없앤 서비스가 계속 도는 것"으로
        // 나타난다.
        if !soksak_service::write_ledger(ctx.identity(), &a.ledger)? {
            return Ok(Value::Null); // 내용 동일 — 멱등.
        }
        let mgr = manager(ctx);
        let wanted: std::collections::HashSet<String> =
            a.ledger.services.iter().map(|s| s.plugin.clone()).collect();
        for plugin in mgr.bound_plugins() {
            if !wanted.contains(&plugin) {
                mgr.unbind(&plugin);
                let n = crate::schedule::state().cancel_by_owner(&plugin);
                CoredServiceHost.publish(
                    "service.schedules.cancelled",
                    &plugin,
                    json!({ "count": n }),
                );
            }
        }
        let bound: std::collections::HashSet<String> = mgr.bound_plugins().into_iter().collect();
        for binding in a.ledger.services {
            if !bound.contains(&binding.plugin) {
                register_binding_schedules(ctx, &binding);
                mgr.bind(binding);
            }
        }
        Ok(Value::Null)
    })
}

fn register_binding_schedules(ctx: &Ctx, binding: &ServiceBinding) {
    for s in &binding.schedules {
        crate::schedule::register_owned(ctx, soksak_service::job_spec_for(&binding.plugin, s));
    }
}
