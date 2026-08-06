//! 사이드카(engine 모델) 호스팅 — dlopen, ABI 악수, 모듈·클라이언트 장부, 불투명 메시지 중개.
//!
//! 플러그인이 매니페스트로 선언한 공유 네이티브 모듈(dylib)을 이 프로세스에 적재하고, 호출 창의
//! surface 와 불투명 메시지 채널을 중개한다. 메시지의 **뜻은 모른다** — 하는 일은 (1) 선언
//! interface ↔ 바이너리 자기보고 대조, (2) surface 주입, (3) JSON bytes relay, (4) 호스트 사실
//! 통지뿐. 분류·ABI 정본 = docs/SIDECARS.md.
//!
//! **프레임워크는 셋만 진다**(`Framework`): 네이티브 부모 표면, 메인스레드 실행, 사건 싱크. 그 셋을
//! 주입받으므로 이 몸은 어느 프레임워크 밑에서도 같은 답을 낸다. 한때 이 코드는 프레임워크
//! 폴더에 살았고, 671줄 중 프레임워크를 부르는 줄은 22줄이었다 — 그 배치는 결정이 아니라 이력이다.
//!
//! 수명: 엔진 모듈은 적재 후 절대 unload 하지 않는다(프로세스 종료 시 shutdown 만). 살아 있는
//! 브라우저류 child 가 모듈 코드를 참조하고 Chromium 계열은 프로세스당 1회 초기화 제약이 있다 —
//! unload 는 범주적으로 unsafe. Library 는 의도적으로 leak 한다.
//!
//! 패닉 경계: 모듈 export 는 자체 catch_unwind(-2 반환) 계약이고, 호스트 vtable(emit/log)도 여기서
//! catch_unwind 로 감싼다 — FFI 경계를 넘는 unwinding 은 양방향 0.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use soksak_spec_contract::{is_sidecar_contract_id, ContractProviderRef, ContractRequirement};

// ── C ABI v1 (docs/SIDECARS.md §3 이 규범 — 여기와 사이드카 크레이트가 동일 레이아웃을 미러) ──

pub const HOST_ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct SoksakSidecarEngineAbi {
    pub abi: u32,
    pub interface_id: *const c_char,
    pub interface_version: *const c_char,
}

#[repr(C)]
pub struct SoksakSidecarEngineHost {
    pub abi: u32,
    pub ctx: *mut c_void,
    /// 임의 스레드에서 불린다.
    pub emit: extern "C" fn(ctx: *mut c_void, json: *const u8, len: usize),
    /// 임의 스레드에서 불린다. level: 0=info 1=warn 2=error.
    pub log: extern "C" fn(ctx: *mut c_void, level: i32, msg: *const u8, len: usize),
}

#[repr(C)]
pub struct SoksakBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

type AbiFn = unsafe extern "C" fn() -> *const SoksakSidecarEngineAbi;
type InitFn =
    unsafe extern "C" fn(host: *const SoksakSidecarEngineHost, cfg: *const u8, cfg_len: usize) -> i32;
type MessageFn =
    unsafe extern "C" fn(req: *const u8, len: usize, surface: usize, reply: *mut SoksakBuf) -> i32;
type NotifyFn = unsafe extern "C" fn(evt: *const u8, len: usize);
type FreeFn = unsafe extern "C" fn(buf: SoksakBuf);
type ShutdownFn = unsafe extern "C" fn();
#[cfg(not(target_os = "macos"))]
type TickFn = unsafe extern "C" fn();

// ── 프레임워크가 지는 셋 ──────────────────────────────────────────────────────

/// 프레임워크의 몫. 이 셋 말고는 프레임워크가 이 호스팅에 대해 아는 것이 없어야 한다.
///
/// 셋인 이유는 각각 프로세스를 못 건너기 때문이다: 부모 뷰는 프로세스-로컬이고, 메인스레드는
/// 그 프로세스의 런루프이며, 사건은 그 창의 구독자에게 가야 한다.
pub trait Framework: Send + Sync + 'static {
    /// 메인스레드에서 한 번 돌린다. 엔진 init/shutdown 은 메인스레드 계약이다(SIDECARS.md §3).
    ///
    /// 랑데부(완료 대기·상한)는 이 크레이트가 진다 — 프레임워크는 큐잉만 한다.
    fn on_main(&self, job: Box<dyn FnOnce() + Send>) -> Result<(), String>;

    /// 엔진이 낸 사건을 그 핸들의 구독자에게 흘린다.
    fn emit(&self, name: &str, handle: u64, event: &serde_json::Value);

    /// windowed 엔진 서피스의 편입/해제 — hitTest 위임 대상 등록이다.
    /// 네이티브 자식 표면이 없는 프레임워크는 할 일이 없다.
    fn surface_alive(&self, _ptr: usize, _key: Option<&str>, _alive: bool) {}
}

