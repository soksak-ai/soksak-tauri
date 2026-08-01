// 개발 unit source 선언의 프레임워크 자리 — **몸은 soksak-core::unit_dev 가 진다.**
//
// 규칙이 껍데기에 살면 앱과 cored 가 같은 config 를 다른 기준으로 읽고, 그 차이는 거부가
// 아니라 한쪽에서만 보이는 유닛으로 나타난다. 여기 남는 것은 앰비언트 홈·빌드 축을 값으로
// 꺼내 넘기는 번역층뿐이다.

pub use soksak_core::unit_dev::*;

use std::path::Path;

#[tauri::command]
pub fn unit_dev_list() -> Result<Vec<UnitDevSource>, String> {
    let id = crate::identity::ambient();
    list_in(id.home(), &crate::home::core_build_for_identifier(id.identifier()))
}

fn ensure_dev_identity() -> Result<(), String> {
    ensure_dev_identity_build(&crate::home::core_build_for_identifier(
        crate::identity::ambient().identifier(),
    ))
}

#[tauri::command]
pub fn unit_dev_set(kind: String, id: String, source: String) -> Result<UnitDevSource, String> {
    ensure_dev_identity()?;
    set_source(
        crate::identity::ambient().home(),
        &kind,
        &id,
        Path::new(&source),
    )
}

#[tauri::command]
pub fn unit_dev_validate_path(source: String) -> Result<String, String> {
    validate_source_path_in(Path::new(&source), crate::identity::ambient().home())?;
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
// **이 명령은 자기 죽음을 기록하지 못한다.** 종료가 기록보다 먼저 끝나기 때문이다. 그래서 끄기
// 전에 그 사실을 원장에 적고, 그 다음에 끈다 — 원장에 없으면 "끄라는 말을 못 들었다"와
// "듣고 죽었다"를 구분할 수 없다.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    crate::activity::publish(
        &app,
        "app.quit",
        "command",
        serde_json::json!({ "reason": "명령으로 끈다 — 이 뒤로 이 프로세스의 기록은 없다" }),
    );
    app.exit(0);
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
