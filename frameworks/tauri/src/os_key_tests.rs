// OS 키체인 KEK 의 검사 — 규칙은 os_key.rs 가, 그 증명은 여기가 진다.
//
// 실 키체인을 건드리지 않는다. 인메모리 store 로 get-or-create 와 안전핀(무음 재생성 금지)을
// 재고, 서비스명은 값으로 대조한다 — 존재 확인만 하면 이름이 틀려도 통과하고, 틀린 이름은
// 빈 볼트를 새로 만드는 경로로 이어진다(그때 앱은 "시크릿이 비었다"를 답한다).
use super::*;
use std::sync::Mutex;

// 인메모리 store — 실 키체인 미접촉(set_var 0, keyring 미호출). write 횟수를 기록해
// "무음 재생성 없음"(Corrupt 시 write 미호출)까지 검증한다.
struct MemoryKeyStore {
    slot: Mutex<Option<String>>,
    writes: Mutex<u32>,
}

impl MemoryKeyStore {
    fn empty() -> Self {
        Self {
            slot: Mutex::new(None),
            writes: Mutex::new(0),
        }
    }
    fn seeded(value: &str) -> Self {
        Self {
            slot: Mutex::new(Some(value.to_string())),
            writes: Mutex::new(0),
        }
    }
    fn writes(&self) -> u32 {
        *self.writes.lock().unwrap()
    }
    fn peek(&self) -> Option<String> {
        self.slot.lock().unwrap().clone()
    }
}

impl SecretStore for MemoryKeyStore {
    fn read(&self) -> Result<Option<String>, OsKeyError> {
        Ok(self.slot.lock().unwrap().clone())
    }
    fn write(&self, secret: &str) -> Result<(), OsKeyError> {
        *self.writes.lock().unwrap() += 1;
        *self.slot.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
}

// 헤드리스/무 D-Bus 시뮬레이션 — read/write 가 항상 StoreUnavailable.
struct UnavailableStore;
impl SecretStore for UnavailableStore {
    fn read(&self) -> Result<Option<String>, OsKeyError> {
        Err(OsKeyError::StoreUnavailable("no secret-service".to_string()))
    }
    fn write(&self, _secret: &str) -> Result<(), OsKeyError> {
        Err(OsKeyError::StoreUnavailable("no secret-service".to_string()))
    }
}

// 생성 후 재조회 안정 — 같은 store 로 2회 호출 시 동일 KEK, 2회차는 write 안 함.
#[test]
fn create_then_read_stable() {
    let store = MemoryKeyStore::empty();
    let first = get_or_create_kek(&store).expect("create");
    let second = get_or_create_kek(&store).expect("read back");
    assert_eq!(first.as_ref(), second.as_ref(), "생성 후 재조회 안정");
    assert_eq!(store.writes(), 1, "재조회는 write 안 함(기존 값 반환)");
}

// 서로 다른 빈 store 2개 → 서로 다른 KEK(OsRng 랜덤 확인).
#[test]
fn absent_stores_yield_random() {
    let a = get_or_create_kek(&MemoryKeyStore::empty()).expect("a");
    let b = get_or_create_kek(&MemoryKeyStore::empty()).expect("b");
    assert_ne!(a.as_ref(), b.as_ref(), "빈 store 2개 → 서로 다른 랜덤 KEK");
}

// 손상 blob → Err(Corrupt), 그리고 write 미호출·슬롯 불변(무음 재생성 금지 회귀 가드).
#[test]
fn corrupt_blob_rejected() {
    // (1) 비-base64
    let bad = MemoryKeyStore::seeded("not-base64!!");
    let before = bad.peek();
    assert!(
        matches!(get_or_create_kek(&bad), Err(OsKeyError::Corrupt(_))),
        "비base64 → Corrupt"
    );
    assert_eq!(bad.writes(), 0, "Corrupt 는 재생성(write) 금지");
    assert_eq!(bad.peek(), before, "슬롯 값 불변(무음 재생성 없음)");

    // (2) 31B — 유효 base64지만 32B 미달
    let short = STANDARD.encode([7u8; 31]);
    let bad2 = MemoryKeyStore::seeded(&short);
    assert!(
        matches!(get_or_create_kek(&bad2), Err(OsKeyError::Corrupt(_))),
        "31B → Corrupt"
    );
    assert_eq!(bad2.writes(), 0, "길이 미달도 재생성 금지");
}

// 미도달 store → get_or_create_kek 이 Err(StoreUnavailable) 전파(Ok 폴백 아님). 무음 폴백 금지 가드.
#[test]
fn unavailable_surfaces_error() {
    let result = get_or_create_kek(&UnavailableStore);
    assert!(
        matches!(result, Err(OsKeyError::StoreUnavailable(_))),
        "무음 폴백 금지 — StoreUnavailable 를 그대로 표면화해야"
    );
}

// decode_kek 경계 단위 — 정확히 32B 만 통과, 그 외 길이·디코드 실패는 Corrupt.
#[test]
fn decode_length_gate() {
    let exact = STANDARD.encode([9u8; KEK_LEN]);
    assert_eq!(decode_kek(&exact).unwrap().as_ref(), &[9u8; KEK_LEN]);

    let long = STANDARD.encode([1u8; 33]);
    assert!(
        matches!(decode_kek(&long), Err(OsKeyError::Corrupt(_))),
        "33B → Corrupt"
    );
    assert!(
        matches!(decode_kek("@@@@"), Err(OsKeyError::Corrupt(_))),
        "디코드 실패 → Corrupt"
    );
}

// zeroize 는 drop 스크럽이라 직접 관측 불가 — 정직하게 타입으로만 증명한다. 반환 타입이
// Zeroizing<[u8;32]> 임을 컴파일 타임에 강제(이게 아니면 컴파일 실패). 크레이트 경계 밖 스크럽은 비보장.
#[test]
fn kek_is_zeroizing_typed() {
    fn assert_zeroizing(_: &Zeroizing<[u8; KEK_LEN]>) {}
    let kek = get_or_create_kek(&MemoryKeyStore::empty()).expect("create");
    assert_zeroizing(&kek);
}

/// 서비스명은 **값으로** 대조한다. 존재 확인만 하면 이름이 틀려도 통과하고, 틀린 이름은 빈 볼트를
/// 새로 만드는 경로로 이어진다 — 그때 앱은 오류가 아니라 "시크릿이 비었다"를 답한다.
#[test]
fn the_service_name_comes_from_the_environment_axis_not_the_framework() {
    let of = |id: &str| {
        OsKeyStore::for_identity(&crate::identity::Identity::new("/tmp/vault-axis", id))
            .service()
            .to_string()
    };
    // 프레임워크가 달라도 같은 볼트를 연다 — 홈이 하나이기 때문이다.
    assert_eq!(of("com.soksak.tauri.dev"), "com.soksak.dev");
    assert_eq!(of("com.soksak.electron.dev"), "com.soksak.dev");
    // env 가 다르면 홈이 갈리므로 열쇠도 갈린다.
    assert_eq!(of("com.soksak.tauri.debug"), "com.soksak.debug");
    assert_ne!(of("com.soksak.tauri.dev"), of("com.soksak.tauri.debug"));
}