#[derive(Debug, PartialEq, Eq)]
struct NativeSurfaceEvent<'a> {
    ptr: usize,
    key: Option<&'a str>,
    alive: bool,
}

fn native_surface_event(value: &serde_json::Value) -> Option<NativeSurfaceEvent<'_>> {
    let ptr = usize::try_from(value.get("view")?.as_u64()?).ok()?;
    if ptr == 0 {
        return None;
    }
    let alive = match value.get("event")?.as_str()? {
        "surface-created" => true,
        "surface-destroyed" => false,
        _ => return None,
    };
    Some(NativeSurfaceEvent {
        ptr,
        key: value.get("surfaceKey").and_then(|key| key.as_str()).filter(|key| !key.is_empty()),
        alive,
    })
}

static FRAMEWORK: OnceLock<Arc<dyn Framework>> = OnceLock::new();

/// 부팅 1회. 두 번째 설치는 조용히 무시된다 — 프레임워크는 하나다.
pub fn install(framework: Arc<dyn Framework>) {
    let _ = FRAMEWORK.set(framework);
}

fn framework() -> Option<&'static Arc<dyn Framework>> {
    FRAMEWORK.get()
}

// ── 모듈 장부 ────────────────────────────────────────────────────────────────

struct EngineModule {
    name: String,
    interface: ContractProviderRef,
    message: MessageFn,
    notify: NotifyFn,
    free: FreeFn,
    shutdown: ShutdownFn,
    #[cfg(not(target_os = "macos"))]
    tick: TickFn,
    /// 열린 채널의 **핸들만** 쥔다. 무엇으로 배달하는지는 프레임워크의 몫이다.
    clients: Mutex<HashSet<u64>>,
    next_handle: AtomicU64,
}

static MODULES: LazyLock<Mutex<HashMap<String, Arc<EngineModule>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 적재된 모든 엔진의 펌프를 한 번 tick — 런루프 콜백(메인=엔진 UI 스레드)에서 사건마다 불린다.
/// 엔진 쪽 drive_pump 는 만기 검사(원자 로드 1회) 후 due 일 때만 일하므로 idle 비용이 0에 가깝다.
/// 폴링 스레드를 따로 만들지 않는다 — 런루프가 곧 tick 원천이다.
#[cfg(not(target_os = "macos"))]
pub fn tick_all() {
    let mods: Vec<Arc<EngineModule>> = match MODULES.lock() {
        Ok(m) => m.values().cloned().collect(),
        Err(_) => return,
    };
    for m in mods {
        unsafe { (m.tick)() };
    }
}

// ── 호스트 vtable ────────────────────────────────────────────────────────────

/// 호스트 vtable ctx — 모듈 이름만 담아 emit 시 장부 역참조. 모듈과 함께 영구(leak).
struct HostCtx {
    name: String,
}

extern "C" fn host_emit(ctx: *mut c_void, json: *const u8, len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if ctx.is_null() || json.is_null() {
            return;
        }
        let name = unsafe { &(*(ctx as *const HostCtx)).name };
        let bytes = unsafe { std::slice::from_raw_parts(json, len) };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            eprintln!("[sidecar:{name}] emit: JSON 파싱 실패({len}B) — 무시");
            return;
        };
        // 호스트 사실 가로채기 — 엔진 네이티브 서피스의 편입/해제(hitTest 위임 대상).
        // 클라이언트 relay 는 그대로 간다(플러그인이 알 필요는 없지만 막을 이유도 없다).
        if let Some(event) = native_surface_event(&value) {
            if let Some(s) = framework() {
                s.surface_alive(event.ptr, event.key, event.alive);
            }
        }
        let handles: Vec<u64> = MODULES
            .lock()
            .ok()
            .and_then(|m| m.get(name).cloned())
            .and_then(|m| m.clients.lock().ok().map(|c| c.iter().copied().collect()))
            .unwrap_or_default();
        if let Some(s) = framework() {
            for h in handles {
                s.emit(name, h, &value);
            }
        }
    });
}

