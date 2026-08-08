mod activity;
mod ai_session;
mod app_nap;
mod boot_trace;
// 이 프레임워크가 cored 의 창 호스트가 되는 자리. `pub` 인 이유는 검증이다 — 붙는 계약은
// 소켓 위에서 재야 하고(tests/attaches_to_cored.rs), 통합 검사는 이 크레이트 **밖**에서 돈다.
// 배달 통로는 유닉스 소켓이라 cored 자신과 같은 축으로 가른다(cored 는 unix 전용이다).
#[cfg(unix)]
pub mod cored_host;
mod daemon;
mod data;
#[cfg(target_os = "macos")]
mod dockmenu;
mod fs;
mod headless;
mod home;
mod login_shell;
mod http;
mod i18n;
pub mod ipc;
mod mediaproxy;
mod navigation_policy;
mod network;
mod notify;
mod os_key;
mod plugins;
mod process;
mod id_registry;
mod project_registry;
mod pty;
mod pty_delivery;
mod activity_sink;
#[cfg(test)]
mod cored_ledger;
#[cfg(test)]
mod cored_shape_gate;
mod command_dispatch;
mod identity;
mod stream_sink;
mod window_oracle;
mod runtime_dep;
mod schedule;
mod seal_keys;
mod secrets;
mod service;
mod sidecar;
mod skillgen;
#[cfg(target_os = "macos")]
mod titlebar;
mod unit_dev;
mod unit_installer;
mod updater;
mod watcher;
mod webview;
pub mod webview_health;
mod window;
mod ws;

use ipc::CmdBridge;
use process::ProcessManager;
use pty::PtyManager;
use tauri::Manager;
use watcher::FsWatcher;

