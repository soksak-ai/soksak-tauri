// 볼트의 프레임워크 자리 — 몸은 soksak-vault 가 진다.
//
// 여기 남는 것은 `#[tauri::command]` 래퍼뿐이다 — 한 줄 위임이고, 그래서 같은 로직이
// 프로세스마다 갈리지 않는다. 키체인 출처(OsKekSource)도 볼트로 갔다: 키체인은 **플랫폼**
// 자원이지 프레임워크 자원이 아니라, 껍데기에 두면 볼트 파일과 그 열쇠가 서로 다른 축이 된다.

// 볼트의 몸은 크레이트가 진다 — 이 모듈의 이름으로 부르던 호출자가 그대로 서게 다시 내보낸다.
pub use soksak_vault::*;

use tauri::State;



#[tauri::command]
pub fn secret_set(
    ns: String,
    key: String,
    value: String,
    state: State<'_, SecretsState>,
) -> Result<(), String> {
    state.set(&ns, &key, &value)
}

#[tauri::command]
pub fn secret_has(ns: String, key: String, state: State<'_, SecretsState>) -> Result<bool, String> {
    state.has(&ns, &key)
}

#[tauri::command]
pub fn secret_delete(
    ns: String,
    key: String,
    state: State<'_, SecretsState>,
) -> Result<bool, String> {
    state.delete(&ns, &key)
}

#[tauri::command]
pub fn secret_keys(ns: String, state: State<'_, SecretsState>) -> Result<Vec<String>, String> {
    state.keys(&ns)
}

// 투명 언락 상태(os_key 백엔드·seal_available·expect_vault·keyId 목록). 프론트 secret.status 표면.
#[tauri::command]
pub fn secret_status(state: State<'_, SecretsState>) -> SecretStatus {
    state.status()
}

// 구 backend 조회(compat) — status 를 BackendInfo 로 축약. backend=os_key 라벨, unlocked=seal_available.
#[tauri::command]
pub fn secret_backend(state: State<'_, SecretsState>) -> Result<BackendInfo, String> {
    Ok(state.status().into())
}

// ── 테스트(순수 crypto) ──────────────────────────────────────────────────────

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