extern "C" fn host_log(ctx: *mut c_void, level: i32, msg: *const u8, len: usize) {
    let _ = std::panic::catch_unwind(|| {
        if ctx.is_null() || msg.is_null() {
            return;
        }
        let name = unsafe { &(*(ctx as *const HostCtx)).name };
        let text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(msg, len) });
        let tag = match level {
            2 => "error",
            1 => "warn",
            _ => "info",
        };
        eprintln!("[sidecar:{name}] {tag}: {text}");
    });
}

// ── 경로 해소(순수) ──────────────────────────────────────────────────────────

/// 사이드카 이름 검증 — 경로 조립에 들어가므로 traversal 가드를 겸한다(매니페스트 파서와 같은 규칙).
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// dylib 자리 = `<홈>/sidecars/soksak-sidecar-{name}/dist/soksak-sidecar-{name}.dylib` 하나뿐.
/// env 바이너리 주입은 없다 — 홈이 갈리면 유닛도 갈린다(A17).
pub fn module_path(name: &str, home: &Path) -> PathBuf {
    home.join("sidecars")
        .join(format!("soksak-sidecar-{name}"))
        .join("dist")
        .join(format!("soksak-sidecar-{name}.dylib"))
}

fn resolve_module_path(name: &str, home: &Path) -> Result<PathBuf, String> {
    let path = module_path(name, home);
    if !path.is_file() {
        return Err(format!(
            "사이드카 모듈 없음: {} (설치: 플러그인 reach 또는 dev 스테이징 `make sidecar-{name}`)",
            path.display()
        ));
    }
    Ok(path)
}

// ── 적재 + ABI 검증 + init ───────────────────────────────────────────────────

unsafe fn cstr_of(p: *const c_char, what: &str) -> Result<String, String> {
    if p.is_null() {
        return Err(format!("ABI 자기보고 {what} 가 null"));
    }
    Ok(CStr::from_ptr(p).to_string_lossy().into_owned())
}

pub fn validate_sidecar_interface(
    requirement: &ContractRequirement,
    provider: &ContractProviderRef,
) -> Result<(), String> {
    if !is_sidecar_contract_id(requirement.id()) {
        return Err(format!(
            "사이드카 소비 계약 id 형식 오류: {}",
            requirement.id()
        ));
    }
    if !is_sidecar_contract_id(provider.id()) {
        return Err(format!("사이드카 공급 계약 id 형식 오류: {}", provider.id()));
    }
    if !requirement.matches(provider) {
        return Err(format!(
            "interface 불일치: 바이너리 자기보고 {{id:{},version:{}}}가 플러그인 선언 {{id:{},range:{}}}를 만족하지 않음",
            provider.id(),
            provider.version(),
            requirement.id(),
            requirement.range(),
        ));
    }
    Ok(())
}

