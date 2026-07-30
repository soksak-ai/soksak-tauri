// 유닛 설치의 프레임워크 자리 — **몸은 soksak-install 이 진다.**
//
// 설치는 디스크와 네트워크다. 창도 앱 핸들도 필요 없고, 필요한 것은 홈 하나(정체성)뿐이다.
// 여기 남는 것은 `tauri::State` 를 벗겨 넘기는 번역층뿐이고, 그래서 같은 다섯을 다른
// 프로세스가 그대로 부를 수 있다.

pub use soksak_install::*;

#[tauri::command]
pub fn unit_install_begin(
    manager: tauri::State<'_, UnitInstallManager>,
    registry_id: String,
    root: UnitIdentity,
) -> Result<InstallTransactionReply, String> {
    install_begin(manager.inner(), registry_id, root)
}

#[tauri::command]
pub fn unit_install_stage(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    registry_id: String,
    unit: UnitIdentity,
    artifact: StageArtifact,
) -> Result<StagedArtifactReply, String> {
    install_stage(
        manager.inner(),
        &transaction_id,
        &registry_id,
        unit,
        artifact,
    )
}

#[tauri::command]
pub fn unit_install_read_utf8(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    handle: String,
    path: String,
) -> Result<String, String> {
    install_read_utf8(manager.inner(), &transaction_id, &handle, &path)
}

#[tauri::command]
pub fn unit_install_commit(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    units: Vec<VerifiedInstallUnit>,
) -> Result<CommitReply, String> {
    install_commit(manager.inner(), &transaction_id, units)
}

#[tauri::command]
pub fn unit_install_rollback(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
) -> Result<(), String> {
    install_rollback(manager.inner(), &transaction_id)
}


// 이 코어 빌드가 실행 중인 호스트의 유닛 타깃 트리플. 설치 클로저가 sidecar 아티팩트를
// per-(os,arch) 자산에서 고르는 단일 기준이다 — 프론트가 플랫폼을 추측하지 않는다.
//
// 판정표는 코어가 소유하고 **타깃은 인자로** 넘긴다. 이 자리가 넘기는 값이 곧 이 실행물의
// 빌드 상수라, 답은 옛 cfg 분기와 같다. 표를 모르는 호스트는 그럴듯한 트리플을 지어내는
// 대신 이름을 달고 실패한다 — 지어내면 그 유닛은 받아서 못 돈다.
#[tauri::command]
pub fn host_unit_target() -> Result<&'static str, String> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    soksak_core::unit_target::host_target(os, arch)
        .ok_or_else(|| format!("유닛 타깃이 정의되지 않은 호스트다: {os}-{arch}"))
}
