// OS 키체인 device KEK — 볼트 KEK(32B)를 OS 보안 저장소(macOS Keychain / Windows Credential
// Manager / Linux Secret Service)에 get-or-create 하는 단일책임 모듈. 이 KEK 로 볼트를 어떻게 여는지
// (secrets.rs 투명 언락 배선)는 이 모듈이 모른다 — 여기는 오직 "32B KEK 바이트를 OS 저장소에서
// get-or-create" 만 책임진다(단일 책임). 볼트·Argon2·verifier 를 전혀 모른다.
//
// ── 안전핀(fail-loud) ────────────────────────────────────────────────────────
// 무음 폴백·무음 재생성 절대 금지. 헤드리스 Linux/무 D-Bus 세션/잠긴 컬렉션은 StoreUnavailable 로
// 표면화한다(파일 키 무음 생성 = P0 가 지운 SOKSAK_VAULT_KEY 백도어 재도입이므로 금지). 저장 blob 이
// 32B base64 가 아니면 Corrupt — 새 KEK 를 무음 발급하면 옛 KEK 로 wrap 된 볼트가 영구 복호불가(전손).
//
// ── 메모리 위생(zeroize) — 실제 스크럽 범위(거짓 주장 0) ─────────────────────────
// 반환 KEK 는 Zeroizing<[u8;32]> — 호출자 drop 시 자동 스크럽(컴파일 타임 보장). 생성 시 랜덤 raw·
// base64 중간 문자열·decode 중간 Vec 은 Zeroizing/명시 zeroize 로 소거. 한계(정직): keyring 플랫폼
// impl 내부 버퍼(get_password 가 만드는 String 등 크레이트 경계 밖)는 우리가 닿지 못한다 — 비보장.
//
// ── 서비스 신원 격리 ──────────────────────────────────────────────────────────
// 키체인 서비스명 = soksak_core::identity::keychain_service_for_identifier() → **홈과 같은 축(env)**
// 이다. 볼트 파일이 홈에 사는데 그 열쇠가 프레임워크로 갈리면 파일과 열쇠가 서로 다른 축이 되고,
// 홈을 공유해도 둘째 프레임워크는 그 볼트를 못 연다. dev/debug/release 는 홈이 갈리므로 KEK 도 갈린다.
// account = "device-kek-v1"(버전드 — 미래 마이그레이션).
//
// 바이너리 격리는 **이것과 별개**다. macOS 키체인 항목의 접근 권한은 바이너리 단위(ACL)이고,
// 다른 실행물이 같은 항목을 읽으면 OS 가 **거절하는 것이 아니라 사용자에게 묻는다**. 그리고 개발
// 빌드는 ad-hoc 서명이라 빌드마다 신원이 바뀌어 그 물음이 되돌아온다. 그래서 프롬프트를 한 번으로
// 만들려면 키체인을 만지는 실행물을 하나로 못박아야 하고, 그것은 이 모듈이 정할 일이 아니다.
//
// ── 동시 create 경합 ──────────────────────────────────────────────────────────
// 한때 "ipc.rs 소켓 선점으로 단일 인스턴스"라 무시할 수 있다고 적혀 있었다. 그 전제는 **깨졌다**:
// 소켓 이름이 `<home>/<identifier>.sock` 이라 정체성이 다른 두 실행물은 서로 다른 파일을 잡고,
// 서로를 선점하지 않는다. 홈이 같아도 그렇다.
//
// 남은 안전판은 순서뿐이다 — read→(없으면) write 라 최악의 경우 마지막 write 가 이긴다. 그리고
// 지는 쪽의 KEK 로 wrap 된 볼트가 있으면 그것은 복호 불가가 된다. 실제로 그 창이 열리는 것은 볼트가
// **아직 없을 때**뿐이므로 오늘의 위험은 낮지만, 무시 가능한 이유가 바뀌었다는 사실은 남긴다.

pub use soksak_vault::{get_or_create_kek, KekError, SecretStore};




// 에러 타입 — String 관례를 의도적으로 벗어난 typed enum. 헤드리스 감지가 호출부의 분기(무음 폴백
// 금지)를 강제하므로 String 으론 부족하다(패턴매치 불가). 상위 경계는 String 으로 축약할 수 있다.
#[derive(Debug)]






// 프로덕션 store — keyring::Entry. 서비스는 정체성의 **env 축**에서 나오고(볼트가 사는 홈과 같은 축),
// account="device-kek-v1"(버전드). 규칙의 단일진실은 soksak_core::identity 다.
pub struct KekStore {
    service: String,
    account: String,
}

impl KekStore {
    // 서비스명은 정체성에서 온다 — 전역 identifier 읽기를 호출자(부트)에게 올린다.
    // cored 프로세스는 자기 identifier 를 전역으로 알 수 없고, 틀리면 조용히 남의 KEK 를 연다.
    pub(crate) fn for_identity(identity: &crate::identity::Identity) -> Self {
        Self {
            service: soksak_core::identity::keychain_service_for_identifier(identity.identifier()),
            account: "device-kek-v1".to_string(),
        }
    }

    // 진단·검증용 — 어느 서비스로 결속됐는지(키체인 미접촉).
    #[cfg(test)]
    pub(crate) fn service(&self) -> &str {
        &self.service
    }
}

// keyring::Error 분류 — NoStorageAccess/PlatformFailure 는 StoreUnavailable(헤드리스·잠금·무 D-Bus),
// 그 외는 StoreFailure. NoEntry 는 read 에서 Ok(None) 로 별도 처리(여기로 오지 않는다).
fn classify(err: keyring::Error) -> KekError {
    match err {
        keyring::Error::NoStorageAccess(inner) => KekError::StoreUnavailable(inner.to_string()),
        keyring::Error::PlatformFailure(inner) => KekError::StoreUnavailable(inner.to_string()),
        other => KekError::StoreFailure(other.to_string()),
    }
}

impl SecretStore for KekStore {
    fn read(&self) -> Result<Option<String>, KekError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(classify)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(classify(other)),
        }
    }

    fn write(&self, secret: &str) -> Result<(), KekError> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(classify)?;
        entry.set_password(secret).map_err(classify)
    }
}

#[cfg(test)]
#[path = "os_key_tests.rs"]
mod tests;
