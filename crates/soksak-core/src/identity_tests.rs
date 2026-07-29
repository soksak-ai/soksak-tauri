// 정체성 파생의 검사 — 규칙은 identity.rs 가, 그 증명은 여기가 진다.
//
// 픽스처(../fixtures/identity.json)가 이 규칙의 정본이고 JS 쌍둥이
// (frameworks/electron/cored.cjs)가 같은 파일에 묶인다. 두 벌이면 같은 identifier 가
// 프로세스마다 다른 홈·다른 이름을 답하고, 그 어긋남은 오류가 아니라 "내 데이터가
// 안 보인다"로 나타난다.
use super::*;

#[test]
fn release_is_the_app_segment_and_nothing_else() {
    assert!(is_release_identifier("com.soksak.app"));
    assert!(!is_release_identifier("com.soksak.dev"));
    assert!(!is_release_identifier("com.soksak.debug"));
}

#[test]
fn the_last_segment_names_the_build_and_the_cli() {
    assert_eq!(core_build_for_identifier("com.soksak.app"), "release");
    assert_eq!(core_build_for_identifier("com.soksak.dev"), "dev");
    assert_eq!(core_build_for_identifier("com.soksak.debug"), "debug");
    assert_eq!(cli_for_core_build("release"), "sok");
    assert_eq!(cli_for_core_build("dev"), "sok-dev");
    assert_eq!(cli_for_core_build("debug"), "sok-debug");
}

#[test]
fn a_new_identity_gets_its_own_home_without_a_list() {
    assert_eq!(home_suffix_for_identifier("com.soksak.app"), "");
    assert_eq!(home_suffix_for_identifier("com.soksak.dev"), "-dev");
    assert_eq!(home_suffix_for_identifier("com.soksak.debug"), "-debug");
    assert_eq!(home_suffix_for_identifier("com.soksak.beta"), "-beta");
    assert_eq!(core_build_for_identifier("com.soksak.beta"), "beta");
    assert_eq!(cli_for_core_build("beta"), "sok-beta");
}

/// 픽스처가 오라클이다 — 이 파일 하나를 JS 쪽 검사도 읽는다. 규칙이 두 벌이면 같은
/// identifier 가 프로세스마다 다른 홈을 답하고, 그 어긋남은 "내 데이터가 안 보인다"로
/// 나타난다(오류가 아니다).
#[test]
fn the_fixture_binds_both_implementations() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/identity.json")).expect("픽스처");
    assert_eq!(doc["product"].as_str(), Some(PRODUCT));
    let cases = doc["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "픽스처가 비었다 — 판정할 수 없다");
    for c in cases {
        let id = c["identifier"].as_str().unwrap();
        let why = c["why"].as_str().unwrap_or("");
        assert_eq!(
            framework_for_identifier(id).as_deref(),
            c["framework"].as_str(),
            "{id}: framework — {why}"
        );
        assert_eq!(core_build_for_identifier(id), c["coreBuild"].as_str().unwrap(), "{id}: coreBuild");
        assert_eq!(home_suffix_for_identifier(id), c["homeSuffix"].as_str().unwrap(), "{id}: homeSuffix");
        assert_eq!(product_name_for_identifier(id), c["productName"].as_str().unwrap(), "{id}: productName");
        assert_eq!(cli_for_identifier(id), c["cli"].as_str().unwrap(), "{id}: cli");
        assert_eq!(
            keychain_service_for_identifier(id),
            c["keychainService"].as_str().unwrap(),
            "{id}: keychainService"
        );
    }
}

/// 볼트 파일과 그 열쇠는 **같은 축**이다.
///
/// 볼트는 홈에 산다(`<home>/secrets.vault`). 그 열쇠(OS 키체인 KEK)의 서비스명이 프레임워크로
/// 갈리면 파일과 열쇠가 서로 다른 축이 되고, 홈을 공유해도 둘째 프레임워크는 그 볼트를 못 연다.
/// 못 여는 것으로 끝나지도 않는다 — 빈 볼트를 새로 만드는 경로로 새면 앱은 "시크릿이 비었다"를
/// 답하고, 그것은 오류로 보이지 않는다.
#[test]
fn the_vault_key_and_the_vault_file_share_one_axis() {
    for (a, b) in [
        ("com.soksak.tauri.dev", "com.soksak.electron.dev"),
        ("com.soksak.tauri.app", "com.soksak.electron.app"),
    ] {
        assert_eq!(
            home_suffix_for_identifier(a),
            home_suffix_for_identifier(b),
            "홈이 같은데"
        );
        assert_eq!(
            keychain_service_for_identifier(a),
            keychain_service_for_identifier(b),
            "{a} 와 {b} 의 볼트 열쇠가 갈렸다 — 같은 홈의 볼트를 한쪽이 못 연다"
        );
    }
}

/// 프레임워크 축이 붙기 전에 만들어진 볼트가 그대로 열린다.
///
/// `~/.soksak-dev` 의 볼트는 `com.soksak.dev` 가 만들었다. 새 규칙이 그 이름을 내놓지 않으면
/// 기존 볼트가 열리지 않는다 — 이 단언은 값 대조여야 한다(존재 확인이 아니라).
#[test]
fn an_identifier_with_a_framework_axis_still_names_the_old_vault_key() {
    assert_eq!(keychain_service_for_identifier("com.soksak.tauri.dev"), "com.soksak.dev");
    assert_eq!(keychain_service_for_identifier("com.soksak.electron.dev"), "com.soksak.dev");
    // 옛 모양은 자기 자신을 답한다 — 규칙 하나가 둘 다 읽는다.
    assert_eq!(keychain_service_for_identifier("com.soksak.dev"), "com.soksak.dev");
    assert_eq!(keychain_service_for_identifier("com.soksak.app"), "com.soksak.app");
}

