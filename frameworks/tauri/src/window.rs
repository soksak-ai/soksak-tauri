// 멀티 윈도우 — 새 OS 창 생성·열거·포커스·닫기. 같은 frontendDist 를 로드해 각 창이 독립
// 작업공간(프로젝트 탭/세션)이 된다(sessions store 는 메모리라 webview 별 JS 컨텍스트가 자연 격리;
// settings/theme/plugins 는 localStorage 공유 — 의도적 전역). 소켓·플러그인·설정은 1 프로세스 공유.
//
// 새 창은 생성 직후 그 label 로 네이티브 hook(레이어 역전·신호등)을 설치해 hole-punch 브라우저가
// 이 창에서도 동작한다(P0 창별 HashMap 덕 — webview.rs layer 참조).

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

/// 물리 픽셀 창 크기를 **적용 완료 후** 답하는 Tauri 경계.
///
/// tao의 macOS `set_inner_size`는 `setContentSize:`를 메인 GCD 큐에 async dispatch하고 즉시
/// 반환한다. 그 SDK Promise를 완료 계약으로 노출하면 다음 크기·캡처가 이전 resize와 겹쳐
/// WindowServer의 확대/축소 중간 합성물이 실제 프레임으로 보인다. 이 명령은 메인 스레드에서
/// 크기와 AppKit layout/display를 한 transaction으로 적용하고, 그 closure의 완료를 기다린다.
#[tauri::command]
pub async fn window_set_physical_size(
    app: AppHandle,
    label: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("창 크기는 0보다 커야 한다".into());
    }
    let window = app
        .get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?;

    #[cfg(target_os = "macos")]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
        if ptr == 0 {
            return Err(format!("창의 NSWindow를 찾지 못했다: {label}"));
        }
        let resize_label = label.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app.run_on_main_thread(move || {
            use objc2_foundation::NSSize;
            let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            native.setContentSize(NSSize::new(width as f64 / scale, height as f64 / scale));
            // setContentSize는 NSWindow frame을 먼저 바꾸고 content hierarchy의 bounds 정착은
            // layout에서 끝낸다. affine 투영이 이전 parent bounds를 읽지 않게 순서를 고정한다.
            native.layoutIfNeeded();
            crate::webview::resize_registered_surface_hosts(&resize_label);
            crate::webview::appkit_events::commit_resize_composition(native);
            let _ = tx.send(Ok(()));
        })
        .map_err(|e| e.to_string())?;
        return rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| format!("창 resize transaction 시간 초과: {label}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_size(tauri::PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())
    }
}

// 한 창의 네이티브를 설치하는 단일 진입점(MW1) — main(setup)·새 창(window_create)이 같은 함수를
// 호출해 중복·누락을 막는다. 레이어 역전(hole-punch)과 신호등을 그 창에 건다. 앱 전역 모니터
// (클릭·라이브리사이즈)는 창과 무관하게 1회만 설치되므로 여기 포함하지 않는다(lib.rs setup).
// 신호등 inset 좌표(conf trafficLightPosition, 전 창 공통 정책·단일 진실). 미설정 시 (12,20).
// 창별 즉시 적용(install_window_natives)과 앱 전역 유지 옵저버(titlebar::install_global_observers)가 공유.
#[cfg(target_os = "macos")]
pub fn traffic_light_inset(app: &AppHandle) -> (f64, f64) {
    app.config()
        .app
        .windows
        .first()
        .and_then(|w| w.traffic_light_position.as_ref())
        .map(|p| (p.x, p.y))
        .unwrap_or((12.0, 20.0))
}

#[cfg(target_os = "macos")]
pub fn install_window_natives(app: &AppHandle, label: &str) {
    crate::webview::install_layer_inversion(app, label);
    if let Some(window) = app.get_window(label) {
        // 이 창의 가시 내용은 DOM WKWebView·child WKWebView·CEF remote layer처럼 각자
        // compositor를 가진 표면의 합성이다. AppKit 기본값(true)의 옛 backing 보존은 이 구조에서
        // resize epoch가 다른 표면을 한 프레임으로 늘여 붙인다. 보존을 끄면 각 표면이 새 bounds를
        // 직접 다시 그리며, Tauri 어댑터 밖(Electron DOM 창)에는 이 정책이 존재하지 않는다.
        if let Ok(ptr) = window.ns_window() {
            let ns = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
            ns.setPreservesContentDuringLiveResize(false);
        }
        // NSWindow↔label 캐시 등록 — AppKit 통지 블록이 wry 를 묻지 않고 역해소하게(webview.rs).
        crate::webview::appkit_events::note_nswindow_label(&window);
        let (x, y) = traffic_light_inset(app);
        crate::titlebar::install(&window, x, y);
    }
}

