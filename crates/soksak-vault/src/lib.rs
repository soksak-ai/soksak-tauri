//! 볼트 — 사람의 비밀을 파일 하나에 봉인해 두는 자리.
//!
//! 창도 앱 핸들도 OS 키체인도 모른다. **KEK 는 주입받는다**(`KekSource`) — 그 32바이트를
//! 어디서 얻는지는 플랫폼의 일이고, 볼트는 그 바이트로 무엇을 하는지만 안다. 그래서 이
//! 크레이트는 어느 프로세스에서 링크하든 같은 답을 낸다.
//!
//! 한때 이 몸이 프레임워크 폴더 안에 있었다. 그러면 백엔드가 둘이 될 때 볼트를 아는 쪽이
//! 하나뿐이고, 그 차이는 오류가 아니라 "시크릿이 비었다"로 나타난다.

pub const KEK_LEN: usize = 32;

// 반환 KEK — drop 시 자동 스크럽.
pub type Kek = Zeroizing<[u8; KEK_LEN]>;

#[derive(Debug)]
pub enum KekError {
    /// 키체인 미도달(헤드리스 Linux/무 D-Bus 세션/잠긴 컬렉션). 무음 폴백 금지 신호.
    StoreUnavailable(String),
    /// 키체인 도달했으나 연산 실패(쓰기 거부/모호/plat 실패).
    StoreFailure(String),
    /// 저장 blob 이 32B base64 아님. 재생성 금지(전손 차단) — 명시 실패.
    Corrupt(String),
}

impl std::fmt::Display for KekError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KekError::StoreUnavailable(m) => write!(f, "OS 키체인 미도달: {m}"),
            KekError::StoreFailure(m) => write!(f, "OS 키체인 연산 실패: {m}"),
            KekError::Corrupt(m) => write!(f, "OS 키체인 KEK 손상: {m}"),
        }
    }
}

// 테스트 seam — 실제 키체인 미접촉을 위한 주입 경계(resolve_vault_path 의 env 클로저 선례와 동형).
pub trait SecretStore {
    /// 미존재=Ok(None), 미도달=Err(StoreUnavailable).
    fn read(&self) -> Result<Option<String>, KekError>;
    fn write(&self, secret: &str) -> Result<(), KekError>;
}

// 핵심 — get-or-create. store 를 인자로 받는다(전역·env·set_var 0). 없으면 랜덤 32B 생성·영속·반환.
// Corrupt/StoreUnavailable 은 그대로 전파(무음 재생성·무음 폴백 절대 금지).
pub fn get_or_create_kek(store: &impl SecretStore) -> Result<Kek, KekError> {
    match store.read()? {
        Some(encoded) => decode_kek(&encoded),
        None => {
            let mut raw: Kek = Zeroizing::new([0u8; KEK_LEN]);
            OsRng.fill_bytes(raw.as_mut());
            // 인코딩 중간 문자열도 비밀이라 Zeroizing 으로 감싸 drop 시 소거.
            let encoded = Zeroizing::new(STANDARD.encode(raw.as_ref()));
            store.write(&encoded)?;
            Ok(raw)
        }
    }
}

// base64 → [u8;32]. 길이 불일치·디코드 실패는 Corrupt(재생성 금지 안전핀). 중간 Vec 즉시 zeroize.
fn decode_kek(encoded: &str) -> Result<Kek, KekError> {
    let mut decoded = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| KekError::Corrupt(format!("base64 아님: {e}")))?;
    if decoded.len() != KEK_LEN {
        let got = decoded.len();
        decoded.zeroize();
        return Err(KekError::Corrupt(format!(
            "KEK 길이 {got}B (기대 {KEK_LEN}B)"
        )));
    }
    let mut kek: Kek = Zeroizing::new([0u8; KEK_LEN]);
    kek.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(kek)
}

impl std::error::Error for KekError {}

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use soksak_core::identity::Identity;

// OWASP Argon2id 권장(2024): m=19456 KiB, t=2, p=1. 헤더에 기록 — 미래 파라미터 변경 대비.
pub const ARGON2_M_COST: u32 = 19456;
pub const ARGON2_T_COST: u32 = 2;
pub const ARGON2_P_COST: u32 = 1;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24; // XChaCha20Poly1305 = 24B nonce
pub const KEY_LEN: usize = 32;
// verifier 평문 마커 — KEK 로 봉인된 복호 결과가 이 값과 일치해야 passphrase 정합.
const VERIFIER_MARKER: &[u8] = b"soksak-vault-v1";
const VAULT_VERSION: u32 = 1;

// ── 직렬화 모델(serde_json) ──────────────────────────────────────────────────

// 항목 한 개 = envelope. 전부 암호문/nonce(평문 0). b64 직렬화(JSON 안전).
#[derive(Serialize, Deserialize, Clone)]
pub struct SealedItem {
    #[serde(with = "b64")]
    pub dek_nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub dek_ct: Vec<u8>, // KEK 로 wrap 된 DEK
    #[serde(with = "b64")]
    pub val_nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub val_ct: Vec<u8>, // DEK 로 암호화된 값
}

// 볼트 헤더(평문 — KEK 도출에 필요한 비밀 아닌 파라미터). salt 는 비밀이 아니다(KDF 표준).
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultHeader {
    pub version: u32,
    pub kdf: String, // "argon2id"
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    pub verifier: SealedItem, // VERIFIER_MARKER 를 KEK 로 봉인(passphrase 검증용)
}

