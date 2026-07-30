// 사이드카 호스팅의 **프레임워크 몫** — 이 파일에 남은 것은 셋뿐이다.
//
//   ① 네이티브 부모 표면: 창의 엔진 호스트 컨테이너(NSView·HWND·XID). 프로세스-로컬이라
//      다른 프로세스가 대신 줄 수 없다.
//   ② 메인스레드 실행: 엔진 init/shutdown 은 이 런루프의 계약이다.
//   ③ 사건 싱크: 엔진이 낸 사건을 그 창의 구독자(ipc Channel)에게 흘린다.
//
// 그 밖의 전부 — dlopen, 심볼 해소, ABI 악수, 모듈·클라이언트 장부, 메시지 중개, 통지, 종료 —
// 는 `soksak-sidecar-host` 가 진다. 한때 그 몸이 여기 살았고, 671줄 중 프레임워크를 부르는 줄은
// 22줄이었다. 그 배치는 결정이 아니라 이력이다: 앱이 유일한 백엔드이던 시절에 규칙이 앱 폴더
// 안에서 자랐다.
//
// ABI 정본은 docs/SIDECARS.md §3.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use soksak_sidecar_host as host;
use soksak_spec_contract::ContractRequirement;
use tauri::ipc::Channel;

/// 사건 싱크 — 핸들마다 그 소비자의 채널. 호스팅은 핸들만 알고, 무엇으로 배달하는지는 여기 있다.
static CHANNELS: LazyLock<Mutex<HashMap<u64, Channel<serde_json::Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 프레임워크가 지는 셋의 구현.
struct TauriFramework {
    app: tauri::AppHandle,
}

impl host::Framework for TauriFramework {
    fn on_main(&self, job: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        // 랑데부·상한은 호스팅이 진다 — 여기서는 얹기만 한다.
        self.app.run_on_main_thread(job).map_err(|e| e.to_string())
    }

