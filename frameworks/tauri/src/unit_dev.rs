// 개발 unit source 선언의 프레임워크 자리 — **몸은 soksak-core::unit_dev 가 진다.**
//
// 규칙이 껍데기에 살면 앱과 cored 가 같은 config 를 다른 기준으로 읽고, 그 차이는 거부가
// 아니라 한쪽에서만 보이는 유닛으로 나타난다. 여기 남는 것은 앰비언트 홈·빌드 축을 값으로
// 꺼내 넘기는 번역층뿐이다.

pub use soksak_core::unit_dev::*;

#[tauri::command]
pub fn unit_dev_list() -> Result<Vec<UnitDevSource>, String> {
    let id = crate::identity::ambient();
    list_in(id.home(), &crate::home::core_build_for_identifier(id.identifier()))
}

#[tauri::command]
pub fn unit_dev_set(kind: String, id: String, source: String) -> Result<UnitDevSource, String> {
    let build = crate::home::core_build_for_identifier(crate::identity::ambient().identifier());
    ensure_dev_identity_build(&build)?;
    set_source(
        crate::identity::ambient().home(),
        &kind,
        &id,
        std::path::Path::new(&source),
    )
}

#[tauri::command]
pub fn unit_dev_validate_path(source: String) -> Result<String, String> {
    validate_source_path_in(std::path::Path::new(&source), crate::identity::ambient().home())?;
    Ok(source)
}

#[tauri::command]
pub fn unit_dev_remove(kind: String, id: String) -> Result<bool, String> {
    remove_source(crate::identity::ambient().home(), &kind, &id)
}

// 이 실행물을 끈다.
//
// 하니스가 앱을 끄려고 운영체제를 빌렸다(`osascript ... to quit`). 끌 수 있는 이름이 없었기
// 때문이다 — 부를 수 없는 것은 검증할 수 없고, 없으면 만드는 것까지가 이 자리의 몫이다(A27).
//
// 종료는 cored 감사 기록의 성공 여부에 종속되지 않는다. 원장 소켓이 막힌 상태에서 publish를
// 메인 스레드에서 먼저 실행하면 창은 사라져도 프로세스와 IPC 소켓이 남아 다음 기동을 막는다.
// 기록과 종료를 서로 독립된 작업으로 큐잉하고, 종료 신호는 반드시 메인 이벤트 큐로 보낸다.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    let audit_app = app.clone();
    std::thread::spawn(move || {
        crate::activity::publish(
            &audit_app,
            "app.quit",
            "command",
            serde_json::json!({ "reason": "명령으로 끈다 — 이 뒤로 이 프로세스의 기록은 없다" }),
        );
    });
    std::thread::spawn(move || {
        let exiting = app.clone();
        let _ = app.run_on_main_thread(move || exiting.exit(0));
    });
}

#[tauri::command]
pub fn app_environment() -> Result<AppEnvironment, String> {
    // 앰비언트 전역은 여기서 **한 번** 읽어 값으로 만든다. 옛 판은 identifier·홈을 각각
    // 따로 읽어, 두 값이 어긋난 조합("A 홈인데 B identifier")이 원리적으로 가능했다.
    let id = crate::identity::ambient();
    let identity = id.identifier().to_string();
    let core_build = crate::home::core_build_for_identifier(&identity);
    let cli = id.cli_name();
    let units = unit_dev_list()?;
    let rejected = rejected_in(id.home(), &core_build)?;
    Ok(AppEnvironment {
        rejected_development_units: rejected,
        updater_enabled: core_build == "release",
        unit_mode: if units.is_empty() {
            "official"
        } else {
            "mixed"
        },
        core_build,
        identity,
        cli,
        home: id.home().to_string_lossy().into_owned(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        development_units: units,
    })
}
