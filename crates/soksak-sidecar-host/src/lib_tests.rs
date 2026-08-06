// 사이드카 호스팅의 검사 — 규칙은 lib.rs 가, 그 증명은 여기가 진다.
//
// 순수부만 잰다: 이름 검증(경로 traversal 가드를 겸한다), 경로 파생, 계약 대조, ABI 레이아웃.
// 그 넷이 어긋나면 실패가 조용하다 — 잘못된 이름은 남의 경로를 열고, 어긋난 레이아웃은
// 오류가 아니라 **다른 필드를 읽는다**.
use super::*;

#[test]
fn name_validation_guards_path_traversal() {
    assert!(valid_name("chromium"));
    assert!(valid_name("a-b-1"));
    assert!(!valid_name(""));
    assert!(!valid_name("-lead"));
    assert!(!valid_name("Upper"));
    assert!(!valid_name("../evil"));
    assert!(!valid_name("a/b"));
    assert!(!valid_name("a.b"));
}

#[test]
fn module_path_default_layout_and_override() {
    // 인자는 identity 홈 자체(home.rs 파생) — 사이드카는 그 아래 sidecars/ 에 산다.
    let home = std::path::Path::new("/Users/x/.soksak-debug");
    assert_eq!(
        module_path("browser-chromium", home),
        std::path::PathBuf::from(
            "/Users/x/.soksak-debug/sidecars/soksak-sidecar-browser-chromium/dist/soksak-sidecar-browser-chromium.dylib"
        )
    );
}

#[test]
fn sidecar_interface_matches_by_id_and_semver_range_not_exact_string() {
    let requirement = soksak_spec_contract::ContractRequirement::new(
        "soksak-spec-sidecar-browser",
        ">=0.0.1 <0.1.0",
    )
    .unwrap();
    let compatible =
        soksak_spec_contract::ContractProviderRef::new("soksak-spec-sidecar-browser", "0.0.2")
            .unwrap();
    let incompatible =
        soksak_spec_contract::ContractProviderRef::new("soksak-spec-sidecar-browser", "0.1.0")
            .unwrap();
    assert!(validate_sidecar_interface(&requirement, &compatible).is_ok());
    assert!(validate_sidecar_interface(&requirement, &incompatible).is_err());
}

#[test]
fn sidecar_interface_rejects_non_sidecar_namespaces() {
    let requirement =
        soksak_spec_contract::ContractRequirement::new("soksak-spec-service", "0.0.1").unwrap();
    let provider =
        soksak_spec_contract::ContractProviderRef::new("soksak-spec-service", "0.0.1").unwrap();
    assert!(validate_sidecar_interface(&requirement, &provider).is_err());
}

#[test]
fn engine_abi_v1_carries_provider_id_and_version_as_distinct_fields() {
    let pointer_alignment = std::mem::align_of::<*const c_char>();
    let first_pointer = (std::mem::size_of::<u32>() + pointer_alignment - 1)
        / pointer_alignment
        * pointer_alignment;
    assert_eq!(std::mem::offset_of!(SoksakSidecarEngineAbi, abi), 0);
    assert_eq!(
        std::mem::offset_of!(SoksakSidecarEngineAbi, interface_id),
        first_pointer
    );
    assert_eq!(
        std::mem::offset_of!(SoksakSidecarEngineAbi, interface_version),
        first_pointer + std::mem::size_of::<*const c_char>()
    );
}

#[test]
fn native_surface_events_preserve_the_declared_surface_identity() {
    let created = serde_json::json!({
        "event": "surface-created",
        "view": 41,
        "surfaceKey": "chromium-tab-a",
    });
    let destroyed = serde_json::json!({
        "event": "surface-destroyed",
        "view": 41,
        "surfaceKey": "chromium-tab-a",
    });

    assert_eq!(
        native_surface_event(&created),
        Some(NativeSurfaceEvent { ptr: 41, key: Some("chromium-tab-a"), alive: true }),
    );
    assert_eq!(
        native_surface_event(&destroyed),
        Some(NativeSurfaceEvent { ptr: 41, key: Some("chromium-tab-a"), alive: false }),
    );
    assert_eq!(native_surface_event(&serde_json::json!({ "event": "surface-created", "view": 0 })), None);
}