// 볼트 전체 = 헤더 + entries(ns→key→항목). 단일 파일에 serde_json 으로 직렬화.
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultData {
    pub header: VaultHeader,
    pub entries: BTreeMap<String, BTreeMap<String, SealedItem>>,
}

// b64 직렬화 헬퍼(serde with). 바이트 → base64 문자열(JSON 호환).
mod b64 {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD
            .decode(s.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

// ── 순수 crypto(테스트 분리) ─────────────────────────────────────────────────

// passphrase + salt → KEK(32B). Argon2id, 헤더 파라미터. 실패는 사유 문자열.
// 파생 KEK 는 Zeroizing 으로 감싸 잔존 스택 사본을 소멸 시 자동 스크럽한다.
pub fn derive_kek(
    passphrase: &[u8],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let params =
        Params::new(m, t, p, Some(KEY_LEN)).map_err(|e| format!("argon2 파라미터: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(passphrase, salt, kek.as_mut())
        .map_err(|e| format!("KEK 도출 실패: {e}"))?;
    Ok(kek)
}

// 랜덤 nonce(24B, OsRng).
fn random_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut n);
    n
}

// XChaCha20Poly1305 AEAD 봉인. key(32B) + nonce(24B) + 평문 → 암호문(인증 태그 포함).
fn aead_seal(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .encrypt(XNonce::from_slice(nonce), plaintext)
        .map_err(|_| "AEAD 봉인 실패".to_string())
}

// XChaCha20Poly1305 AEAD 개봉. 잘못된 key 또는 변조 시 인증 실패 → Err(평문 누출 0).
fn aead_open(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if nonce.len() != NONCE_LEN {
        return Err("nonce 길이 오류".to_string());
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| "AEAD 개봉 실패(잘못된 키 또는 변조)".to_string())
}

// 값 봉인 → SealedItem(envelope). 랜덤 DEK 로 값 암호화, DEK 를 KEK 로 wrap.
pub fn seal(kek: &[u8; KEY_LEN], value: &[u8]) -> Result<SealedItem, String> {
    let mut dek = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut dek);
    let val_nonce = random_nonce();
    let val_ct = aead_seal(&dek, &val_nonce, value)?;
    let dek_nonce = random_nonce();
    let dek_ct = aead_seal(kek, &dek_nonce, &dek)?;
    dek.zeroize(); // 평문 DEK 즉시 소거
    Ok(SealedItem {
        dek_nonce: dek_nonce.to_vec(),
        dek_ct,
        val_nonce: val_nonce.to_vec(),
        val_ct,
    })
}

// SealedItem 개봉 → 평문. KEK 로 DEK unwrap, DEK 로 값 복호. 잘못된 KEK·변조면 Err.
pub fn open(kek: &[u8; KEY_LEN], item: &SealedItem) -> Result<Vec<u8>, String> {
    let mut dek_vec = aead_open(kek, &item.dek_nonce, &item.dek_ct)?;
    if dek_vec.len() != KEY_LEN {
        dek_vec.zeroize();
        return Err("DEK 길이 오류".to_string());
    }
    let mut dek = [0u8; KEY_LEN];
    dek.copy_from_slice(&dek_vec);
    dek_vec.zeroize();
    let out = aead_open(&dek, &item.val_nonce, &item.val_ct);
    dek.zeroize();
    out
}

// ── 복구 코드(R24) — 개인키 S 를 passphrase(KEK) 외 recovery-key 로도 2중 wrap ─────────
// passphrase 분실 시에도 S 를 되찾는 독립 경로. recovery code 문자열을 Argon2id 로 RK 도출 → 기존
// seal/open(대칭 envelope)으로 S 를 wrap. blob(salt+SealedItem)은 암호문이라 평문 DB(encryption_keys)에
// 저장 안전 — recovery code 자체는 사용자만 보관(1회 표시, 영구손실 고지). 코드는 decode 안 한다(Argon2id
// 입력일 뿐) → 생성은 typeable 문자열만 만들면 된다(Crockford base32, 혼동문자 I/L/O/U 제외).

const RECOVERY_BYTES: usize = 20; // 160비트 — recovery 코드 엔트로피

// Crockford base32(0-9 A-Z, ILOU 제외) — recovery 코드용 인코딩(생성 전용, decode 불요).
fn crockford_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buffer = (buffer << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

// 새 recovery 코드 — 160비트 랜덤 → Crockford base32 → 4자 그룹 대시 구분(타이핑 친화). 1회 표시용.
pub fn gen_recovery_code() -> String {
    let mut raw = [0u8; RECOVERY_BYTES];
    OsRng.fill_bytes(&mut raw);
    let enc = crockford_base32(&raw);
    enc.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

// recovery 코드로 입력 정규화 — 대시/공백 제거 + 대문자(사용자가 소문자·구분자 섞어 입력해도 동일 RK).
fn normalize_recovery(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

// recovery 코드로 secret(S) wrap → (salt, SealedItem). Argon2id(코드)→RK, seal(RK, secret).
pub fn recovery_wrap(recovery_code: &str, secret: &[u8]) -> Result<(Vec<u8>, SealedItem), String> {
    let norm = normalize_recovery(recovery_code);
    if norm.is_empty() {
        return Err("빈 recovery 코드".to_string());
    }
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let rk = derive_kek(
        norm.as_bytes(),
        &salt,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )?;
    let item = seal(&rk, secret)?;
    Ok((salt.to_vec(), item))
}

// recovery 코드로 secret 복구 — Argon2id(코드,salt)→RK, open(RK, item). 잘못된 코드면 AEAD Err.
pub fn recovery_unwrap(
    recovery_code: &str,
    salt: &[u8],
    item: &SealedItem,
) -> Result<Vec<u8>, String> {
    let norm = normalize_recovery(recovery_code);
    let rk = derive_kek(
        norm.as_bytes(),
        salt,
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )?;
    open(&rk, item)
}

// recovery blob 직렬화 — encryption_keys.recovery 컬럼에 저장할 JSON(salt + SealedItem, 전부 b64).
#[derive(Serialize, Deserialize, Clone)]
pub struct RecoveryBlob {
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    pub sealed: SealedItem,
}

// ── 비대칭 봉투(app.data 단계②) — X25519 sealed box + AAD ──────────────────────
// 실체는 공유 크레이트 soksak-seal 로 옮겼다(soksak-ptyd 가 바이트 체크포인트 봉인에
// 같은 스킴을 쓴다 — 사본 금지). 여기서는 기존 소비자(data/crypto.rs·commands)의
// 경로를 그대로 유지하는 재수출만 남는다. AAD 컨텍스트(ns‖coll‖scope‖id‖keyId) 규약과
// 키 수명(S 는 vault 에만, P 는 encryption_keys 평문 메타)은 이 모듈·data 계층이 소유.
pub use soksak_seal::{gen_asym_keypair, open_sealed, public_from_secret, seal_to, SealedBox};

// ── device KEK 취득 seam(os_key) ──────────────────────────────────────────────
// KEK 출처를 SecretsState 밖으로 뺀 주입 슬롯 — 프로덕션은 OS 키체인(os_key), 테스트는 in-mem/failing.
// Send+Sync 라 managed SecretsState 슬롯에 Box<dyn> 로 담긴다. os_key::get_or_create_kek 은 concrete
// store 로만 호출(트레잇 오브젝트 비호환)하고, 이 seam 이 그 위에 backend 라벨·read-only 프로브를 얹는다.
pub trait KekSource: Send + Sync {
    // get-or-create — 없으면 생성(쓰기). 미도달(StoreUnavailable)은 Err 로 전파(무음 평문 폴백 0).
    fn acquire(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, KekError>;
    // read-only 도달성 프로브 — KEK 를 생성하지 않는다(부수효과 0). status 의 seal_available 판정용.
    fn reachable(&self) -> bool;
    // 진단 라벨 — status 표면. 프로덕션은 플랫폼 저장소명, 테스트는 "memory".
    fn backend(&self) -> &'static str;
}

// 플랫폼별 저장소 라벨(진단 표면 전용). os_key 백엔드 피처와 대응.
pub fn os_backend_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "keychain"
    }
    #[cfg(target_os = "windows")]
    {
        "wincred"
    }
    #[cfg(target_os = "linux")]
    {
        "secret-service"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "os-key"
    }
}

// e2e/디버그 전용 결정적 KEK — SOKSAK_E2E_KEK 가 있으면 그 값을 도메인분리 SHA-256 해싱해 32B KEK 로 쓴다.
// #[cfg(debug_assertions)] 라 release(프로덕션) 바이너리엔 이 코드가 아예 컴파일되지 않는다 — env-KEK 백도어
// 0(P1 이 제거한 SOKSAK_VAULT_KEY 를 프로덕션에 되살리지 않는다). e2e 하니스가 키체인 없이 격리·결정적·CI
// 가능한 볼트 언락을 얻는 유일 경로. env 부재면 None → KekSource 폴백(일반 dev 는 키체인 그대로).
// 자식 프로세스엔 P0 자식-env 화이트리스트가 SOKSAK_E2E_KEK 를 벗겨 새지 않는다.
#[cfg(debug_assertions)]
pub struct E2eKekSource {
    kek: [u8; KEY_LEN],
}

#[cfg(debug_assertions)]
impl E2eKekSource {
    // 값 → 32B KEK(도메인분리 SHA-256). 순수·결정적이라 env 없이 테스트 가능(set_var abort 회피).
    fn derive(value: &str) -> [u8; KEY_LEN] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"soksak-e2e-kek:v1:");
        h.update(value.as_bytes());
        let mut kek = [0u8; KEY_LEN];
        kek.copy_from_slice(&h.finalize()[..KEY_LEN]);
        kek
    }
    pub fn from_env() -> Option<Self> {
        let val = std::env::var("SOKSAK_E2E_KEK").ok()?;
        if val.is_empty() {
            return None;
        }
        Some(Self {
            kek: Self::derive(&val),
        })
    }
}

#[cfg(debug_assertions)]
impl KekSource for E2eKekSource {
    fn acquire(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, KekError> {
        Ok(Zeroizing::new(self.kek))
    }
    fn reachable(&self) -> bool {
        true
    }
    fn backend(&self) -> &'static str {
        "e2e"
    }
}

// KEK 출처의 주입 이음매 — 실 키체인을 안 만진다. 검사만의 것이 아니다: 키체인이 없는
// 프로세스(헤드리스·CI)도 볼트를 세워야 하고, 그때 이것이 그 자리를 채운다.
pub struct InMemoryKekSource {
    kek: Mutex<Option<[u8; KEY_LEN]>>,
}

impl InMemoryKekSource {
    // 빈 — 첫 acquire 에서 랜덤 32B 생성·고정(get-or-create 멱등).
    pub fn empty() -> Self {
        Self {
            kek: Mutex::new(None),
        }
    }
    // 특정 KEK 로 고정 — KEK↔vault 정합/불일치·재시작 영속 재현용.
    pub fn with_kek(kek: [u8; KEY_LEN]) -> Self {
        Self {
            kek: Mutex::new(Some(kek)),
        }
    }
}

impl KekSource for InMemoryKekSource {
    fn acquire(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, KekError> {
        let mut g = self.kek.lock().expect("kek mutex");
        if g.is_none() {
            let mut raw = [0u8; KEY_LEN];
            OsRng.fill_bytes(&mut raw);
            *g = Some(raw);
        }
        Ok(Zeroizing::new(g.expect("seeded above")))
    }
    fn reachable(&self) -> bool {
        true
    }
    fn backend(&self) -> &'static str {
        "memory"
    }
}

// no-secret-service(헤드리스 Linux/무 D-Bus/잠긴 컬렉션) 재현 — 모든 취득 Err(무음 폴백 0).
pub struct FailingKekSource;

impl KekSource for FailingKekSource {
    fn acquire(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, KekError> {
        Err(KekError::StoreUnavailable(
            "no secret service (test)".to_string(),
        ))
    }
    fn reachable(&self) -> bool {
        false
    }
    fn backend(&self) -> &'static str {
        "unavailable"
    }
}

// ── 상태(lib.rs manage) ──────────────────────────────────────────────────────

#[derive(Default)]
pub struct SecretsState {
    kek: Mutex<Option<[u8; KEY_LEN]>>, // ensure_open 성공 시 캐시, lock 시 슬롯 in-place zeroize
    vault: Mutex<Option<VaultData>>,   // 디스크 동기화(None=미로딩)
    // 볼트 파일 경로 — init(lib.rs setup) 에서 1회 설정. 미설정이면 프로덕션 경로 계산으로 폴백.
    // 테스트는 임시 path 를 직접 주입(전역 HOME 변이 0 — data/store.rs·plugins.rs 주입형 선례).
    path: Mutex<Option<PathBuf>>,
    // KEK 출처 주입 슬롯 — set_kek_source 로 1회 주입(프로덕션 KekSource, 테스트 InMemory/Failing).
    // 미주입 Default = backend 미구성 = '잠김' 등가(is_unlocked false). keyring 은 KekSource 안에서만
    // 인스턴스화 → Default 가 키체인·CoreFoundation 을 절대 안 건드린다(setenv abort 원천 차단).
    kek_source: Mutex<Option<Box<dyn KekSource>>>,
    // [R23] true 면 vault 가 있어야 한다(app.data 에 봉투 키 등록됨). 부팅 시 setup 이 설정 — vault 파일이
    // 없는데 이게 true 면 ensure_open 의 새 vault 자동생성을 거부한다(전손 차단).
    expect_vault: Mutex<bool>,
}

// 볼트 파일명 — 홈 아래 한 자리. 경로 조립은 Identity::path 가 소유한다.
const VAULT_FILE: &str = "secrets.vault";

// 볼트는 정체성의 것이다 — "이 홈의 볼트"이지 "이 프로세스의 볼트"가 아니다.
// 순수 경로 계산(mkdir 부수효과 0 — 디렉토리 생성은 쓰기 시점의 것).
pub fn vault_path(identity: &Identity) -> PathBuf {
    identity.path(VAULT_FILE)
}

// 볼트 경로 해소 — SOKSAK_VAULT_PATH 가 있으면 그 경로(헤드리스/E2E 격리용 오픈 메커니즘:
// 사용자 실볼트 비오염·실 passphrase 비종속), 없으면 정체성에서 파생.
// env 조회를 주입받아 테스트가 전역 env 변형 없이 검증한다(병렬 테스트 안전).
// identity 도 인자다 — 전역 홈을 읽으면 cored 프로세스가 자기 홈이 아닌 곳을 가리킨다.
pub fn resolve_vault_path(
    env: impl Fn(&str) -> Option<String>,
    identity: &Identity,
) -> Result<PathBuf, String> {
    match env("SOKSAK_VAULT_PATH") {
        Some(p) if !p.is_empty() => {
            let path = PathBuf::from(p);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            Ok(path)
        }
        _ => Ok(vault_path(identity)),
    }
}

// ns 검증 — 일반 namespace는 plugin id와 동형(lower/digit/hyphen). `core_registry-*`는
// 레지스트리 credential 전용 core-owned class다. `_`는 plugin id 문법에 없으므로 app.secrets의
// ownership-fixed plugin namespace가 core credential owner와 alias될 수 없다.
fn validate_ns(ns: &str) -> Result<(), String> {
    let candidate = ns.strip_prefix("core_registry-").unwrap_or(ns);
    let mut chars = candidate.chars();
    let head = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head && rest {
        Ok(())
    } else {
        Err(format!("잘못된 ns: {ns:?}"))
    }
}

// 시크릿 key 검증 — 임의 식별자(영숫자·-·_·.). 빈 문자열 거부.
fn validate_key(key: &str) -> Result<(), String> {
    // ":" 허용 — "env:<VAR>" 규약(vault_env 동적 주입, PS9)의 접두 구분자. 키는 볼트 entries 맵의
    // 키로만 쓰이고 ns:key 로 인코딩되지 않으며 aad 에 실리지 않아 안전(경로·셸 주입 면역).
    if !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ':')
    {
        Ok(())
    } else {
        Err(format!("잘못된 key: {key:?}"))
    }
}