/// init 랑데부 상한 — 메인스레드에 얹은 일이 끝나는 것이 종결 사건이고, 이 상한은 그 사건이
/// 영영 안 올 때 부팅이 멈춰 서지 않게 하는 안전망이다.
const INIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// 최초 open 시 1회 — dlopen → ABI 대조 → 메인스레드 init(랑데부). 성공 시 등록.
fn load_module(
    name: &str,
    declared_interface: &ContractRequirement,
    home: &Path,
) -> Result<Arc<EngineModule>, String> {
    let path = resolve_module_path(name, home)?;
    let lib = unsafe { libloading::Library::new(&path) }
        .map_err(|e| format!("dlopen 실패 {}: {e}", path.display()))?;

    // 심볼 해소(전부 먼저 — 하나라도 없으면 거부, 부분 적재 없음).
    // 모델 판정 = 심볼 가족 존재 그 자체(soksak_sidecar_engine_* export = engine 모델).
    let abi_fn: AbiFn = *unsafe { lib.get(b"soksak_sidecar_engine_abi\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_abi 없음(engine 모델 아님?): {e}"))?;
    let init_fn: InitFn = *unsafe { lib.get(b"soksak_sidecar_engine_init\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_init 없음: {e}"))?;
    let message: MessageFn = *unsafe { lib.get(b"soksak_sidecar_engine_message\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_message 없음: {e}"))?;
    let notify: NotifyFn = *unsafe { lib.get(b"soksak_sidecar_engine_notify\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_notify 없음: {e}"))?;
    let free: FreeFn = *unsafe { lib.get(b"soksak_sidecar_engine_free\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_free 없음: {e}"))?;
    let shutdown: ShutdownFn = *unsafe { lib.get(b"soksak_sidecar_engine_shutdown\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_shutdown 없음: {e}"))?;
    // 비-macOS 딜리버리는 tick 을 export 한다 — 부재 = 잘못된 빌드.
    #[cfg(not(target_os = "macos"))]
    let tick: TickFn = *unsafe { lib.get(b"soksak_sidecar_engine_tick\0") }
        .map_err(|e| format!("심볼 soksak_sidecar_engine_tick 없음: {e}"))?;

    // 자기기술 대조 — 무매니페스트 원칙의 검증 지점: 바이너리가 곧 진실, 선언과 불일치 = 거부.
    let abi = unsafe { abi_fn() };
    if abi.is_null() {
        return Err("soksak_sidecar_engine_abi() 가 null 반환".into());
    }
    let (abi_ver, interface_id, interface_version) = unsafe {
        (
            (*abi).abi,
            cstr_of((*abi).interface_id, "interface_id")?,
            cstr_of((*abi).interface_version, "interface_version")?,
        )
    };
    if abi_ver != HOST_ABI_VERSION {
        return Err(format!(
            "호스팅 ABI 불일치: 모듈 {abi_ver}, 코어 {HOST_ABI_VERSION}"
        ));
    }
    let provided_interface = ContractProviderRef::new(&interface_id, &interface_version)
        .map_err(|e| format!("ABI interface 자기보고 형식 오류: {e}"))?;
    validate_sidecar_interface(declared_interface, &provided_interface)?;

    // init 은 메인스레드 계약 — 프레임워크에 얹고 랑데부로 기다린다.
    let host_ctx = Box::into_raw(Box::new(HostCtx {
        name: name.to_string(),
    }));
    let host = Box::into_raw(Box::new(SoksakSidecarEngineHost {
        abi: HOST_ABI_VERSION,
        ctx: host_ctx as *mut c_void,
        emit: host_emit,
        log: host_log,
    }));
    let dist_dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let cfg = serde_json::json!({ "name": name, "distDir": dist_dir })
        .to_string()
        .into_bytes();
    let (tx, rx) = std::sync::mpsc::sync_channel::<i32>(1);
    let host_addr = host as usize;
    let s = framework().ok_or("프레임워크가 아직 설치되지 않았다(install)")?;
    s.on_main(Box::new(move || {
        let cfg = cfg; // move
        let code = unsafe {
            init_fn(
                host_addr as *const SoksakSidecarEngineHost,
                cfg.as_ptr(),
                cfg.len(),
            )
        };
        let _ = tx.try_send(code);
    }))?;
    let code = rx
        .recv_timeout(INIT_LIMIT)
        .map_err(|_| "사이드카 init 시간 초과(10s)".to_string())?;
    if code != 0 {
        return Err(format!("사이드카 init 거부(code {code}) — 로그 참조"));
    }

    // 성공 — Library 는 의도적 leak(모듈 unload 금지 계약).
    std::mem::forget(lib);
    Ok(Arc::new(EngineModule {
        name: name.to_string(),
        interface: provided_interface,
        message,
        notify,
        free,
        shutdown,
        #[cfg(not(target_os = "macos"))]
        tick,
        clients: Mutex::new(HashSet::new()),
        next_handle: AtomicU64::new(1),
    }))
}

fn get_module(name: &str) -> Result<Arc<EngineModule>, String> {
    MODULES
        .lock()
        .map_err(|e| e.to_string())?
        .get(name)
        .cloned()
        .ok_or_else(|| format!("사이드카 미로드: {name}"))
}

// ── 표면 ─────────────────────────────────────────────────────────────────────

