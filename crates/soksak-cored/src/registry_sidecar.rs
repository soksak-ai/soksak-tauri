//! 엔진 모델 사이드카의 호스팅 — 몸은 soksak-sidecar-host 가 진다.
//!
//! 벽으로 적혀 있던 셋 중 **둘은 이 프로세스가 이미 준다**.
//!
//! ① 동적 적재 — dlopen 은 OS 호출이지 프레임워크의 것이 아니다(크레이트가 이미 진다).
//! ② 메인스레드 — 엔진 init·shutdown 이 요구하는 것은 "이 프로세스의 첫 스레드"뿐이고 창을
//!    요구하지 않는다. 그 자리를 accept 루프에 내주지 않으려고 main_thread 를 세웠다.
//! ③ 네이티브 부모 표면 — **이 프로세스에는 없다.** 그래서 `surface_alive` 는 아무 일도 하지
//!    않고(크레이트의 기본구현이 그 경우를 위해 비어 있다), `send` 에 실리는 표면은 0 이다.
//!
//! 표면 0 의 뜻을 흐리지 않는다: 표면을 **쓰는** 엔진은 그 순간 실패하고 그 사실을 자기 이름으로
//! 말한다. 여기서 가짜 포인터를 지어내면 그 엔진은 유효한 주소로 읽고 남의 메모리에 얹는다.
//!
//! 사건은 **부른 쪽의 스트림 토큰**으로 간다. 창 채널이 없다고 방송으로 바꾸지 않는다: 방송은
//! 미개봉 코드에도 배달되고, 그 누수가 이 표면이 처음부터 막던 것이다(app.sidecar 는 이벤트를
//! 그 호출자에게만 흘린다).

use serde_json::Value;

use soksak_sidecar_host as host;
use soksak_spec_contract::ContractRequirement;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

/// 프레임워크가 지는 셋 중 이 프로세스가 줄 수 있는 것만 준다.
struct CoredFramework;

/// 핸들 → 그 핸들을 연 쪽의 스트림 토큰. 창 채널이 없는 자리에서 이 표가 그 자리를 대신한다.
fn sinks() -> &'static std::sync::Mutex<std::collections::HashMap<u64, String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

impl host::Framework for CoredFramework {
    fn on_main(&self, job: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        crate::main_thread::run_on_main(job)
    }

    fn emit(&self, name: &str, handle: u64, event: &Value) {
        let token = sinks()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&handle)
            .cloned();
        // 토큰이 없으면 흘리지 않는다 — 방송으로 바꾸면 미개봉 코드에도 배달된다.
        if let Some(t) = token {
            let _ = crate::streams::push(
                &t,
                serde_json::json!({ "name": name, "handle": handle, "event": event }),
            );
        }
    }
    // surface_alive 는 기본구현(빈 몸)을 쓴다 — 네이티브 자식 표면이 없는 호스트는 편입할 것이 없다.
}

fn ensure_installed() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| host::install(std::sync::Arc::new(CoredFramework)));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    name: String,
    requirement: ContractRequirement,
    /// 사건이 갈 곳 — 앱 명령의 `on_event` 채널과 같은 자리다. 이 프로세스에는 창 채널이
    /// 없으므로 스트림 토큰이 그 자리를 진다.
    #[serde(default)]
    on_event: Value,
}

pub(crate) fn run_sidecar_open(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Open| {
        ensure_installed();
        let Some(token) = soksak_core::stream::token_of(&a.on_event) else {
            return Err("onEvent 스트림 토큰이 없다 — 사건이 갈 곳 없이 열면 그 엔진은 조용해진다".into());
        };
        let handle = host::open(&a.name, &a.requirement, ctx.identity().home())?;
        sinks()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle, token);
        Ok(handle)
    })
}

#[derive(serde::Deserialize)]
struct Relay {
    name: String,
    handle: u64,
    payload: String,
}

pub(crate) fn run_sidecar_send(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Relay| {
        ensure_installed();
        // 표면 0 — 이 프로세스에는 네이티브 부모 표면이 없다. 지어내지 않는다: 유효한 주소로
        // 읽혀 그 위에 얹으려 한다.
        host::send(&a.name, a.handle, &a.payload, 0)
    })
}

#[derive(serde::Deserialize)]
struct Close {
    name: String,
    handle: u64,
}

pub(crate) fn run_sidecar_close(_ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Close| {
        ensure_installed();
        sinks()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&a.handle);
        host::close(&a.name, a.handle)
    })
}