// 새 창 생성(소켓 명령 window.new 의 핸들러). 본체는 create_window 가 소유 — Dock 메뉴 등 명령 밖
// 호출처와 공용이다.
//
// label/rect = 재시작 복원 리스폰(B2) 전용: manifest slot 의 라벨을 그대로 재사용해 그 창의
// 스냅샷 키("window/<label>")가 일치하게 하고, 저장된 프레임(논리 px)으로 같은 자리에 만든다.
// label 지정 창은 fresh 기본이 붙지 않는다(복원이 목적). 이미 존재하는 label 은 멱등(그대로 반환).
#[tauri::command]
pub fn window_create(
    app: AppHandle,
    init: Option<String>,
    label: Option<String>,
    rect: Option<serde_json::Value>,
    // 창을 앞으로 가져와 포커스할지. 기본 true(사용자가 새 창을 열면 그 창이 자연스럽게 포커스).
    // 재시작 복원(리스폰)은 false — 백그라운드로 되살리고 현재 포커스(오케스트레이터 등)를 뺏지 않는다.
    focus: Option<bool>,
) -> Result<String, String> {
    // 포커스 기본·rect 판정은 코어가 소유한다 — 갈리면 같은 복원이 한쪽에서만 자리를 지킨다.
    let focus = soksak_core::window_spec::should_focus(focus);
    match label {
        None => create_window_init(&app, init.as_deref(), focus),
        Some(label) => {
            if app.get_window(&label).is_some() {
                return Ok(label); // 멱등 — 리스폰 재호출 무해
            }
            let num = |k: &str| rect.as_ref().and_then(|v| v.get(k)).and_then(|n| n.as_f64());
            let r = soksak_core::window_spec::rect_of(num("x"), num("y"), num("w"), num("h"))
                .map(|r| (r.x, r.y, r.w, r.h));
            create_window_labeled(&app, &label, r, init.as_deref(), focus)
        }
    }
}

// 새 창 생성(기존 시그니처 유지 — Dock 메뉴 등 init 불요 호출부). 사용자 행위라 포커스한다.
// 현재 유일 호출부가 macOS Dock 메뉴(dockmenu, cfg macos)라 다른 OS 에선 미사용.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn create_window(app: &AppHandle) -> Result<String, String> {
    create_window_init(app, None, true)
}

// 새 창 생성 본체. label = "w-<uuid4>" — 불투명·비재사용 식별자(NAMING). uuid 라 라벨이
// 세션 간 우연히 재사용될 수 없고, 죽은 세션의 영속 슬롯을 유령 복원하는 부류가 존재 자체로
// 불가능하다(과거 win-<seq> 재사용의 실측 사고 근치 — fresh 플래그 패치는 폐기).
// 의도적 재사용은 respawn 뿐: manifest 의 같은 uuid 로 재생성해 그 창의 스냅샷을 되살린다.
// 메인 스레드에서 호출해야 안전(WebviewWindowBuilder). 명령(window_create)과 Dock 메뉴(dockmenu)가
// 공유하는 단일 진입점.
//
// init = 새 창 부트 지시 쿼리스트링("root=<enc>" 등, '?' 제외). 새 창의 main.tsx 부트가
// location.search 로 읽는다 — 창 생성자가 프론트 상태에 직접 손대지 않는 유일한 전달 통로
// (창별 JS 컨텍스트 분리 원칙). 코어는 쿼리의 의미를 강제하지 않는다(부트가 해석).
pub fn create_window_init(
    app: &AppHandle,
    init: Option<&str>,
    focus: bool,
) -> Result<String, String> {
    // 새 창을 트리거한(현재 활성) 창의 위치·배율을 빌드 전에 캡처 — 빌드 후엔 새 창이 포커스를
    // 가져가 활성 창이 바뀐다. 단일 창("main") 하드코딩이 아니라 is_focused 로 동적 판정(MW1).
    // windows()(Window 레지스트리) — 브라우저 연 창도 포함해야 그 창에서 Cmd+N 한 경우 소스로 잡힌다.
    let src = app
        .windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?)));

    let label = format!("w-{}", uuid::Uuid::new_v4());
    create_window_core(app, &label, init, focus)?;

    // 활성 창에서 가로·세로 ~1cm(28pt) 캐스케이드 — 정확히 겹치면 새 창이 떴는지 눈으로 알 수 없다.
    // 물리 좌표를 배율로 나눠 논리 좌표로 환산 → 어느 DPI 든 시각적 1cm. 소스 창이 없으면 OS 기본 위치.
    if let (Some((pos, scale)), Some(win)) = (src, app.get_window(&label)) {
        const CASCADE_PT: f64 = 28.0; // ~1cm (72pt = 1in = 2.54cm)
        let _ = win.set_position(tauri::LogicalPosition::new(
            pos.x as f64 / scale + CASCADE_PT,
            pos.y as f64 / scale + CASCADE_PT,
        ));
    }
    Ok(label)
}