/// 채널을 연다 — 미적재면 적재한다. 반환은 이 소비자의 핸들.
pub fn open(name: &str, requirement: &ContractRequirement, home: &Path) -> Result<u64, String> {
    if !valid_name(name) {
        return Err(format!(
            "사이드카 이름 형식 오류: {name} (^[a-z0-9][a-z0-9-]*$)"
        ));
    }
    let module = {
        let existing = MODULES.lock().map_err(|e| e.to_string())?.get(name).cloned();
        match existing {
            Some(m) => {
                // 재open 도 지금 소비자의 requirement 를 검증한다. 먼저 연 소비자의 호환
                // provider 를 이름만 같다고 다른 range 에 넘기지 않는다.
                validate_sidecar_interface(requirement, &m.interface)?;
                m
            }
            None => {
                let m = load_module(name, requirement, home)?;
                MODULES
                    .lock()
                    .map_err(|e| e.to_string())?
                    .insert(name.to_string(), m.clone());
                eprintln!(
                    "[sidecar:{name}] 로드 OK (interface id={}, version={})",
                    m.interface.id(),
                    m.interface.version()
                );
                m
            }
        }
    };
    let handle = module.next_handle.fetch_add(1, Ordering::Relaxed);
    module
        .clients
        .lock()
        .map_err(|e| e.to_string())?
        .insert(handle);
    eprintln!("[sidecar:{name}] 채널 open (handle={handle})");
    Ok(handle)
}

/// 불투명 메시지 하나. `surface` 는 부르는 창의 네이티브 부모 표면이고 **매 호출 주입된다** —
/// 이 크레이트는 프로토콜의 뜻을 모르므로 어느 메시지가 그것을 쓰는지도 모른다.
pub fn send(
    name: &str,
    handle: u64,
    payload: &str,
    surface: usize,
) -> Result<serde_json::Value, String> {
    let module = get_module(name).inspect_err(|e| eprintln!("[sidecar:{name}] send 거부: {e}"))?;
    if !module
        .clients
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&handle)
    {
        eprintln!(
            "[sidecar:{name}] send 거부: 무효 핸들 {handle} (payload {} bytes)",
            payload.len()
        );
        return Err(format!("무효 핸들: {handle}"));
    }
    let mut reply = SoksakBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
        cap: 0,
    };
    let code = unsafe { (module.message)(payload.as_ptr(), payload.len(), surface, &mut reply) };
    let body = if reply.ptr.is_null() {
        Vec::new()
    } else {
        let v = unsafe { std::slice::from_raw_parts(reply.ptr, reply.len) }.to_vec();
        unsafe { (module.free)(reply) };
        v
    };
    match code {
        0 => serde_json::from_slice(&body).map_err(|e| format!("모듈 응답 JSON 파싱 실패: {e}")),
        -2 => Err("사이드카 모듈 내부 패닉(트랩됨) — 로그 참조".into()),
        c => {
            let msg = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| format!("모듈 오류(code {c})"));
            Err(msg)
        }
    }
}

/// 채널만 닫는다. 모듈은 상주 유지 — unload 금지 계약.
pub fn close(name: &str, handle: u64) -> Result<(), String> {
    let module = get_module(name)?;
    module
        .clients
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&handle);
    eprintln!("[sidecar:{name}] 채널 close (handle={handle})");
    Ok(())
}

/// 적재된 모든 엔진 모듈에 호스트 사실 통지(v1: surface-occluded·surface-closing). 0개면 no-op.
pub fn notify_all(evt: &serde_json::Value) {
    let modules: Vec<Arc<EngineModule>> = match MODULES.lock() {
        Ok(m) => m.values().cloned().collect(),
        Err(_) => return,
    };
    if modules.is_empty() {
        return;
    }
    let bytes = evt.to_string().into_bytes();
    for m in modules {
        unsafe { (m.notify)(bytes.as_ptr(), bytes.len()) };
    }
}

/// 앱 종료 시에만(메인스레드). 이 뒤로 모듈 호출 없음.
pub fn shutdown_all() {
    let modules: Vec<Arc<EngineModule>> = match MODULES.lock() {
        Ok(mut m) => m.drain().map(|(_, v)| v).collect(),
        Err(_) => return,
    };
    for m in modules {
        eprintln!("[sidecar:{}] shutdown", m.name);
        unsafe { (m.shutdown)() };
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