impl SecretsState {
    // 볼트 경로 주입(부트 1회) — 값은 vault_path(&Identity) 에서 온다.
    // kek_source 와 같은 모양이다: 정체성에서 파생한 값을 seam 으로 넣는다
    // (경로 = vault_path(&id), KEK = KekSource::for_identity(&id)).
    pub fn set_path(&self, path: PathBuf) {
        *self.path.lock().expect("secrets path mutex") = Some(path);
    }

    // KEK 출처 주입 — lib.rs setup 1회(프로덕션 KekSource), 테스트 InMemory/Failing. set_path 와 동형.
    pub fn set_kek_source(&self, source: Box<dyn KekSource>) {
        *self.kek_source.lock().expect("kek_source mutex") = Some(source);
    }

    // 이 State 가 쓸 볼트 경로 — 주입된 path 뿐이다.
    // 전역 홈 폴백은 두지 않는다: 폴백은 언제나 '성공'하므로(home::soksak_home 은 init 전에도
    // ~/.soksak 을 돌려준다) 미구성 상태가 남의 홈에 볼트를 만드는 것으로 조용히 끝난다.
    // 미구성은 값이 없는 것이지 기본값이 있는 것이 아니다 — 이름을 달고 실패시킨다.
    fn vault_file(&self) -> Result<PathBuf, String> {
        self.path
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "볼트 경로 미구성 — set_path(vault_path(&identity)) 주입 필요".to_string())
    }

    // 새 볼트 헤더 생성 — verifier 를 device KEK 로 봉인. KEK 는 호출자(ensure_open)가 os_key 에서
    // 취득해 넘긴다(passphrase 인자 없음). salt/kdf/m/t/p 필드는 파일포맷 안정용으로 남기되
    // kdf="os-keychain"·salt 미사용(무회귀 극대화 — VaultHeader serde 모양 불변).
    fn new_vault(kek: &[u8; KEY_LEN]) -> Result<VaultData, String> {
        let verifier = seal(kek, VERIFIER_MARKER)?;
        let header = VaultHeader {
            version: VAULT_VERSION,
            kdf: "os-keychain".to_string(),
            m_cost: ARGON2_M_COST,
            t_cost: ARGON2_T_COST,
            p_cost: ARGON2_P_COST,
            salt: Vec::new(), // os-keychain 모드 미사용(파일포맷 안정용 잔존 필드)
            verifier,
        };
        Ok(VaultData {
            header,
            entries: BTreeMap::new(),
        })
    }

    // 주어진 경로 → VaultData. 없으면 None. (경로 주입형 — 테스트가 임시 path 를 직접 준다.)
    fn load_from_disk(path: &Path) -> Result<Option<VaultData>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read(path).map_err(|e| format!("볼트 읽기 실패: {e}"))?;
        let vault: VaultData =
            serde_json::from_slice(&raw).map_err(|e| format!("볼트 파싱 실패: {e}"))?;
        Ok(Some(vault))
    }

    // VaultData → 주어진 경로(원자적: 임시파일 쓰고 rename). 볼트는 암호문만 담는다.
    fn flush(path: &Path, vault: &VaultData) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("볼트 디렉토리 실패: {e}"))?;
        }
        let bytes = serde_json::to_vec_pretty(vault).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("vault.tmp");
        if let Some(parent) = tmp.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("볼트 디렉토리 생성 실패: {e}"))?;
        }
        std::fs::write(&tmp, &bytes).map_err(|e| format!("볼트 쓰기 실패: {e}"))?;
        // 볼트는 암호문만 담지만 로컬 사용자 전용(0600) 로 잠근다 — 그룹/타 사용자 read 차단(ipc.rs 소켓 선례).
        // rename 전 tmp 에 설정해 교체된 파일이 처음부터 0600(권한 창 없음). Windows 는 파일 퍼미션 개념 없어 no-op.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("볼트 퍼미션 설정 실패: {e}"))?;
        }
        std::fs::rename(&tmp, path).map_err(|e| format!("볼트 교체 실패: {e}"))
    }

    // 투명 언락 — KEK 를 os_key 에서 취득해 vault 를 연다(캐시). 이미 열려 있으면 no-op.
    // (1) kek_source 미주입 → Err(잠김 등가). (2) vault 파일 있으면 취득 KEK 로 verifier 개봉 검증
    // (불일치=백업이식/키체인리셋 → loud Err). (3) 파일 없고 expect_vault 면 Err(R23). (4) 파일 없고
    // 미등록이면 get-or-create KEK 로 새 vault 봉인·flush. StoreUnavailable 은 어느 분기서도 평문 폴백
    // 없이 전파 — no-secret-service 시 봉인 불가만 남고 무음 평문 저장은 존재하지 않는다.
    fn ensure_open(&self) -> Result<(), String> {
        // fast-path — 이미 캐시(KEK+vault). 재-open 디스크 I/O 회피.
        {
            let kek = self.kek.lock().map_err(|e| e.to_string())?;
            let vault = self.vault.lock().map_err(|e| e.to_string())?;
            if kek.is_some() && vault.is_some() {
                return Ok(());
            }
        }
        let path = self.vault_file()?;
        let (vault, kek) = {
            let guard = self.kek_source.lock().map_err(|e| e.to_string())?;
            let source = guard
                .as_ref()
                .ok_or("secret backend 미구성 — KEK 취득 불가(잠김)")?;
            match Self::load_from_disk(&path)? {
                Some(vault) => {
                    // vault 존재 → device KEK 취득(미도달=Err, 평문 폴백 0).
                    let kek = source.acquire().map_err(|e| e.to_string())?;
                    // verifier 개봉으로 vault↔device KEK 정합 검증. 불일치면 다른 기기 키체인으로 만든
                    // 백업 복원·키체인 리셋 신호 — loud Err(전손 footgun 차단).
                    let marker = open(&kek, &vault.header.verifier).map_err(|_| {
                        "vault↔keychain KEK 불일치 — 이 기기 키체인으로 만든 볼트가 아님(백업/키체인 복원 필요)"
                            .to_string()
                    })?;
                    if marker != VERIFIER_MARKER {
                        return Err("vault verifier 불일치 — KEK 손상".to_string());
                    }
                    (vault, kek)
                }
                None => {
                    // [R23] 파일 없는데 봉투 키가 등록됐으면(expect_vault) 자동생성 거부(전손 차단).
                    if self.expect_vault.lock().map(|g| *g).unwrap_or(false) {
                        return Err(
                            "vault 파일 부재 + 암호화 키 등록됨 — 손실/삭제 의심. 자동생성 거부(백업 복원 필요)"
                                .to_string(),
                        );
                    }
                    // 첫 실행 — device KEK get-or-create 로 새 vault 봉인·flush.
                    let kek = source.acquire().map_err(|e| e.to_string())?;
                    let vault = Self::new_vault(&kek)?;
                    Self::flush(&path, &vault)?;
                    (vault, kek)
                }
            }
        };
        // 캐시 채우기(취득 KEK 는 함수 끝에서 Zeroizing 자동 스크럽).
        *self.kek.lock().map_err(|e| e.to_string())? = Some(*kek);
        *self.vault.lock().map_err(|e| e.to_string())? = Some(vault);
        Ok(())
    }

    // [R23] 부팅 시 app.data 에 봉투 키가 있으면 setup 이 true 로 — 그럼 vault 부재 시 자동생성을 막는다.
    pub fn set_expect_vault(&self, expect: bool) {
        if let Ok(mut g) = self.expect_vault.lock() {
            *g = expect;
        }
    }

    // 투명 언락 가능 여부 — ensure_open 성공(캐시 후 저비용). 이름 유지 → pty/http/process/data 소비자
    // 배선 무변경. 주의: 첫 호출은 (미등록+파일부재) 분기서 vault 를 생성하는 부수효과가 있다 —
    // read-only 판정이 필요한 status 는 이 함수 대신 KekSource::reachable 프로브를 쓴다.
    pub fn is_unlocked(&self) -> bool {
        self.ensure_open().is_ok()
    }

    // 진단 상태 — backend 라벨·seal_available(read-only 프로브)·expect_vault·보관 keyId 목록.
    // seal_available 은 reachable 프로브라 vault 를 만들지 않는다(부수효과 0). data_key_ids 는 도달
    // 가능할 때만 조회(미도달이면 빈 목록 — ensure_open 미시도).
    pub fn status(&self) -> SecretStatus {
        let (backend, seal_available) = {
            let guard = self.kek_source.lock();
            match guard.as_ref().ok().and_then(|g| g.as_ref()) {
                Some(src) => (src.backend().to_string(), src.reachable()),
                None => ("none".to_string(), false),
            }
        };
        let expect_vault = self.expect_vault.lock().map(|g| *g).unwrap_or(false);
        let data_key_ids = if seal_available {
            self.keys(DATA_ENC_NS).unwrap_or_default()
        } else {
            Vec::new()
        };
        SecretStatus {
            backend,
            seal_available,
            expect_vault,
            data_key_ids,
        }
    }

    // KEK 사본으로 클로저 실행 — ensure_open 으로 투명 개방 후 캐시 KEK 로 f. 취득 불가면 Err.
    fn with_kek<T>(
        &self,
        f: impl FnOnce(&[u8; KEY_LEN]) -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_open()?;
        let guard = self.kek.lock().map_err(|e| e.to_string())?;
        let kek = guard.as_ref().ok_or("KEK 취득 불가(잠김)")?;
        f(kek)
    }

    // set/has/delete/keys/resolve 는 `State` 를 받지 않는다 — `&self` 만 받는다.
    // `#[tauri::command]` 는 이것들을 부르는 한 줄 위임 래퍼일 뿐이고, 그래서 같은 로직이
    // 창도 앱도 없는 프로세스에서 그대로 돈다. crate 안에서만 보인다(IPC/CLI 노출은
    // 커맨드 등록이 정하지 가시성이 정하지 않는다 — 평문 readback 차단 불변).
    pub fn set(&self, ns: &str, key: &str, value: &str) -> Result<(), String> {
        validate_ns(ns)?;
        validate_key(key)?;
        let item = self.with_kek(|kek| seal(kek, value.as_bytes()))?;
        let path = self.vault_file()?;
        let mut guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_mut().ok_or("vault locked")?;
        vault
            .entries
            .entry(ns.to_string())
            .or_default()
            .insert(key.to_string(), item);
        Self::flush(&path, vault)
    }

    pub fn has(&self, ns: &str, key: &str) -> Result<bool, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_ref().ok_or("vault locked")?;
        Ok(vault.entries.get(ns).is_some_and(|m| m.contains_key(key)))
    }

    pub fn delete(&self, ns: &str, key: &str) -> Result<bool, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let path = self.vault_file()?;
        let mut guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_mut().ok_or("vault locked")?;
        let removed = vault
            .entries
            .get_mut(ns)
            .is_some_and(|m| m.remove(key).is_some());
        if removed {
            Self::flush(&path, vault)?;
        }
        Ok(removed)
    }

    // ns·key 의 평문을 복호해 반환 — Rust 전용(get 커맨드/CLI 미노출, 평문 readback 차단 유지).
    // 유일 호출자 = process_spawn 의 secret_env 주입(자식 env 로만 흐름). 잠김=Err, 미존재=Err.
    pub fn resolve(&self, ns: &str, key: &str) -> Result<String, String> {
        validate_ns(ns)?;
        validate_key(key)?;
        let item = {
            let guard = self.vault.lock().map_err(|e| e.to_string())?;
            let vault = guard.as_ref().ok_or("vault locked")?;
            vault
                .entries
                .get(ns)
                .and_then(|m| m.get(key))
                .cloned()
                .ok_or_else(|| format!("시크릿 없음: {ns}/{key}"))?
        };
        let plain = self.with_kek(|kek| open(kek, &item))?;
        String::from_utf8(plain).map_err(|_| "시크릿 평문 UTF-8 아님".to_string())
    }

    // ns 의 key 목록만(값 아님 — 평문 readback 차단 원칙).
    pub fn keys(&self, ns: &str) -> Result<Vec<String>, String> {
        validate_ns(ns)?;
        if !self.is_unlocked() {
            return Err("vault locked".to_string());
        }
        let guard = self.vault.lock().map_err(|e| e.to_string())?;
        let vault = guard.as_ref().ok_or("vault locked")?;
        Ok(vault
            .entries
            .get(ns)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default())
    }
}