// 재시작 복원 리스폰(B2) — manifest slot 라벨로 창을 만들고 저장된 프레임(논리 px)을 적용한다.
// 캐스케이드 없음(제자리 복원). fresh 기본 없음(이 창의 스냅샷 복원이 목적).
fn create_window_labeled(
    app: &AppHandle,
    label: &str,
    rect: Option<(f64, f64, f64, f64)>,
    init: Option<&str>,
    focus: bool,
) -> Result<String, String> {
    create_window_core(app, label, init, focus)?;
    if let (Some((x, y, w, h)), Some(win)) = (rect, app.get_window(label)) {
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    }
    Ok(label.to_string())
}

// 창 생성 공용 골격 — conf windows[0] 상속 + label 교체 + init 쿼리 + 네이티브 설치.
fn create_window_core(
    app: &AppHandle,
    label: &str,
    init: Option<&str>,
    focus: bool,
) -> Result<(), String> {
    // 메인 창 설정(tauri.conf.json windows[0])을 통째로 상속하고 label 만 교체한다 — 타이틀·
    // titleBarStyle·hiddenTitle·신호등·decorations·transparent 등 모든 속성이 메인과 정합한다.
    // 수동 빌더로 일부 속성만 옮기면 conf 와 어긋난다(타이틀 "soksak" 고정, 드래그영역/장식 손실).
    // 단일 진실 = conf. 새 창이 늘어도 메인 창 설정을 바꾸면 같이 따라온다.
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "창 설정 없음(tauri.conf.json windows[0])".to_string())?;
    cfg.label = label.to_string();
    // 포커스는 임의로 주지 않는다 — 리스폰(focus=false)은 백그라운드로 되살리고 현재 포커스를
    // 뺏지 않는다. 사용자가 연 새 창(focus=true)만 자연스럽게 앞으로 온다(conf 기본 상속 대신 명시).
    cfg.focus = focus;
    if let Some(q) = init {
        // conf url(App("index.html") | External(devUrl))에 부트 지시 쿼리 부여.
        use tauri::WebviewUrl;
        cfg.url = match &cfg.url {
            WebviewUrl::External(u) => {
                let mut u2 = u.clone();
                u2.set_query(Some(q));
                WebviewUrl::External(u2)
            }
            WebviewUrl::App(p) => {
                let s = p.to_string_lossy();
                let joined = if s.contains('?') {
                    format!("{s}&{q}")
                } else {
                    format!("{s}?{q}")
                };
                WebviewUrl::App(joined.into())
            }
            other => other.clone(),
        };
    }
    WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    // 이 창에 네이티브 설치(레이어 역전·신호등) — main 과 동일한 단일 진입점.
    #[cfg(target_os = "macos")]
    install_window_natives(app, label);

    // 창 생성의 완료 조건에는 명령 주소 등록이 포함된다. focus=false 복원 창은 Focused(true)
    // 사건을 내지 않으므로 포커스 콜백에 맡기면 window.list에는 보이지만 cored는 못 찾는 창이
    // 된다. 상관 응답을 기다리는 사건 경로이며 폴링하지 않는다.
    #[cfg(unix)]
    let settled = crate::cored_host::current()
        .ok_or_else(|| "cored 창 호스트가 없어 생성된 창을 명령 주소로 등록할 수 없다".to_string())
        .and_then(|host| host.windows_settled(std::time::Duration::from_secs(5)));
    if let Err(why) = settled {
        // 주소 없는 창을 성공 산출물로 남기지 않는다. 아직 프론트 부트가 시작되기 전의 새 창만
        // 되돌리며, 실패도 숨기지 않고 호출자에게 원인과 함께 돌려준다.
        let rollback = app
            .get_window(label)
            .ok_or_else(|| format!("새 창 주소 등록 실패({why}); 되돌릴 창도 없다: {label}"))?
            .destroy()
            .map_err(|e| format!("새 창 주소 등록 실패({why}); 창 되돌리기도 실패했다: {e}"));
        return match rollback {
            Ok(()) => Err(format!("새 창 주소 등록 실패로 생성을 되돌렸다: {why}")),
            Err(e) => Err(e),
        };
    }
    Ok(())
}

