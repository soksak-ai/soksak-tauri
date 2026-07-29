// 볼트의 프레임워크 자리 — 몸은 soksak-vault 가 진다.
//
// 여기 남는 것은 둘뿐이다. ① OS 키체인에서 KEK 를 얻는 출처(OsKekSource) — 키체인은
// 플랫폼 표면이고 keyring 이 windows-sys 를 끌고 온다. ② `#[tauri::command]` 래퍼 —
// 한 줄 위임이고, 그래서 같은 로직이 프로세스마다 갈리지 않는다.

// 볼트의 몸은 크레이트가 진다 — 이 모듈의 이름으로 부르던 호출자가 그대로 서게 다시 내보낸다.
pub use soksak_vault::*;

use tauri::State;
use zeroize::Zeroizing;

use crate::identity::Identity;
use crate::os_key::{self, KekStore};
use soksak_vault::{KekError, KekSource, KEK_LEN};


// 프로덕션 — os_key OS 키체인. 신원 ACL 결속. keyring 은 이 구조 안에서만
// 인스턴스화 → SecretsState::default()(store 미주입)는 키체인·CoreFoundation 을 절대 안 건드린다.
pub struct OsKekSource {
    store: KekStore,
}

impl OsKekSource {
    // 키체인 서비스명은 정체성의 identifier 다 — dev/debug/release 가 KEK 를 공유하지 않는 근거가
    // 전역이 아니라 인자로 온다(cored 는 자기 정체성을 모르고 태어나므로 받아야 한다).
    pub(crate) fn for_identity(identity: &Identity) -> Self {
        Self {
            store: KekStore::for_identity(identity),
        }
    }

    // 서비스명 확인용 — 값이 정체성에서 왔는지를 테스트가 본다(키체인 미접촉).
    #[cfg(test)]
    pub(crate) fn service(&self) -> &str {
        self.store.service()
    }
}

impl KekSource for OsKekSource {
    fn acquire(&self) -> Result<Zeroizing<[u8; KEK_LEN]>, KekError> {
        os_key::get_or_create_kek(&self.store)
    }
    fn reachable(&self) -> bool {
        // read-only — Some/None(=미도달 아님) 둘 다 도달=true, StoreUnavailable/Corrupt 만 false.
        self.store.read().is_ok()
    }
    fn backend(&self) -> &'static str {
        os_backend_label()
    }
}

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