// 테스트 전용 헬퍼 — 다른 모듈(process.rs)의 secret_env 주입 테스트가 임시 볼트를 세팅할 때 쓴다.
// 프로덕션 경로는 unlock/set 이 private 이므로 IPC/CLI 로만 진입(평문 readback 차단 불변).
/// 검사용 생성자 — 비밀 하나를 든 볼트 상태를 만든다. 실 키체인·파일을 안 만진다.
///
/// 피처 뒤에 둔다: 공개 API 로 두면 제품 코드가 이 길로 볼트를 세울 수 있게 되고, 그러면
/// "볼트는 파일에서 온다"는 불변이 조용히 깨진다.
#[cfg(feature = "testing")]
pub fn test_state_with_secret(
    path: PathBuf,
    _passphrase: &str,
    ns: &str,
    key: &str,
    value: &str,
) -> SecretsState {
    let s = SecretsState::default();
    s.set_path(path);
    // 투명 언락 — InMemory KEK 주입(키체인·CoreFoundation 미접촉). set 이 ensure_open 으로 vault 를
    // 그 KEK 로 봉인 생성한다(passphrase 없음). 시그니처는 process.rs/http.rs 호출부 보존 위해 유지.
    s.set_kek_source(Box::new(InMemoryKekSource::empty()));
    s.set(ns, key, value).expect("test set");
    s
}