// ── 창 닫힘 의미론(B1) ───────────────────────────────────────────────────────
// 명시 종료(Cmd+Q/app.exit)=전 창 세션 보존(재시작 복원 대상), 사용자 개별 닫기(빨간 버튼·
// window.close)=그 창 세션 폐기. 폐기는 두 단계다: CloseRequested 에서 "사용자 닫기" 마크만
// 남기고, 실제 정리는 Destroyed 에서 한다 — 웹뷰 unload(pagehide)의 마지막 저장이 정리 *뒤에*
// 도착해 스냅샷을 부활시키는 순서 결함을 피한다(저장→파괴→정리 순서 보장). 앱 종료의 창
// 파괴는 CloseRequested 를 지나지 않아 마크가 없고, 아무것도 지우지 않는다.

static USER_CLOSED: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

// ── 파괴 순서 계약의 재진입 금지 ─────────────────────────────────────────────
// 엔진 child 회수(sidecar surface-closing)는 창 dealloc 전에 끝나야 한다. 그런데 그것을
// CloseRequested 콜백 안에서 그대로 하면 회수가 다시 창 메시지를 태우고, 이벤트 루프가 이미
// 창 맵을 빌린 상태라 프로세스가 패닉한다(실측: `RefCell already mutably borrowed`,
// tauri-runtime-wry lib.rs:3273 — 크로미움 뷰가 있는 창을 닫으면 앱이 죽었다).
//
// 그래서 닫기를 한 번 보류한다: 첫 CloseRequested 는 prevent_close 하고 회수를 메인 스레드의
// 다음 차례로 미룬 뒤 다시 close 를 건다. 두 번째 진입은 회수가 끝난 상태이므로 그대로
// 통과한다. 계약(회수가 dealloc 보다 먼저)은 지키면서 재진입만 없앤다.
static TEARDOWN_STARTED: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// 이 창의 회수를 지금 시작하는가 — 처음 한 번만 true(그때만 보류한다).
pub fn begin_teardown(label: &str) -> bool {
    let mut g = TEARDOWN_STARTED.lock().unwrap();
    g.get_or_insert_with(Default::default)
        .insert(label.to_string())
}

/// Destroyed — 회수 마크 폐기(창 label 은 재사용되지 않지만 맵을 키우지 않는다).
pub fn forget_teardown(label: &str) {
    if let Ok(mut g) = TEARDOWN_STARTED.lock() {
        if let Some(s) = g.as_mut() {
            s.remove(label);
        }
    }
}

/// CloseRequested — 사용자가 이 창을 닫는 중임을 기록.
pub fn mark_user_closed(label: &str) {
    let mut g = USER_CLOSED.lock().unwrap();
    g.get_or_insert_with(Default::default)
        .insert(label.to_string());
}

/// Destroyed — 사용자 닫기였는지 회수(1회성). 앱 종료 경로는 false.
pub fn take_user_closed(label: &str) -> bool {
    let mut g = USER_CLOSED.lock().unwrap();
    g.as_mut().map(|s| s.remove(label)).unwrap_or(false)
}