/// env 가 다르면 열쇠도 갈린다 — 홈이 갈리므로 볼트도 갈린다.
#[test]
fn a_different_environment_gets_a_different_vault_key() {
    assert_ne!(
        keychain_service_for_identifier("com.soksak.tauri.dev"),
        keychain_service_for_identifier("com.soksak.tauri.debug")
    );
}

#[test]
fn windows_falls_back_to_userprofile_and_others_do_not() {
    assert_eq!(
        home_base(false, Some("/home/max"), Some("C:\\Users\\max")),
        PathBuf::from("/home/max")
    );
    assert_eq!(
        home_base(true, Some("H:\\home"), Some("C:\\Users\\max")),
        PathBuf::from("H:\\home")
    );
    assert_eq!(
        home_base(true, None, Some("C:\\Users\\max")),
        PathBuf::from("C:\\Users\\max")
    );
    assert_eq!(
        home_base(true, Some(""), Some("C:\\Users\\max")),
        PathBuf::from("C:\\Users\\max")
    );
    assert_eq!(
        home_base(false, None, Some("C:\\Users\\max")),
        PathBuf::from("")
    );
}

#[test]
fn the_home_derives_from_the_identifier_only() {
    assert_eq!(
        home_for(Some("com.soksak.debug"), false, Some("/home/max"), None),
        PathBuf::from("/home/max/.soksak-debug")
    );
    assert_eq!(
        home_for(Some("com.soksak.app"), false, Some("/home/max"), None),
        PathBuf::from("/home/max/.soksak")
    );
    assert_eq!(
        home_for(Some("com.soksak.beta"), false, Some("/home/max"), None),
        PathBuf::from("/home/max/.soksak-beta")
    );
    assert_eq!(
        home_for(None, false, Some("/home/max"), None),
        PathBuf::from("/home/max/.soksak")
    );
}

#[test]
fn the_platform_is_an_argument_not_a_compile_target() {
    // 같은 입력이 플랫폼 인자로만 갈린다 — 바이너리가 무엇인지로 갈리지 않는다.
    assert_ne!(
        home_for(Some("com.soksak.app"), true, None, Some("C:\\Users\\max")),
        home_for(Some("com.soksak.app"), false, None, Some("C:\\Users\\max"))
    );
}

/// 소켓 자리는 홈과 identifier 둘 다에서 나온다 — 한쪽만 갈려도 다른 파일이 된다.
#[test]
fn the_control_socket_sits_in_the_home_named_by_the_identifier() {
    let id = Identity::new("/home/max/.soksak-dev", "com.soksak.dev");
    assert_eq!(
        id.control_socket(),
        PathBuf::from("/home/max/.soksak-dev/com.soksak.dev.sock")
    );
    // 두 identity 는 두 소켓이다(같은 자리를 쓰면 나중 것이 앞 것을 거절한다).
    assert_ne!(
        Identity::new("/home/max/.soksak", "com.soksak.app").control_socket(),
        id.control_socket()
    );
}


/// 전용 저장소는 설치 트리와 **다른 자리**다 — 같은 자리로 파생하면 플러그인 제거가
/// 데이터까지 지운다(재설치 시 보존 결정이 조용히 깨진다).
#[test]
fn the_plugin_store_sits_beside_the_install_tree_not_inside_it() {
    let id = Identity::new("/u/max/.soksak-dev", "com.soksak.dev");
    assert_eq!(
        id.plugin_data_dir(),
        PathBuf::from("/u/max/.soksak-dev/plugins-data")
    );
    assert_ne!(id.plugin_data_dir(), id.plugins_dir());
    assert!(!id.plugin_data_dir().starts_with(id.plugins_dir()));
    // 자유 함수와 메서드가 같은 규칙이다 — 정체성을 아직 못 모은 자리도 같은 곳을 본다.
    assert_eq!(
        id.plugin_data_dir(),
        plugin_data_dir(Path::new("/u/max/.soksak-dev"))
    );
}

#[test]
fn a_sibling_identity_home_is_foreign() {
    let home = Path::new("/u/max/.soksak-dev");
    assert_eq!(
        foreign_identity_home(Path::new("/u/max/.soksak-debug/plugins/x"), home),
        Some(PathBuf::from("/u/max/.soksak-debug"))
    );
    assert_eq!(
        foreign_identity_home(Path::new("/u/max/.soksak/plugins/x"), home),
        Some(PathBuf::from("/u/max/.soksak"))
    );
}

#[test]
fn this_home_and_plain_checkouts_are_not_foreign() {
    let home = Path::new("/u/max/.soksak-dev");
    assert_eq!(
        foreign_identity_home(Path::new("/u/max/.soksak-dev/plugins/x"), home),
        None
    );
    assert_eq!(
        foreign_identity_home(Path::new("/u/max/work/plugin"), home),
        None
    );
    // 이름이 비슷해도 형제가 아니면 홈이 아니다.
    assert_eq!(
        foreign_identity_home(Path::new("/other/.soksak-debug/x"), home),
        None
    );
}

#[test]
fn only_the_dev_lane_accepts_a_dev_source() {
    let home = Path::new("/u/max/.soksak-dev");
    let own = Path::new("/u/max/work/plugin");
    assert!(dev_source_accepted(own, home, "dev"));
    assert!(!dev_source_accepted(own, home, "debug"));
    assert!(!dev_source_accepted(own, home, "release"));
    // dev 레인이라도 남의 홈 안은 거부한다.
    assert!(!dev_source_accepted(
        Path::new("/u/max/.soksak-debug/plugins/x"),
        home,
        "dev"
    ));
}