// ── app.data 봉투 개인키 보관(단계②) ─────────────────────────────────────────
// app.data 비대칭 봉투의 개인키 S(32B)는 이 vault 에만 KEK wrap 으로 보관된다(공개키 P 는 data DB 의
// encryption_keys 평문 메타). 코어 예약 ns — 플러그인 secret.* 는 ns=pluginId 로 주입되므로 이 ns 에
// 닿지 못한다(접근제어 라벨). 봉인은 P 만 쓰므로 vault lock 중에도 가능, 개봉(S)만 unlock 필요(R12/R18).
pub const DATA_ENC_NS: &str = "core-data-enc";

impl SecretsState {
    // S(32B)를 vault 에 wrap 저장 — 암호화 활성/회전 시. unlock 필요(set 이 with_kek 게이트).
    pub fn put_data_key(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        self.set(DATA_ENC_NS, key_id, &STANDARD.encode(secret))
    }

    // keyId 의 S 를 vault 에서 unwrap. lock 이거나 미존재면 Ok(None)(복호 불가 → 읽기 경로가 게이트).
    pub fn get_data_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        if !self.is_unlocked() {
            return Ok(None);
        }
        let b64 = match self.resolve(DATA_ENC_NS, key_id) {
            Ok(v) => v,
            Err(_) => return Ok(None), // 미존재(잠김은 위에서 차단)
        };
        let raw = STANDARD.decode(b64).map_err(|e| e.to_string())?;
        if raw.len() != KEY_LEN {
            return Err("data key 길이 오류(32B 아님)".to_string());
        }
        let mut s = [0u8; KEY_LEN];
        s.copy_from_slice(&raw);
        Ok(Some(s))
    }

    // retired 키 폐기 시 S 를 vault 에서 제거(R18, count==0 검증은 data::crypto 가 선행).
    pub fn delete_data_key(&self, key_id: &str) -> Result<bool, String> {
        self.delete(DATA_ENC_NS, key_id)
    }

    // [R24] 복구 부트스트랩 — data_encrypt_recover 전용. expect_vault·verifier 가드를 우회해 이 기계 KEK 로
    // vault 를 확보하고 복구된 S 를 심는다. 복구 시나리오(키체인 분실/새 기계/폴더 sync)는 정의상 vault 가
    // 안 열리는 상태라, put_data_key 처럼 ensure_open 게이트를 타면 정확한 복구코드로도 영영 못 여는
    // deadlock 이 된다(적대검증 확인). 복구코드로 S 를 이미 손에 쥔 sanctioned 경로라 "빈 vault 자동생성"
    // footgun 이 아니다. vault 가 이미 열려 있으면(다른 scope 이미 복구) 그 vault 에 추가(기존 S 보존).
    pub fn recover_into_vault(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        if self.ensure_open().is_err() {
            // vault 를 못 연다(파일 부재+키등록, 또는 옛 KEK 봉인) — 현재 기계 KEK 취득(새 기계면
            // get-or-create). 키체인 미도달(no secret service)이면 여기서 loud Err(평문 폴백 0).
            let kek = {
                let guard = self.kek_source.lock().map_err(|e| e.to_string())?;
                let source = guard
                    .as_ref()
                    .ok_or("secret backend 미구성 — KEK 취득 불가")?;
                source.acquire().map_err(|e| e.to_string())?
            };
            // 옛 vault 가 있으나 안 열린 것(외래 KEK — 폴더 통째 sync)이면 삭제하지 않고 .superseded 로 밀어둔다.
            // 무손실 원칙 — 훗날 옛 키체인을 되찾으면 그 백업에서 복구코드 없는 plugin app.secrets 를 살릴
            // 여지를 남긴다. 최초 백업을 보존(재복구 시 이미 있으면 현재 것만 대체). 파일 부재면 no-op.
            let path = self.vault_file()?;
            if path.exists() {
                let backup = PathBuf::from(format!("{}.superseded", path.to_string_lossy()));
                if !backup.exists() {
                    std::fs::rename(&path, &backup)
                        .map_err(|e| format!("옛 vault 백업 실패: {e}"))?;
                }
            }
            // 현재 KEK 로 새 vault 강제 생성·캐시(R23 가드 우회). ensure_open 실패가 곧 기존 vault 개봉불가
            // 증거라, 대체해도 이 기계서 복구가능한 것을 잃지 않는다(옛 KEK 봉인분은 옆으로 보존됨).
            let vault = Self::new_vault(&kek)?;
            *self.kek.lock().map_err(|e| e.to_string())? = Some(*kek);
            *self.vault.lock().map_err(|e| e.to_string())? = Some(vault);
        }
        // vault open — 복구된 S 저장(put_data_key 가 캐시된 open vault 를 fast-path 로 봉인·flush).
        self.put_data_key(key_id, secret)
    }
}