// 창 영속 흔적 정리 — 사용자 개별 닫기의 Destroyed 에서만 호출된다(위 의미론).
// 지우는 것: ① 그 창의 워크스페이스 스냅샷(core kv "window/<label>") ② manifest("windows")의
// 그 창 slot. 식별자가 uuid 라 유령 복원은 없지만, 닫힌 창의 흔적을 남기면 죽은 슬롯이
// manifest 에 쌓여 respawn 대상을 오염시킨다 — 사용자 닫기 = 흔적 폐기가 위생이다.
// 무엇이 흔적인지는 코어가 정한다(soksak_core::window_traces) — 이 자리는 연결을 쥔 쪽이다.
// 여기서 규칙을 한 벌 더 적으면 다른 프레임워크의 폐기와 갈라지고, 그 어긋남은 오류가 아니라
// "한쪽에서만 창이 되살아난다"로 나타난다.
pub fn prune_window_persistence(conn: &rusqlite::Connection, label: &str) -> Result<(), String> {
    use soksak_core::window_traces as traces;
    soksak_store::store::kv_delete(conn, traces::NS, &traces::snapshot_key(label))?;
    if let Some(mut m) = soksak_store::store::kv_get(conn, traces::NS, traces::MANIFEST_KEY)? {
        if traces::prune_slot(&mut m, label) {
            soksak_store::store::kv_set(conn, traces::NS, traces::MANIFEST_KEY, &m)?;
        }
    }
    Ok(())
}

// 열린 창 label 목록(소켓/CLI introspection — window 명시 타겟 조회). windows()(Window 레지스트리)
// 를 쓴다 — 브라우저 child 를 연 창은 멀티-webview 라 webview_windows() 에서 빠져 목록에 안 잡힌다.
#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<String> {
    app.windows().keys().cloned().collect()
}

/// 지금 살아 있는 창 라벨 — **모든 호스트의 것**. 못 알아내면 `None`.
///
/// `window_list` 로는 답이 안 된다: 그건 이 프로세스의 창만 센다. 같은 홈을 다른 프레임워크가
/// 함께 보고 있으면 상대가 든 창이 "없다"로 읽히고, 그 창의 라벨을 이쪽이 또 만든다 — 같은
/// 라벨의 창이 두 프로세스에 살아나면 나중 것이 아무것도 그리지 않는다(A23).
///
/// 그래서 모든 호스트를 아는 쪽(cored)에 묻는다. 안 붙어 있으면 창 가진 프로세스는 이쪽뿐이라
/// 자기 목록이 곧 전부다 — 폴백이 아니라 위상이다.
///
/// 실패는 빈 목록으로 뭉개지 않는다. 빈 목록은 "아무도 안 들었다"라서 전부 되살리게 되고,
/// 그것이 이 함수가 막으려는 바로 그 겹침이다.
/// 지금 살아 있는 창 라벨 — **모든 호스트의 것**. 못 알아내면 `None`.
///
/// `window_list` 로는 답이 안 된다: 그건 이 프로세스의 창만 센다. 같은 홈을 다른 프레임워크가
/// 함께 보고 있으면 상대가 든 창이 "없다"로 읽히고, 그 라벨을 이쪽이 또 만든다 — 같은 라벨의
/// 창이 두 프로세스에 살아나면 나중 것이 아무것도 그리지 않는다(A23).
///
/// 모양은 코어가 소유한다(`soksak_core::window_census`) — 여기서 손으로 적으면 cored 와 두 벌이
/// 되고, 부르는 쪽은 누가 답했는지 모르므로 갈리면 한쪽에서만 조용히 파싱이 빈다.
/// 붙어 있으면 붙은 호스트를 전부 아는 쪽이 답한다. 안 붙어 있으면 창 가진 프로세스는
/// 이쪽뿐이라 자기 목록이 곧 전부다 — 폴백이 아니라 위상이다.
#[tauri::command]
pub fn window_census(app: AppHandle) -> Option<serde_json::Value> {
    use soksak_core::window_census as census;
    if let Some(host) = crate::cored_host::current() {
        let ask = host.ask("window_census", &serde_json::json!({}), std::time::Duration::from_secs(5));
        return Some(census::reply(census::from_reply(&ask.ok()?)?));
    }
    Some(census::reply(census::of_labels(app.windows().keys(), None)))
}