// 앱 자기 활성화: JS setFocus 는 창을 key 로 만들 뿐 앱을 전면으로 못 가져온다
// (macOS 포커스 탈취 방지). 자기 자신의 활성화는 허용되므로 NSApp 으로 수행.
#[tauri::command]
fn window_activate(window: tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.run_on_main_thread(|| {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            if let Some(mtm) = MainThreadMarker::new() {
                #[allow(deprecated)]
                NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

// 네이티브 창 배경 = 테마 bg 단일화(레이어 원칙, webview.rs 머리말 참조): 루트
// DOM 배경은 투명이고 창 배경이 그 아래를 칠한다 — 미도장 영역(홀 정렬 순간 등)
// 의 색이 테마와 항상 일치한다. 테마 엔진(theme/engine.ts)이 적용 시점마다 호출.
#[tauri::command]
fn window_set_background(window: tauri::Window, color: String) -> Result<(), String> {
    // 색 판정은 코어가 소유한다 — 갈리면 같은 테마가 프레임워크마다 다르게 보인다.
    let c = soksak_core::surface_spec::parse_hex_color(&color)
        .ok_or_else(|| format!("hex 색상(#rrggbb)이 아님: {color}"))?;
    window
        .set_background_color(Some(tauri::window::Color(c.r, c.g, c.b, 255)))
        .map_err(|e| e.to_string())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(navigation_policy::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_webview_capture::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(webview_health::WebviewHealth::default())
        .manage(activity::ActivityHub::default())
        .manage(daemon::DaemonManager::default())
        .manage(ProcessManager::default())
        .manage(FsWatcher::default())
        .manage(CmdBridge::default())
        .manage(data::DbState::default())
        .manage(secrets::SecretsState::default())
        .manage(ai_session::SessionTracker::default())
        .manage(schedule::ScheduleState::default())
        .manage(project_registry::ProjectRegistry::default())
        .manage(id_registry::IdRegistry::default())
        .manage(window::WindowStartupState::default());
    // 렌더러 프로세스 종료(process-gone)를 명시 감지한다(macOS per-webview) — 이 핸들러를
    // 등록하지 않으면 핀 rev 의 tauri-runtime-wry 가 무조건·무한·무고지 자동 reload 기본
    // 핸들러를 설치한다(R1 위반). webview_health 서킷 브레이커가 그 자리를 대체한다.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        webview_health::on_web_content_process_terminate(webview);
    });
    // 복구 리로드의 실제 렌더 도달 확인(Recovering→Closed) — 브레이커 윈도우는 건드리지
    // 않는다(webview_health 머리말). 브레이커 엔트리 없는 평시 로드는 무비용 통과.
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            webview_health::on_page_load_finished(webview);
        }
        // 창 메인 webview 의 로드 시작 = 렌더러 재부팅(reload·복구·HMR full-reload 전부).
        // 이 시점부터 새 JS 가 부트 서두 숨김을 돌리기까지 ~150ms 의 공백 동안, Rust 소유라
        // 살아남은 child(브라우저)가 이전 화면 그대로 떠 있다 — 여기서 즉시 숨긴다(경로 무관
        // 단일 지점). 복원이 표면 소유 뷰만 다시 표시한다. child 자신의 네비게이션(서핑)은
        // b- 접두사라 제외된다.
        if payload.event() == tauri::webview::PageLoadEvent::Started {
            let label = webview.label().to_string();
            if !label.starts_with("b-") {
                let app = webview.app_handle().clone();
                let prefix = format!("b-{label}-");
                let mut hidden: Vec<String> = Vec::new();
                for (wl, wv) in app.webviews() {
                    if wl.starts_with(&prefix) {
                        let _ = wv.hide();
                        hidden.push(wl);
                    }
                }
                crate::webview::set_engine_host_hidden(&app, label.clone(), true);
                // surface-occluded 릴레이는 여기서 금지 — 사이드카의 occluded 는 창 구분 없는
                // 프로세스 전역 present 정지라, 한 창(하니스)의 reload 가 다른 창의 브라우저
                // 그리기까지 멈춘다(실사고: 스위트 실행 후 사용자 창 NAVER 검정). 재부팅 숨김은
                // 컨테이너(이 창 소유)와 b-* wv.hide() 로 충분하고, 개별 표면은 플러그인 장부가
                // 소유한다(NATIVE-SURFACES §4.7).
                if !hidden.is_empty() {
                    crate::activity::publish(
                        &app,
                        "webview.lifecycle",
                        "webview",
                        serde_json::json!({
                            "event": "hidden-at-reload",
                            "labels": hidden,
                            "origin": "internal",
                            "message": format!("· webview hidden at renderer load start"),
                        }),
                    );
                }
            }
        }
    });
    builder
        .setup(|app| {
            // 부팅 단계 계측 — 어디서 시간이 가는지 기계가 답한다(실측 2026-08-08: 명령이
            // 열리기까지 10.2 초였는데 그 구간을 재는 자리가 없었다).
            let mut boot = boot_trace::BootTrace::start();
            boot.step("setup-enter");
            // Configured windows are born hidden. Register this exact native lifetime before any
            // native/renderer work so no pre-composition frame can become externally visible.
            let main_startup = window::register_startup_window(app.handle(), "main", true)
                .map_err(std::io::Error::other)?;
            window::bind_startup_native_window(app.handle(), &main_startup)
                .map_err(std::io::Error::other)?;
            // 가려진 창도 계속 그린다 — 앞으로 내지 않고도 잴 수 있게 하는 자기 선언.
            boot.step("startup-window");
            app_nap::hold();
            // identity 홈 확정 — 모든 경로(데이터·플러그인·사이드카·테마·프로젝트·소켓·시크릿)가
            // 이 값에서 파생되므로 어떤 경로 사용보다 먼저 1회 고정한다(home.rs 원칙).
            boot.step("app-nap");
            home::init(&app.config().identifier);
            // 사이드카 호스팅에 이 프레임워크의 셋(표면·메인스레드·사건 싱크)을 건넨다.
            // 이것이 없으면 첫 open 이 적재 직전에 "프레임워크 미설치"로 죽는다 — 그 실패는
            // 사이드카가 없는 것처럼 보이지만 사실은 이 배선이 빠진 것이다.
            boot.step("home-init");
            sidecar::install(app.handle());
            // updater 는 설정(plugins.updater: pubkey·endpoints)이 실린 빌드에서만 등록한다 —
            // 설정 없는 프로필에서 무조건 등록하면 부팅이 PluginInitialization(null)로 죽는다.
            // 설정이 conf 에 실리는 순간 자동 활성. 커맨드(update_check 등)는 플러그인 부재 시
            // app.updater() 가 Err 를 돌려 우아하게 실패한다(updater.rs).
            if updater_configured(app.config().plugins.0.get("updater")) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // 설치자는 홈 하나를 통째로 쓰는 단일 쓰기자다 — 앰비언트 전역을 여기서 한 번
            // 값으로 꺼내 넘긴다(identity.rs). 그 아래로는 정체성이 흐른다.
            app.manage(
                unit_installer::boot(identity::ambient()).map_err(std::io::Error::other)?,
            );
            // PTY 매니저도 정체성을 생성자로 받는다 — 데몬 소켓·토큰·스테이징 바이너리가
            // 그 홈에서 파생되므로 home::init 뒤에 세운다. 빌더 체인(setup 이전)에서 읽으면
            // home.rs 폴백인 ~/.soksak 이 잡혀 dev 빌드가 릴리즈 홈의 데몬을 겨눈다.
            app.manage(PtyManager::new(identity::ambient()));
            // plugin service 매니저(PS9·PS11) — bind 원장을 읽어 상주 서비스를 올린다. 창-무관이라
            // 워크스페이스 창 유무와 상관없이 부팅 시 1회. 스폰은 스레드로(부팅 비차단).
            app.manage(service::ServiceManager::new(
                std::sync::Arc::new(service::AppServiceHost::new(app.handle().clone())),
                std::sync::Arc::new(service::ProcessServiceSpawner::for_identity(identity::ambient())),
            ));
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || service::boot(&handle));
            }
            // 투명 언락 준비 완료(secrets-ready) → secrets 의존 서비스 드레인 재시작(PS10). os_key device
            // KEK 로 부팅 즉시 vault 가 열리므로, 부팅 중 토큰 없이 스폰된 서비스를 1회 회복시킨다
            // (secrets↔service 무결합 — R7). 드레인은 in-flight 완료를 최대 5s 대기하므로 별 스레드로
            // 던진다(이벤트 구동 — 폴링 0). 리스너는 emit 보다 먼저 등록한다.
            {
                use tauri::Listener;
                let h = app.handle().clone();
                app.listen_any("secrets-ready", move |_| {
                    let h2 = h.clone();
                    std::thread::spawn(move || {
                        use tauri::Manager;
                        if let Some(mgr) = h2.try_state::<service::ServiceManager>() {
                            let n = mgr.drain_restart_secret_dependents();
                            if n > 0 {
                                eprintln!("[service] 시크릿 준비 → 드레인 재시작 {n}개");
                            }
                        }
                    });
                });
            }
            // 백업 링 실패 고지에 쓸 앱 핸들을 심는다 — 이후 자동 백업 스냅샷 실패가 activity/알림으로
            // 드러난다(무음 폴백 금지). 데이터 개방보다 먼저 심어 첫 쓰기 신호부터 커버한다.
            data::ring::set_app(app.handle());
            // **cored 를 저장소 소유 판정보다 먼저 세운다.**
            //
            // 소유는 선착순이다(store_lock). 앱이 먼저 잡으면 cored 는 소유를 못 얻은 채
            // 자기 원장을 쓰려 하고, 그 쓰기가 상시 `database is locked` 로 막힌다(실측
            // 2026-08-01: 44 회). 두 프로세스가 같은 파일을 잠금으로 다투는 것 자체가
            // 강결합이다 — 저장소는 한 주인이 소유하고 나머지는 인터페이스로만 닿아야 한다.
            //
            // cored 가 먼저 서면 그가 잠금을 쥐고, 아래 claim 은 Taken 을 받아 이 프로세스는
            // 위임(AskOwner)으로 간다. 못 서면 아래 claim 이 성공해 예전처럼 이 프로세스가
            // 주인이 된다 — 어느 경우에도 주인은 하나다.
            // cored 의 창 호스트로 붙는다 — cored 에는 창이 없으므로, 밖에서 온 명령이 화면에
            // 닿으려면 창을 가진 쪽이 자기를 배달 통로로 등록해야 한다. 자기 소켓(위)은 그대로
            // 선다: 이번 걸음은 붙는 것까지고, 소켓을 합치는 것은 `ipc_socket_path` 계약을 함께
            // 뒤집는 별개의 일이다.
            //
            // 못 붙어도 앱은 산다. 이 프레임워크는 아직 자기 소켓으로 자기 창을 서빙하고 있어
            // 여기서 죽으면 그 서빙까지 죽는다 — 다만 조용히 지나가지 않는다.
            #[cfg(unix)]
            {
                // 다시 세우는 법을 **붙기 전에** 넣는다. cored 는 죽을 수 있고(판올림·강제종료·
                // 크래시), 갈아탈 수 없으면 그 앱은 남은 수명 내내 저장소를 잃는다 — 읽기가
                // 실패하고, 실패한 읽기를 "비어 있음"으로 적는 소비자 하나가 곧 데이터 소실이다.
                let handle = app.handle().clone();
                cored_host::rebuild_with(Box::new(move || {
                    cored_host::stand_up(&handle).map(std::sync::Arc::new)
                }));
                // 창 사건이 이 호스트를 다시 찾을 수 있어야 한다 — 값으로 들고 있지 않으면
                // 붙은 연결이 여기서 끝나고, 그 끊김은 "명령이 안 먹는다"로만 나타난다.
                //
                // 자리는 **하나**다. 예전에는 `install` 과 `app.manage` 두 자리에 뒀는데, 실은
                // `manage` 는 `Arc<CoredHost>` 로 싣고 읽는 쪽은 `CoredHost` 로 꺼내 언제나 빈손
                // 이었다 — 창 사건 통지가 그래서 0 건이었고, 죽은 라벨이 cored 센서스에 남았다.
                match cored_host::stand_up(app.handle()) {
                    Ok(host) => cored_host::install(std::sync::Arc::new(host)),
                    Err(e) => eprintln!("[cored-host] 붙지 못했다: {e} — 이 창들은 cored 가 모른다"),
                }
            }
            // 범용 데이터 스토어(app.data) — 소켓 서버 이전에 연다(커맨드가 즉시 쓸 수 있도록).
            // open_or_recover: 본체 손상 시 손상본 격리→백업 슬롯 복원→재개방(무음 미초기화 제거).
            // 여는 것은 **주인만** 한다. 같은 홈에 이미 주인이 있으면(그 홈의 cored, 또는 다른
            // 프레임워크가 세운 것) 이 프로세스는 열지 않고 그쪽에 묻는다 — 둘이 각자 열면
            // 쓰기자가 둘이고, SQLite 는 막지 않고 직렬화만 한다.
            //
            // 못 잡은 것은 실패가 아니다. 실패로 다루면 두 번째 프레임워크가 저장소를 통째로
            // 못 쓰고, 그것이 두 앱을 동시에 못 켜던 자리다.
            match data::db_path() {
                Err(e) => eprintln!("[data] DB 경로 계산 실패: {e}"),
                Ok(db_path) if {
                    let owner = data::claim_store(&db_path);
                    data::set_route(owner);
                    owner.delegates()
                } => {
                    // 저장소를 위임해도 **재개는 해야 한다** — 안 하면 링이 0 에서 시작하고
                    // 이 프로세스의 도장이 주인의 원장에서 과거를 덮는다.
                    activity::resume_seq_from_owner(app.handle());
                    eprintln!(
                        "[data] 이 홈의 저장소는 다른 프로세스가 소유한다 — 열지 않고 cored 에 묻는다({})",
                        db_path.display()
                    );
                }
                Ok(db_path) => match soksak_store::open::open_or_recover(&db_path) {
                    Ok((conn, recovery)) => {
                        // 활동 허브 컬렉션(core/activity) 정의 — 발행 즉시 영속 가능(A1).
                        activity::init_collection(&conn);
                        // seq 를 영속 최댓값에서 재개 — 재시작을 넘는 단조(소비자 읽음 커서 보존).
                        activity::resume_seq(app.handle(), &conn);
                        app.state::<data::DbState>().set(conn);
                        // 손상 복구가 일어났으면 무음 금지 — DbState 설정 뒤 activity(영속·스트림)+OS 알림으로
                        // 고지한다. 격리 경로와 복원 슬롯이 사후 조사의 단서다.
                        if let Some(rec) = recovery {
                            let slot = rec.restored_from;
                            let quarantined = rec.quarantined.to_string_lossy().to_string();
                            eprintln!("[data] 손상 DB 복구: 격리={quarantined} 복원슬롯={slot:?}");
                            activity::publish(
                                app.handle(),
                                "data.recovered",
                                "core",
                                serde_json::json!({
                                    "restoredFromSlot": slot,
                                    "quarantined": quarantined,
                                }),
                            );
                            // 알림은 사람 표면 — 복원된(또는 빈) DB 에서 언어를 1회 조회해 해소한다.
                            // 복원 성공이면 그 DB 의 설정을, 전 슬롯 실패면 빈 DB → 기본 ko(i18n.rs).
                            let lang = i18n::app_language(app.handle());
                            let body = i18n::recovery_body(lang, slot);
                            if let Err(e) =
                                notify::show(app.handle(), i18n::recovery_title(lang), &body)
                            {
                                eprintln!("[data] 복구 알림 표시 실패: {e}");
                            }
                        }
                    }
                    // 복구를 시도했으나 재개방까지 실패 — 앱은 DbState 없이 제한 동작한다. 무음 금지:
                    // 격리 경로를 실었으면(손상본을 옮겼으면) 사람에게 고지해 사후 복구 단서를 남긴다.
                    // DbState 가 비어 언어 조회는 기본 ko(i18n.rs)로 떨어진다.
                    Err(e) => {
                        eprintln!("[data] DB 열기/복구 실패: {}", e.detail);
                        if let Some(q) = e.quarantined {
                            let lang = i18n::app_language(app.handle());
                            let body = i18n::open_failed_body(lang, &q.to_string_lossy());
                            if let Err(err) =
                                notify::show(app.handle(), i18n::open_failed_title(lang), &body)
                            {
                                eprintln!("[data] 열기 실패 알림 표시 실패: {err}");
                            }
                        }
                    }
                },
            }
            // 영속된 시간 기반(At/Every/Cron) 일정 재무장(crash 복구) — DB 열린 직후. 무상태 Reconcile 은
            // 플러그인이 activate 시 재등록한다. 일정 없으면 no-op(발화 스레드도 안 뜸).
            boot.step("sidecar-install");
            schedule::reload_persisted(app.handle());
            boot.step("schedule-reload");
            // 시크릿 볼트 — 경로 + KEK 출처(os_key OS 키체인) 주입. 투명 언락: 마스터 passphrase 없이
            // device KEK 로 부팅 시 자동 개방(env 무음 언락 경로 없음 — P0 제거). keyring 은 os_key 안에서만
            // 인스턴스화 → 여기 주입은 지연(첫 접근 때 키체인 접근). 경로·expect 확정을 DB open 뒤로 둔다.
            {
                use tauri::Emitter;
                let st = app.state::<secrets::SecretsState>();
                // 앰비언트 가장자리 — 볼트 경로·키체인 서비스명의 출처가 여기서 값이 된다.
                // 아래로는 정체성이 인자로 흐른다(secrets.rs 는 전역을 읽지 않는다).
                let identity = identity::ambient();
                // SOKSAK_VAULT_PATH 있으면 격리 경로(헤드리스/E2E), 없으면 이 정체성의 홈 아래.
                match secrets::resolve_vault_path(|k| std::env::var(k).ok(), &identity) {
                    Ok(p) => st.set_path(p),
                    // 경로 미해소면 볼트는 미구성으로 남는다 — 이후 시크릿 연산이 이름을 달고
                    // 실패한다(전역 홈 폴백 없음 = 남의 홈에 볼트를 만들지 않는다).
                    Err(e) => eprintln!("[secrets] 볼트 경로 계산 실패: {e}"),
                }
                // [R23] app.data 에 봉투 키가 등록돼 있으면 vault 가 있어야 한다 — 부재 시 자동생성 거부
                // 플래그(전손 차단). data DB 가 열린 뒤라 조회 가능.
                let expect = match app.state::<data::DbState>().conn.lock() {
                    Ok(g) => g
                        .as_ref()
                        .map(|c| soksak_store::doc::has_any_keys(c).unwrap_or(false))
                        .unwrap_or(false),
                    Err(_) => false,
                };
                st.set_expect_vault(expect);
                // KEK 출처 주입(경로·expect 확정 후). 프로덕션 OsKekSource — 앱 신원 ACL 결속. debug 빌드에
                // 한해 SOKSAK_E2E_KEK 가 있으면 e2e 결정적 KEK 를 먼저 쓴다(격리·CI). release 엔 이 분기 자체가
                // 컴파일되지 않아 env-KEK 백도어가 없다.
                #[cfg(debug_assertions)]
                match secrets::E2eKekSource::from_env() {
                    Some(src) => st.set_kek_source(Box::new(src)),
                    None => st.set_kek_source(Box::new(secrets::OsKekSource::for_identity(
                        &identity,
                    ))),
                }
                #[cfg(not(debug_assertions))]
                st.set_kek_source(Box::new(secrets::OsKekSource::for_identity(&identity)));
                // 부팅 즉시 1회 투명 개방 시도(best-effort) 후 secrets-ready 방출 — 위 리스너가 서비스를
                // 드레인 재시작해 토큰을 회복시킨다. StoreUnavailable(헤드리스)면 열리지 않고 조용히
                // 넘어간다(무음 평문 0, 봉인만 불가).
                let _ = st.is_unlocked();
                let _ = app.emit("secrets-ready", ());
            }
            // 파일 워처 1회 초기화(이벤트 콜백에 앱 핸들 주입).
            let handle = app.handle().clone();
            crate::watcher::init(&app.state::<FsWatcher>(), handle);
            // app-internal command socket(JSON-RPC). sok CLI 가 직접 사용하고, `sok mcp` 서브프로세스가
            // stdio MCP↔이 소켓 브리지로 사용한다. app 은 MCP 서버가 아니다 — docs/AI-CONTROL.md P6.
            if let Err(e) = ipc::start(app.handle().clone()) {
                // 소켓 선점 실패 = 살아있는 인스턴스가 이미 있다(connect 프로브 — 죽은 소켓은 재바인드).
                // 소켓 없이 계속 뜨면 두 인스턴스가 같은 영속 kv(window/<label> 스냅샷)에 동시 쓰기해
                // 마지막에 죽는 쪽이 덮어쓰고(실측 — 스페이스 제목 마이그레이션 클로버), 명령은 소켓
                // 주인에게만 가서 화면의 창과 어긋난다. 단일 인스턴스가 규칙 — 즉시 종료한다.
                eprintln!("[ipc] 소켓 서버 기동 실패: {e} — 이중 인스턴스 금지, 종료합니다");
                std::process::exit(1);
            }
            // 범용 미디어 스트리밍 프록시(루프백 HTTP) — webview 가 못 받는 Referer/CORS 보호 미디어를
            // 헤더 주입해 바이너리 스트리밍한다. media.proxy.* 가 표면. 기동 실패는 재생만 실패(앱은 산다).
            // 손잡이를 앱 상태로 둔다 — 포트·토큰은 세운 프로세스의 것이고, media_proxy_info 는 그것을
            // 든 쪽만 답할 수 있다(짐작해 조립한 base 는 아무도 안 듣는 주소가 된다).
            app.manage(mediaproxy::MediaProxyHandle(
                match soksak_net::mediaproxy::MediaProxy::start() {
                    Ok(p) => Some(p),
                    Err(e) => {
                        eprintln!("[mediaproxy] 프록시 서버 기동 실패: {e}");
                        None
                    }
                },
            ));
            // 딥링크 라우팅 — soksak://run?cmd=... 외부 진입/알림 클릭이 한 명령을 실행한다(CmdBridge 경유,
            // 단일 실행 경로). dev 는 스킴이 OS 미등록일 수 있어 register_all 로 런타임 등록(프로덕션은
            // tauri.conf plugins.deep-link). 파싱 실패/미지 URL 은 조용히 무시(명령 누출 0).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = app.handle().clone();
                let _ = app.deep_link().register_all();
                app.deep_link().on_open_url(move |event| {
                    // **주인에게 넘긴다.** 밖에서 온 명령이므로 명령 표면의 주인(cored)이 받고,
                    // 형식도 거기서 읽는다 — 여기서 읽으면 그 규칙이 프레임워크마다 한 벌이 되고
                    // (실측 2026-08-01: 실제로 두 벌이었고 형식이 갈려 있었다), 창에 넘기면 창
                    // 없는 곳에 영영 못 닿는다.
                    let _ = &dl_handle;
                    for u in event.urls() {
                        if let Err(why) = cored_host::ask_owner(
                            "deeplink_open",
                            &serde_json::json!({ "url": u.as_str() }),
                        ) {
                            eprintln!("[deep-link] 주인에게 넘기지 못했다: {why}");
                        }
                    }
                });
            }
            // 원격 제어(폰-링크) transport 는 코어에서 분리됐다 — 원격 전송 사이드카 플러그인이
            // 검증된 보안 하한선(remote::*)을 코어 밖 프로세스에서 구동하고, 인가된 명령을 SOKSAK_SOCKET
            // 으로 코어에 중계하며 destructive 는 코어 remote.confirm 사람 모달을 거친다. 코어는 모달
            // (RemoteConfirmModal + remote.confirm 커맨드)만 남긴다 — iroh/snow 트리는 코어에서 빠진다.
            // 신호등: Tauri unstable 경계의 창별 draw owner가 공개 DOM 목표를 소유한다.
            #[cfg(target_os = "macos")]
            {
                // main 창 네이티브(레이어 역전·신호등) — 새 창과 동일한 단일 진입점(window.rs).
                window::install_window_natives(app.handle(), "main")
                    .map_err(std::io::Error::other)?;
                // 앱 전역 모니터(클릭·라이브리사이즈) — 창 무관 1회 설치. 모든 창을 추적하고 어느
                // 창인지 label 을 동반 emit 한다(MW4 — webview.rs 머리말). 프론트가 자기 창만 필터.
                webview::appkit_events::install_click_monitor(app.handle());
                webview::appkit_events::install_live_resize_monitor(app.handle());
                // Dock 우클릭 "새 창"(Terminal.app 관례) — 앱 델리게이트 applicationDockMenu: 주입.
                dockmenu::install(app.handle());
            }
            // Renderer GREEN remains the independent second prerequisite. If it arrived early,
            // this commit completes the same one-shot transaction; otherwise the renderer command
            // completes it later.
            window::commit_startup_window(app.handle(), &main_startup)
                .map_err(std::io::Error::other)?;
            // 헤드리스 부팅(CI·cron·무-GUI): main(control-plane) 창을 숨긴 채 소켓·레지스트리만
            // 올린다(webview 유지). 프로젝트 창은 온디맨드라 여기서 아무것도 안 뜬다 — 오케스트라
            // vs 프로젝트 창 구분이 그대로. 크로스플랫폼(macOS/Linux/Windows 러너 모두).
            if headless::is_headless() {
                headless::apply(app.handle());
            }
            Ok(())
        })
        // 창 포커스(NSWindow key 등) 변화를 프론트로 emit({label, focused}). 다른 앱으로 전환하면
        // false, 같은 창 안 child webview(내장 브라우저)로 포커스가 가도 창 레벨이라 불변. 부차
        // 애니메이션 게이팅 신호이자, 멀티 윈도우 활성 창 추적(소켓 라우팅 기본 타겟) 소스.
        .on_window_event(|window, event| {
            use tauri::{Emitter, Manager};
            match event {
                tauri::WindowEvent::Focused(focused) => {
                    let label = window.label();
                    if *focused {
                        ipc::note_focus(label); // 활성 창 갱신(Rust 가 추적)
                        // 포커스는 사실이고, 그 사실이 바뀌면 cored 가 알아야 한다 — 낡은
                        // 사실로 타겟을 고르면 밖에서 온 명령이 사용자가 보고 있지 않은 창에서
                        // 돈다. 새로 난 창도 이 길로 알려진다(창은 나면서 포커스를 받는다).
                        #[cfg(unix)]
                        cored_host::announce_windows(window.app_handle());
                    }
                    // 그 창에만 emit_to — 프론트 필터 불필요(자기 창 신호만 도착). 활성 창 추적은
                    // Rust(note_focus)가 담당하므로 프론트는 단순히 focused 만 받는다.
                    let _ = window.app_handle().emit_to(label, "window-focus", *focused);
                    // 전역 broadcast — 오케스트레이터 창맵이 팩트(위치·포커스)를 자동 갱신한다(수동
                    // 새로고침 제거). 다른 창은 이 이벤트를 구독하지 않아 무시한다.
                    let _ = window.app_handle().emit("window-changed", ());
                }
                // 창 이동·크기변경도 창맵 팩트를 바꾼다 — 자동 갱신 대상. 드래그 중 폭주는 구독측
                // (오케스트레이터)이 디바운스로 흡수하므로 코어는 그대로 broadcast 한다.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    let _ = window.app_handle().emit("window-changed", ());
                }
                // 창이 닫히면 그 창의 브라우저 child webview 를 회수한다 — 창 프론트가 사라지면 그 창
                // browserGc 가 멈추고 다른 창 GC 는 접두사 필터로 안 건드리므로 child 가 좀비로 남는다.
                // 창과 함께 죽어야 할 자식을 그 창 label 접두사(b-<label>-)로 골라 명시 정리.
                // 사용자가 이 창을 닫는 중(빨간 버튼·Cmd+W·window.close 요청 경로) — 마크만 남긴다.
                // 실제 영속 정리는 Destroyed 에서(B1 의미론, window.rs 머리말): 웹뷰 unload 의 마지막
                // 저장(pagehide)이 정리 뒤에 도착해 스냅샷을 부활시키지 않도록 순서를 보장한다.
                // 앱 종료(Cmd+Q/app.exit)의 창 파괴는 이 이벤트를 지나지 않아 세션이 보존된다.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // 회수는 이 콜백 밖에서 한다 — 여기서 하면 회수가 창 메시지를 다시 태워
                    // 이미 빌린 창 맵을 또 빌리고 프로세스가 패닉한다(window.rs 머리말).
                    // 첫 진입만 보류하고, 회수가 끝난 뒤 스스로 다시 닫는다.
                    if window::begin_teardown(window.label()) {
                        api.prevent_close();
                        let w = window.clone();
                        // run_on_main_thread 를 메인 스레드에서 부르면 send_user_message 가
                        // 큐잉 없이 **즉시 동기 실행**한다(tauri-runtime-wry lib.rs:234 —
                        // current_thread == main 이면 handle_user_message 인라인). 그러면 이
                        // 지연은 무효가 되어 콜백 안 재진입이 그대로 남는다(실측: 첫 수정 뒤에도
                        // 같은 패닉 재발). 별도 스레드에서 넣어야 proxy 경로로 큐잉되어
                        // 진짜 다음 이벤트 루프 차례에 실행된다.
                        std::thread::spawn(move || {
                            let _ = w.app_handle().clone().run_on_main_thread(move || {
                            // 파괴 순서 계약(SIDECARS) — dealloc 전에 엔진 child 부터 닫게 통지.
                            #[cfg(target_os = "macos")]
                            crate::sidecar::notify_surface_closing(&w);
                            // 파괴 예고(webview_health) — 창 닫기 중의 렌더러 프로세스 종료를
                            // 크래시로 오분류해 죽어가는 webview 를 reload 하지 않는다.
                            let app = w.app_handle();
                            webview_health::mark_expected_teardown(app, w.label());
                            let prefix = format!("b-{}-", w.label());
                            let children: Vec<String> = app
                                .webviews()
                                .keys()
                                .filter(|l| l.starts_with(&prefix))
                                .cloned()
                                .collect();
                            for label in children {
                                webview_health::mark_expected_teardown(app, &label);
                            }
                            window::mark_user_closed(w.label());
                            let _ = w.close();
                            });
                        });
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    window::forget_startup_native_window(window);
                    ipc::note_closed(window.label()); // 포커스 기록이 죽은 창을 놓는다(다음 명령의 오배송 차단)
                    webview::forget_window(window.label()); // child/pane/page-load identity를 해제된 NSView와 함께 회수
                    // cored 도 그 창을 놓아야 한다 — **살아 있는 목록**을 보내면 장부가 스스로
                    // 맞춘다(멱등). 방금 죽은 라벨은 빼고 보고한다: 이 사건 시점에 프레임워크의
                    // 창 목록이 그것을 이미 놓았는지는 보장되지 않는다.
                    #[cfg(unix)]
                    cored_host::announce_windows_without(window.app_handle(), window.label());
                    #[cfg(target_os = "macos")]
                    webview::appkit_events::forget_nswindow_label(window.label()); // NSWindow↔label 캐시 회수
                    #[cfg(target_os = "macos")]
                    titlebar::forget_window(window); // 정확히 이 native 창 generation의 titlebar owner만 회수
                    crate::sidecar::forget_window(window.label()); // 사이드카 surface 캐시 무효화(stale NSView 방지)
                    window::forget_teardown(window.label()); // 회수 마크 폐기(맵 무한 증가 차단)
                                                                   // 브레이커 엔트리 폐기 — 창 label 은 재사용 안 되므로 남기면 맵이 무한 증가(느린 누수).
                    webview_health::forget_window(window.app_handle(), window.label());
                    let app = window.app_handle();
                    // 파괴된 창의 pending 명령을 즉시 회수 — 대기자(route·스케줄 lease)를
                    // 타임아웃까지 방치하지 않는다(WINDOW_DESTROYED 즉시 응답).
                    app.state::<ipc::CmdBridge>().cancel_window(window.label());
                    // 창=프로젝트 수명(P6): 창이 파괴되면 그 창이 소유한 프로젝트 데몬도 함께 종료한다.
                    app.state::<crate::daemon::DaemonManager>()
                        .kill_by_window(window.label());
                    // 창=플러그인 런타임 수명: 그 창의 플러그인이 스폰한 서브프로세스도 회수한다
                    // (detached 생존 사이드카 제외). 파이프는 앱이 쥐고 있어 창이 죽어도 자식에
                    // stdin EOF 가 가지 않는다 — 여기서 거두지 않으면 침묵 좀비다.
                    app.state::<ProcessManager>().kill_by_window(window.label());
                    // 프로젝트 전역 단일 오픈(P6): 죽은 창의 점유를 해제해 다른 창이 그 프로젝트를
                    // 열 수 있게 한다(해제 없으면 앱 재시작까지 유령 점유).
                    crate::project_registry::on_window_destroyed(&app, window.label());
                    crate::id_registry::on_window_destroyed(&app, window.label());
                    let _ = app.emit("window-changed", ()); // 오케스트레이터 창맵 자동 갱신
                                                            // 사용자 개별 닫기였다면 그 창의 세션 흔적(스냅샷 kv + manifest slot)을 폐기.
                    if window::take_user_closed(window.label()) {
                        // 창 폐기 = 그 창의 PTY 세션도 폐기(B1) — 데몬 셸을 여기서 거두지
                        // 않으면 창은 사라졌는데 셸만 soksak-ptyd 에 유령으로 남는다.
                        app.state::<PtyManager>().kill_by_window(window.label());
                        let st = app.state::<data::DbState>();
                        let guard = st.conn.lock();
                        if let Ok(guard) = guard {
                            if let Some(conn) = guard.as_ref() {
                                if let Err(e) =
                                    window::prune_window_persistence(conn, window.label())
                                {
                                    eprintln!(
                                        "[persist] 창 흔적 정리 실패({}): {e}",
                                        window.label()
                                    );
                                }
                            }
                        }
                    }
                    let prefix = format!("b-{}-", window.label());
                    let orphans: Vec<String> = app
                        .webviews()
                        .keys()
                        .filter(|l| l.starts_with(&prefix))
                        .cloned()
                        .collect();
                    for label in orphans {
                        if let Some(wv) = app.get_webview(&label) {
                            // 파괴 예고 — 회수 close 의 프로세스 종료를 크래시로 오분류하지 않는다.
                            webview_health::mark_expected_teardown(app, &label);
                            let _ = wv.close();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_terminal,
            daemon::daemon_start,
            daemon::daemon_stop,
            daemon::daemon_status,
            daemon::daemon_logs,
            daemon::daemon_reap,
            daemon::daemon_run_once,
            skillgen::skill_refresh_spawn,
            pty::pty_pane_pid,
            pty::pty_pane_alive,
            pty::pty_daemon_status,
            pty::pty_daemon_restart,
            pty::pty_daemon_upgrade,
            updater::update_check,
            updater::update_apply,
            updater::app_relaunch,
            pty::pty_sidecar_request,
            pty::pty_read_sealed_screen,
            pty::write_terminal,
            pty::resize_terminal,
            pty::ack_terminal,
            pty::close_terminal,
            pty::shell_which,
            runtime_dep::binary_integrity,
            runtime_dep::probe_binary,
            runtime_dep::cleanup_stale,
            runtime_dep::download_verify,
            runtime_dep::npm_global_dirs,
            runtime_dep::verify_and_link,
            process::process_spawn,
            process::process_write,
            process::process_stdin_close,
            process::process_kill,
            process::process_list,
            network::net_udp_send,
            network::net_udp_request,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            http::net_http_request,
            mediaproxy::media_proxy_info,
            notify::notify_show,
            schedule::schedule_set,
            schedule::schedule_register,
            service::service_dispatch,
            service::service_ledger_sync,
            service::service_bus_push,
            service::service_status,
            schedule::schedule_poke,
            schedule::schedule_cancel,
            schedule::schedule_list,
            fs::list_children,
            fs::read_text_file,
            fs::write_text_file,
            fs::write_file_base64,
            fs::read_file_base64,
            fs::themes_scan,
            fs::theme_install,
            fs::ensure_project_dir,
            fs::validate_project_root,
            plugins::plugin_scan,
            home::app_is_release,
            plugins::plugin_install_git,
            plugins::plugin_update,
            plugins::plugin_dev_new,
            plugins::plugin_dev_new2,
            plugins::sidecar_dev_new,
            unit_dev::unit_dev_list,
            unit_dev::unit_dev_set,
            unit_dev::unit_dev_validate_path,
            unit_dev::unit_dev_remove,
            unit_dev::app_environment,
            unit_dev::app_quit,
            unit_installer::host_unit_target,
            unit_installer::unit_install_begin,
            unit_installer::unit_install_stage,
            unit_installer::unit_install_read_utf8,
            unit_installer::unit_install_commit,
            unit_installer::unit_install_rollback,
            plugins::plugin_remove,
            plugins::plugin_data_read,
            plugins::plugin_data_write,
            plugins::plugin_data_list,
            data::commands::data_kv_get,
            data::commands::data_kv_set,
            data::commands::data_kv_delete,
            data::commands::data_kv_keys,
            data::commands::data_kv_entries,
            data::commands::data_kv_delete_many,
            data::commands::data_kv_history,
            data::commands::data_kv_undo,
            data::commands::data_define,
            data::commands::data_put,
            data::commands::data_get,
            data::commands::data_delete,
            data::commands::data_query,
            data::commands::data_search,
            data::commands::data_count,
            data::commands::data_retention_trim,
            data::commands::data_retention_reap,
            data::commands::data_migrate_ns,
            data::commands::data_encrypt_enable,
            data::commands::data_encrypt_convert,
            data::commands::data_encrypt_rotate,
            data::commands::data_encrypt_recover,
            data::commands::data_encrypt_change_recovery,
            data::commands::data_encrypt_status,
            ai_session::ai_session_detect,
            ai_session::ai_session_inspect,
            ai_session::ai_session_find,
            ai_session::ai_session_dir,
            ai_session::ai_session_active,
            ai_session::ai_session_untrack,
            ai_session::ai_session_lineage,
            data::commands::data_backup,
            data::commands::data_ns_remove,
            data::commands::data_stats,
            data::commands::data_verify,
            data::commands::data_canary,
            data::commands::data_repair,
            data::commands::data_restore,
            data::commands::data_export,
            data::commands::data_import,
            secrets::secret_set,
            secrets::secret_has,
            secrets::secret_delete,
            secrets::secret_keys,
            secrets::secret_status,
            secrets::secret_backend,
            watcher::watch_dir,
            watcher::unwatch_dir,
            webview::webview_open,
            webview::webview_bounds,
            webview::webview_presented,
            webview::webview_transition_prepare,
            webview::webview_transition_cancel,
            webview::webview_navigate,
            webview::webview_devtools,
            webview::webview_history,
            webview::webview_stop,
            webview::webview_visible,
            webview::webview_alive,
            webview::webview_wait_loaded,
            webview::webview_pane_group,
            webview::webview_pane_bounds,
            webview::webview_pane_member_bounds,
            webview::webview_pane_transition_prepare,
            webview::webview_pane_hosts,
            webview::webview_presentation_trace_arm,
            webview::webview_presentation_trace_close,
            webview::webview_close,
            webview::webview_divider_highlight,
            webview::webview_emit_native,
            webview::webview_send_wheel,
            webview::webview_capture_full,
            webview::webview_type_text,
            webview::webview_zoom,
            webview::webview_zoom_view,
            webview::webview_list,
            webview::engine_host_visible,
            webview::engine_surface_stats,
            webview::webview_holes,
            webview::webview_open_window,
            webview::webview_eval,
            webview::webview_inject_script,
            webview::webview_media_extract,
            webview::webview_overlay_active,
            webview::webview_resize_gesture,
            webview::webview_dom_holes,
            webview::webview_debug_hierarchy,
            webview_health::webview_health_query,
            webview_health::webview_recover,
            webview_health::webview_recovery_consume,
            window_set_background,
            activity::activity_publish,
            activity::activity_recent,
            activity::activity_persist_stats,
            activity::activity_audit,
            id_registry::id_registry_declare,
            id_registry::id_registry_resolve,
            project_registry::project_claim,
            project_registry::project_release,
            project_registry::project_owners,
            window::window_create,
            window::window_set_physical_size,
            window::window_set_logical_size,
            window::window_monitors,
            window::window_place,
            window::window_list,
            window::window_census,
            window::window_focus,
            window::window_close,
            window::window_reload,
            window::window_startup_state,
            window::window_startup_present,
            #[cfg(unix)]
            cored_host::control_owner_answered,
            ipc::cmd_result,
            ipc::ipc_socket_path,
            ipc::ipc_cli_dir,
            ipc::ipc_last_project_window,
            ipc::ipc_hello_info,
            #[cfg(target_os = "macos")]
            titlebar::titlebar_backing,
            #[cfg(target_os = "macos")]
            titlebar::titlebar_native_state,
            #[cfg(target_os = "macos")]
            titlebar::titlebar_compose,
            window_activate,
            sidecar::sidecar_open,
            sidecar::sidecar_send,
            sidecar::sidecar_close,
            sidecar::sidecar_ensure,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 엔진 사이드카(예: Chromium)의 메시지펌프: macOS 는 tao 콜백에서 돌리지 않는다 — NSApp
            // 이벤트 펌프 재진입 데드락(실측). 모듈이 GCD 로 메인런루프 최상위에 비재진입 디스패치한다
            // (soksak-sidecar-browser-chromium repo 참조). windows/linux 엔 그 GCD 채널이 없어 이
            // 런루프 콜백(메인=CEF UI 스레드)이 이벤트마다 엔진 tick 을 호출한다(Phase F) — 엔진 쪽
            // drive_pump 는 만기 검사(원자 로드 1회) 후 due 일 때만 일하므로 재진입·비용 문제가 없다.
            #[cfg(not(target_os = "macos"))]
            sidecar::engine_tick_all();
            // 멀티 윈도우 종료 규칙: 창이 하나라도 남아 있으면 앱을 종료하지 않는다 — 한 창을 닫아도
            // 다른 창은 살아야 한다. 실제 종료(PTY 자식 정리·소켓 정리)는 마지막 창이 닫혔을 때만.
            // (Tauri 기본은 ExitRequested 시 그대로 종료 — prevent_exit 로 비-마지막 창 종료를 막는다.)
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // windows()(Window 레지스트리) — 브라우저 child 를 연 창은 멀티-webview 라
                // webview_windows() 에서 빠진다. 그걸 쓰면 브라우저 연 창이 마지막 1개일 때 "창 없음"
                // 으로 오판해 앱이 종료된다. 실제 OS 창 존재 여부는 windows() 가 진실.
                // code Some = 명시 종료(Cmd+Q 메뉴/app.exit) — 창이 남아 있어도 종료를 막지 않는다.
                // 이 경로의 창 파괴는 CloseRequested 를 지나지 않아 전 창 세션(스냅샷·manifest)이
                // 보존된다(B1: 종료=보존, 개별 닫기=폐기 — window.rs 의미론).
                if code.is_none() && !app_handle.windows().is_empty() {
                    api.prevent_exit();
                    return;
                }
                app_handle.state::<PtyManager>().kill_all();
                daemon::kill_all(app_handle);
                app_handle.state::<ProcessManager>().kill_all();
                // 상주 plugin service 잔존 0(PS10) — shutdown 통지 후 강제 종료.
                app_handle.state::<service::ServiceManager>().kill_all();
                soksak_net::ws::close_all();
                ipc::cleanup();
                // 미디어 프록시는 이 사다리에 없다 — 루프백 TCP 는 프로세스 종료 시 OS 가 회수하고,
                // 빈 cleanup() 한 줄이 사다리에 서 있으면 정리할 것이 있는 것처럼 읽힌다.
                sidecar::shutdown_all();
            }
        });
}

/// updater 등록 게이트 — plugins.updater 가 non-null 로 실려 있을 때만 true.
/// 키 부재·null(설정 미주입 프로필)은 false: 등록을 건너뛰어 부팅을 살린다.
fn updater_configured(v: Option<&serde_json::Value>) -> bool {
    v.is_some_and(|v| !v.is_null())
}

#[cfg(test)]
mod updater_gate_tests {
    use super::updater_configured;
    use serde_json::json;

    #[test]
    fn missing_or_null_config_skips_registration() {
        // 설정 미주입(키 부재·null)이면 등록 금지 — 무조건 등록은 부팅을
        // PluginInitialization("updater", … invalid type: null …) 으로 죽인다.
        assert!(!updater_configured(None));
        assert!(!updater_configured(Some(&serde_json::Value::Null)));
    }

    #[test]
    fn present_config_registers() {
        let cfg = json!({ "pubkey": "k", "endpoints": ["https://example.invalid/u"] });
        assert!(updater_configured(Some(&cfg)));
    }
}

#[cfg(test)]
mod handler_registration_tests {
    //! 등록이 컴파일되는 **모든 플랫폼**에 본체가 있어야 한다.
    //!
    //! 컴파일러는 이 짝을 빌드하는 OS 에서만 검사한다. macOS 전용 정의를 조건 없이
    //! 등록하면 macOS 빌드는 멀쩡하고 리눅스·윈도우 빌드만 깨진다 — 멀티플랫폼 이식
    //! 중에는 CI 에 가서야 드러난다. 이 검사는 소스 텍스트를 읽으므로 어느 OS 에서
    //! 돌려도 같은 답을 낸다.
    //!
    //! 규칙(실측으로 교정 2026-07-27): 조건 없는 등록은 **플랫폼 전부**를 덮는 정의를
    //! 요구한다 — 조건 없는 정의 하나이거나, macos/not-macos 짝이거나. macos 로 가려진
    //! 등록은 macos 정의(또는 조건 없는 정의)면 충분하다. 처음 판은 "정의와 등록의 cfg 가
    //! 같아야 한다"로 썼다가 짝 정의 4건을 오탐했다 — 규칙이 현실보다 좁았다.

    fn lib_src() -> String {
        std::fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    fn module_src(module: &str) -> String {
        let base = env!("CARGO_MANIFEST_DIR");
        std::fs::read_to_string(format!("{base}/src/{module}.rs"))
            .or_else(|_| std::fs::read_to_string(format!("{base}/src/{module}/mod.rs")))
            .unwrap_or_default()
    }

    /// generate_handler! 목록: (module, fn, 등록이 macos 로 가려졌는가)
    fn registered() -> Vec<(String, String, bool)> {
        let s = lib_src();
        let start = s.find("generate_handler!").expect("generate_handler! 없음");
        let end = s[start..].find("]).").map(|i| start + i).unwrap_or(s.len());
        let mut out = Vec::new();
        let mut gated_next = false;
        for line in s[start..end].lines() {
            let t = line.trim().trim_end_matches(',');
            if t.contains("#[cfg(") {
                gated_next = t.contains("macos") && !t.contains("not(");
                continue;
            }
            if let Some((m, f)) = t.split_once("::") {
                if !f.is_empty() && f.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push((m.to_string(), f.to_string(), gated_next));
                    gated_next = false;
                }
            }
        }
        out
    }

    #[test]
    fn kv_batch_commands_are_registered() {
        let source = lib_src();
        assert!(source.contains("data::commands::data_kv_entries,"));
        assert!(source.contains("data::commands::data_kv_delete_many,"));
    }

    /// 이 fn 의 정의들이 덮는 플랫폼: (macos 덮음, 비-macos 덮음).
    fn coverage(module: &str, func: &str) -> Option<(bool, bool)> {
        let src = module_src(module);
        let needle = format!("fn {func}(");
        let mut mac = false;
        let mut other = false;
        let mut found = false;
        let mut from = 0usize;
        while let Some(rel) = src[from..].find(&needle) {
            let at = from + rel;
            found = true;
            let head: Vec<&str> = src[..at].lines().rev().take(4).collect();
            let is_mac = head.iter().any(|l| l.contains("cfg(target_os = \"macos\")"));
            let is_not_mac = head.iter().any(|l| l.contains("cfg(not(target_os = \"macos\"))"));
            if is_mac {
                mac = true;
            } else if is_not_mac {
                other = true;
            } else {
                mac = true;
                other = true; // 조건 없는 정의 = 전 플랫폼
            }
            from = at + needle.len();
        }
        found.then_some((mac, other))
    }

    #[test]
    fn every_registration_has_a_body_on_every_platform_it_compiles_on() {
        let regs = registered();
        assert!(regs.len() > 50, "등록 목록을 못 읽었다 — 빈 스캔이 통과로 위장한다: {}", regs.len());
        let mut paired_seen = 0;
        let mut broken = Vec::new();
        for (module, func, reg_macos_only) in regs {
            let Some((mac, other)) = coverage(&module, &func) else {
                continue; // 본체 부재는 컴파일러가 즉시 잡는다
            };
            if mac && other {
                paired_seen += 1;
            }
            let need_other = !reg_macos_only;
            if !mac || (need_other && !other) {
                broken.push(format!(
                    "{module}::{func} — 등록 macos전용={reg_macos_only}, 정의 macos={mac} 비macos={other}"
                ));
            }
        }
        // 오라클 생존 단언 — 커버리지 파싱이 죽으면 이 테스트는 아무것도 지키지 않는다.
        assert!(paired_seen > 0, "전 플랫폼 정의를 하나도 못 찾았다 — 파싱이 죽었다");
        broken.sort();
        assert_eq!(broken, Vec::<String>::new(), "등록이 도는 플랫폼에 본체가 없다");
    }
}