// ── 내부 평문 해소(Rust 전용 — process_spawn secret_env 주입) ────────────────
// pub fn 이지만 tauri::command 아님 → IPC/CLI 비노출. 평문은 호출자(process_spawn)가
// 자식 env 로만 흘린다(JS 로 반환 0, R2). KEK 미도달=Err, 미존재=Err.
pub fn resolve(state: &SecretsState, ns: &str, key: &str) -> Result<String, String> {
    state.resolve(ns, key)
}

// vault_env 주입(PS9) — ns 의 "env:" 접두 볼트 키를 (환경변수명, 평문) 쌍으로 해소한다. "env:" 규약은
// 1판 buildSecretEnvMap 과 동형(사용자 구성 env 시크릿). 잠김/미존재/해소 실패면 그 키는 건너뛴다
// (빈 벡터 가능 — loud 실패 아님, 1판 세션-env 폴백과 동형). 평문은 호출자(스폰 env 경계)만 만진다.
pub fn env_secrets(state: &SecretsState, ns: &str) -> Vec<(String, String)> {
    let keys = match state.keys(ns) {
        Ok(k) => k,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for k in keys {
        let Some(var) = k.strip_prefix("env:") else {
            continue;
        };
        if var.is_empty() {
            continue;
        }
        if let Ok(plain) = state.resolve(ns, &k) {
            out.push((var.to_string(), plain));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0)); // 결정적 순서(테스트·재현).
    out
}

// ── Tauri 커맨드 ─────────────────────────────────────────────────────────────

// 투명 언락 상태 — backend 라벨·seal_available·expect_vault·보관 keyId 목록(secret.status).
#[derive(Serialize)]
pub struct SecretStatus {
    pub backend: String,           // KEK 저장소 라벨(미구성 "none")
    pub seal_available: bool,      // KEK 취득 가능(봉인/개봉 조건, read-only 프로브)
    pub expect_vault: bool,        // [R23] app.data 봉투 키 등록됨(vault 필수)
    pub data_key_ids: Vec<String>, // vault 에 보관된 app.data 봉투 개인키 keyId 목록
}

// 구 backend 조회(compat) — os_key 라벨 + seal_available(투명 언락에선 unlocked=seal 가능).
#[derive(Serialize)]
pub struct BackendInfo {
    pub backend: String,
    pub unlocked: bool,
}

// 투영은 값 위에 산다 — 커맨드 안에 두면 창 없는 프로세스가 같은 답을 못 만든다.
impl From<SecretStatus> for BackendInfo {
    fn from(st: SecretStatus) -> Self {
        BackendInfo {
            backend: st.backend,
            unlocked: st.seal_available,
        }
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