// 모니터·창 배치 팩트(A4) — 판단 없이 사실만: 모니터 목록(물리 px rect·배율·이름)과
// 각 창의 물리 rect + 소속 모니터 인덱스. 전략(어디에 둘지)은 layout.suggest 순수함수가
// 프론트에서 계산한다(팩트/전략 분리 — 확정 결정).
#[tauri::command]
pub fn window_monitors(app: AppHandle) -> Result<serde_json::Value, String> {
    let monitors: Vec<tauri::Monitor> = app.available_monitors().map_err(|e| e.to_string())?;
    let mons: Vec<serde_json::Value> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::json!({
                "index": i,
                "name": m.name().cloned().unwrap_or_default(),
                "x": m.position().x,
                "y": m.position().y,
                "w": m.size().width,
                "h": m.size().height,
                "scale": m.scale_factor(),
            })
        })
        .collect();
    let mut wins: Vec<serde_json::Value> = Vec::new();
    for (label, w) in app.windows() {
        let pos = w.outer_position().map_err(|e| e.to_string())?;
        let size = w.outer_size().map_err(|e| e.to_string())?;
        // 소속 판정은 코어가 소유한다 — 두 벌이면 같은 창을 프레임워크마다 다른 모니터로 답한다.
        use soksak_core::geometry::{monitor_of, Rect};
        let rects: Vec<Rect> = monitors
            .iter()
            .map(|m| Rect {
                x: m.position().x,
                y: m.position().y,
                w: m.size().width as i32,
                h: m.size().height as i32,
            })
            .collect();
        let monitor = monitor_of(
            Rect { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 },
            &rects,
        );
        wins.push(serde_json::json!({
            "label": label,
            "title": w.title().unwrap_or_default(),
            "alwaysOnTop": w.is_always_on_top().unwrap_or(false),
            "x": pos.x,
            "y": pos.y,
            "w": size.width,
            "h": size.height,
            "focused": w.is_focused().unwrap_or(false),
            "monitor": monitor,
        }));
    }
    Ok(serde_json::json!({ "monitors": mons, "windows": wins }))
}

// 창 배치 실행(A4) — 물리 px(window_monitors 와 같은 좌표계)로 위치+크기 1회 적용.
#[tauri::command]
pub fn window_place(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let win = app
        .get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?;
    win.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    app.get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .set_focus()
        .map_err(|e| e.to_string())
}

/// 이 창의 웹뷰를 다시 적재한다 — **파괴를 관측하는 쪽이 자국을 남긴다.**
///
/// 예전에는 프론트가 `location.reload()` 를 불렀다. 그러면 렌더러가 자기를 죽이는 셈이라
/// 자기 죽음을 기록할 수 없다: 활동 발행은 fire-and-forget 이고 창이 죽는 순간 끊긴다.
/// 실측(2026-08-01) — 다른 명령은 전부 원장에 남는데 `window.reload` 만 `command.executed`
/// 조차 안 남았고, 리로드가 창을 응답 불능으로 만들어도 사유가 어디에도 없었다.
///
/// 여기서 부르면 죽는 것은 렌더러고 **부르는 쪽은 산다.** 그래서 `command.executed` 가 살아
/// 남는다 — 실측 2026-08-01: 이 경로로 바꾸자 그 줄이 원장에 처음으로 남았다(seq 로 확인).
///
/// 여기서 별도 자국을 더 남기려 했으나 그 발행이 원장에 나타나지 않았고 사유를 못 찾았다.
/// 확인 못 한 것은 넣지 않는다 — 자국을 남기는 척하는 코드는 없는 것보다 나쁘다.
#[tauri::command]
pub fn window_reload(app: AppHandle, label: String) -> Result<(), String> {
    // **`get_webview_window` 을 쓰지 않는다.** 그것은 단일-webview 창 전용이라, 브라우저 child 를
    // 연 창은 거기서 빠진다 — 이 저장소가 이미 겪고 ipc.rs 에 적어 둔 함정이다(그걸 쓰면 그런
    // 창의 명령이 전부 WINDOW_NOT_FOUND). 창 생존은 오라클이 말한다.
    let wv = app
        .get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?;
    // 이 창의 **메인 webview** 에 실행시킨다. 라벨이 같은 것이 그 창의 메인이고, `b-` 로 시작하는
    // 형제(브라우저 child)는 남의 페이지라 건드리지 않는다.
    let _ = wv;
    let main = app
        .webviews()
        .into_iter()
        .find(|(l, _)| l == &label)
        .map(|(_, w)| w)
        .ok_or_else(|| format!("이 창의 웹뷰를 못 잡았다: {label}"))?;
    main.eval("window.location.reload()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(app: AppHandle, label: String) -> Result<(), String> {
    app.get_window(&label)
        .ok_or_else(|| format!("창 없음: {label}"))?
        .close()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod window_tests;
