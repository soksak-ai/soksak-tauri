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