    fn emit(&self, _name: &str, handle: u64, event: &serde_json::Value) {
        if let Ok(chs) = CHANNELS.lock() {
            if let Some(ch) = chs.get(&handle) {
                let _ = ch.send(event.clone());
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn surface_alive(&self, ptr: usize, alive: bool) {
        if alive {
            crate::webview::register_engine_surface(ptr);
        } else {
            crate::webview::unregister_engine_surface(ptr);
        }
    }
}

/// 부팅 1회 — lib.rs setup 에서 부른다.
pub fn install(app: &tauri::AppHandle) {
    host::install(Arc::new(TauriFramework { app: app.clone() }));
}

/// 적재된 엔진 펌프를 한 번 돌린다 — 런루프 콜백이 곧 tick 원천이다.
#[cfg(not(target_os = "macos"))]
pub fn engine_tick_all() {
    host::tick_all();
}


static SURFACES: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn content_view_of(window: &tauri::Window) -> Result<usize, String> {
    let label = window.label().to_string();
    if let Some(&ptr) = SURFACES.lock().ok().as_ref().and_then(|m| m.get(&label)) {
        return Ok(ptr);
    }
    use std::sync::mpsc;
    let (tx, rx) = mpsc::sync_channel::<usize>(1);
    let win = window.clone();
    // 엔진 호스트 컨테이너 취득은 macOS objc 경로에만 있어 다른 OS 에선 이 클론이 쓰이지 않는다.
    #[cfg(target_os = "macos")]
    let label_for_host = label.clone();
    window
        .run_on_main_thread(move || {
            let mut ptr = 0usize;
            #[cfg(target_os = "macos")]
            unsafe {
                // 격리 계약(webview.rs docs): 모듈에는 contentView 가 아니라 코어 소유 엔진 호스트
                // 컨테이너를 넘긴다 — 모듈 결함의 피해가 컨테이너로 국한되고 contentView 는 불가침.
                // 컨테이너 취득 실패(미설치 창 등) 시에만 contentView 로 폴백(hitTest 형제 경로가
                // 그대로 동작 — 격리는 심층방어). 둘 다 메인 스레드 필수(이 클로저가 메인).
                if let Some(host) = crate::webview::layer_ensure_engine_host(&label_for_host) {
                    ptr = host;
                } else if let Ok(ns) = win.ns_window() {
                    let win_obj = &*(ns as *const objc2::runtime::AnyObject);
                    let content: *mut objc2_app_kit::NSView =
                        objc2::msg_send![win_obj, contentView];
                    ptr = content as usize;
                }
            }
            // 비-macOS 부모 핸들 — windows=HWND·linux=X11 XID(Xlib). 브라우저 프레젠터가 이 핸들 아래
            // child 창을 만든다(사이드카 하니스가 5플랫폼 CI 로 검증한 raw-window-handle 패턴과 동일).
            // macOS 의 엔진호스트 컨테이너 격리(CALayer)는 비-macOS 엔 아직 없어 raw 부모 핸들을 직접 넘긴다.
            // linux 는 X11 백엔드 전제(Wayland 는 GDK_BACKEND=x11) — 프레젠터가 x11-dl 로 child 를 만든다.
            #[cfg(not(target_os = "macos"))]
            {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(h) = win.window_handle() {
                    match h.as_raw() {
                        #[cfg(target_os = "windows")]
                        RawWindowHandle::Win32(w) => ptr = w.hwnd.get() as usize,
                        #[cfg(target_os = "linux")]
                        RawWindowHandle::Xlib(w) => ptr = w.window as usize,
                        _ => {}
                    }
                }
            }
            let _ = tx.try_send(ptr);
        })
        .map_err(|e| e.to_string())?;
    let ptr = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "NSView 취득 시간 초과".to_string())?;
    if ptr == 0 {
        return Err("NSView 취득 실패".into());
    }
    if let Ok(mut m) = SURFACES.lock() {
        m.insert(label, ptr);
    }
    Ok(ptr)
}

// 창 파괴 시 캐시 무효화 — lib.rs WindowEvent::Destroyed 에서 호출(stale 포인터 방지).
pub fn forget_window(label: &str) {
    if let Ok(mut m) = SURFACES.lock() {
        m.remove(label);
    }
}

// ── Tauri 커맨드(레지스트리 미노출 — app.sidecar 전용 내부 전송) ──────────────────────────────

// ── Tauri 커맨드(레지스트리 미노출 — app.sidecar 전용 내부 전송) ──────────────

#[tauri::command]
pub fn sidecar_open(
    window: tauri::Window,
    name: String,
    requirement: ContractRequirement,
    on_event: Channel<serde_json::Value>,
) -> Result<u64, String> {
    // 표면을 먼저 세운다 — 적재가 성공했는데 얹을 자리가 없으면 그 사실이 첫 create 까지 숨는다.
    let _ = content_view_of(&window)?;
    let handle = host::open(&name, &requirement, crate::identity::ambient().home())?;
    CHANNELS
        .lock()
        .map_err(|e| e.to_string())?
        .insert(handle, on_event);
    Ok(handle)
}

#[tauri::command]
pub fn sidecar_send(
    window: tauri::Window,
    name: String,
    handle: u64,
    payload: String,
) -> Result<serde_json::Value, String> {
    let surface = content_view_of(&window)?;
    host::send(&name, handle, &payload, surface)
}

// 사이드카 공급(fetch reach) — 미설치면 sha256 핀 아카이브(dist tar.gz)를 받아 설치. 멱등:
// entry(dylib) 존재 = "present" 즉시 반환. 경로는 이름에서만 파생(경로 주입 없음 — traversal 가드).
#[tauri::command]
pub fn sidecar_ensure(name: String, url: String, sha256: String) -> Result<String, String> {
    if !host::valid_name(&name) {
        return Err(format!("사이드카 이름 형식 오류: {name}"));
    }
    // dest = dist 디렉터리 자체(아카이브 = dist 내용물). 사이드카 루트는 이미 있을 수 있다
    // (백업·데이터) — 원자 rename 의 대상은 항상 새로 생기는 dist 다.
    let dest = crate::identity::ambient()
        .path("sidecars")
        .join(format!("soksak-sidecar-{name}"))
        .join("dist");
    let entry = format!("soksak-sidecar-{name}.dylib");
    if dest.join(&entry).is_file() {
        return Ok("present".into());
    }
    eprintln!("[sidecar:{name}] fetch 설치 시작: {url}");
    soksak_install::download_unpack_verify(&url, &sha256, &dest, &entry)
        .inspect_err(|e| eprintln!("[sidecar:{name}] fetch 설치 실패: {e}"))?;
    eprintln!("[sidecar:{name}] fetch 설치 완료: {}", dest.display());
    Ok("fetched".into())
}

#[tauri::command]
pub fn sidecar_close(name: String, handle: u64) -> Result<(), String> {
    CHANNELS.lock().map_err(|e| e.to_string())?.remove(&handle);
    host::close(&name, handle)
}

// ── 호스트→모듈 통지 ─────────────────────────────────────────────────────────

// 파괴 순서 계약(docs/SIDECARS.md) — 창이 닫히기 전에(메인 스레드) 그 창의 표면에 부모 지정된
// 엔진 child 를 엔진이 먼저 닫도록 통지한다. 살아 있는 엔진 뷰 위에서 창 dealloc 이 진행되는
// 것을 금지하는 수명 규칙이고, 닫힘이 Destroyed 에 못 닿는 좀비 창 부류의 구조적 차단이다.
#[cfg(target_os = "macos")]
pub fn notify_surface_closing(window: &tauri::Window) {
    match content_view_of(window) {
        Ok(view) => {
            eprintln!(
                "[sidecar] surface-closing 통지 (window={}, view={view:#x})",
                window.label()
            );
            host::notify_all(&serde_json::json!({ "type": "surface-closing", "view": view }));
        }
        Err(e) => eprintln!(
            "[sidecar] surface-closing: content view 실패 ({}): {e}",
            window.label()
        ),
    }
}

pub fn notify_all(evt: &serde_json::Value) {
    host::notify_all(evt);
}

pub fn shutdown_all() {
    host::shutdown_all();
}
