//! scope 봉인의 규칙 — 활성·복구·회전·복구코드 변경·변환·상태.
//!
//! 열쇠를 다루는 순서가 곧 안전핀이다: S 를 보관한 **뒤에만** P 를 등록한다(P 만 있고 S 가
//! 없으면 그 뒤 모든 쓰기가 봉인되는데 영원히 못 연다). 그 순서를 껍데기에 두면 저장소를
//! 서빙하는 프로세스마다 다른 순서를 갖게 되고, 그 차이는 오류가 아니라 **영구 손실**이다.
//!
//! 열쇠 보관소는 계약으로 받는다 — 어느 프로세스가 답하든 규칙은 하나여야 한다.

use serde::{Deserialize, Serialize};

use soksak_core::kv::validate_ns;
use soksak_seal::{gen_asym_keypair, public_from_secret};
use soksak_vault::{recovery_unwrap, RecoveryBlob};

use crate::{data_keys, doc, store};

/// 봉인 개인키의 보관소. 구현은 호스트마다 하나다 — 바이트가 이 계약을 지나지만, 그 바이트를
/// 만드는 쪽과 쓰는 쪽이 갈리면 회전이 옛 키로 돌아 전손이 난다.
pub trait DataKeys {
    /// 지금 열쇠를 다룰 수 있는가(OS 키체인 도달 여부).
    fn is_unlocked(&self) -> bool;
    fn put_data_key(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String>;
    fn get_data_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, String>;
    /// 폐기 — 그 키로 봉인된 잔여가 0 임을 확인한 뒤에만 부른다(확인 전 폐기는 영구 손실).
    fn delete_data_key(&self, key_id: &str) -> Result<(), String>;
    /// 복구 경로 — 이 기계의 KEK 를 확보해 S 를 다시 wrap 한다. 잠김 게이트를 두지 않는다:
    /// 복구 시나리오는 정의상 볼트가 안 열리는 상태다.
    fn recover_into_vault(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String>;
}

#[derive(Serialize, Deserialize)]
pub struct EncryptionStatus {
    pub enabled: bool, // scope 에 active key 존재(= 봉인 트리거 ON)
    pub key_id: Option<String>,
    pub algo: Option<String>,
    pub unlocked: bool,    // vault(개인키 S) 해제 여부 — 복호 가능 조건
    pub tampered: bool, // [blocker④] publicKey 가 vault S 와 불일치(키스왑 탐지). unlock 상태에서만 판정.
    pub key_missing: bool, // [R23] active P 있는데 vault 에 S 없음(vault 리셋/손실) — 레코드 복호 영구 불가 경고.
}

#[derive(Serialize, Deserialize)]
pub struct EnableResult {
    pub key_id: String,
    // [R24] 의무 recovery code(1회 표시). passphrase 분실 시 S 복구의 유일 경로 — 사용자가 안전 보관해야
    // 하고 분실 시 영구손실. 이후 조회 불가(blob 만 DB 에 남고 코드 원문은 어디에도 저장 안 함).
    pub recovery_code: String,
}

// scope 암호화 활성 — X25519 키페어 생성, 개인키 S 를 vault 에 wrap + recovery code 로도 2중 wrap(R24),
// 공개키 P 를 테이블에 등록. 순서가 안전핀이다: S 를 vault 에 넣은 뒤에만 P 를 등록한다 — P(=봉인 트리거)만
// 있고 S 가 없으면 이후 모든 put 이 봉인되는데 영원히 복호 불가(전손)다. vault 잠김이면 여기서 Err(P 미등록).
pub fn data_encrypt_enable(
    c: &rusqlite::Connection,
    keys: &dyn DataKeys,
    scope: String,
) -> Result<EnableResult, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    // 이미 active key 있으면 재활성 거부(중복 트리거·키 혼선 방지 — 회전은 별도 커맨드).
    if doc::active_key(c, &scope)?.is_some() {
        return Err(format!(
            "scope {scope} 는 이미 암호화 활성(회전은 rotate 커맨드)"
        ));
    }
    let (sk, pk) = gen_asym_keypair();
    let key_id = doc::new_key_id();
    // (1) S 를 vault 에 먼저 — 잠김이면 여기서 Err(P 미등록, 전손 0).
    keys.put_data_key(&key_id, &sk)?;
    // (2) P 를 테이블에 등록(봉인 트리거 ON). 실패해도 vault 의 S 는 orphan(무해 — 트리거 없음).
    let created = crate::now_millis();
    doc::register_active_key(c, &scope, &key_id, &pk, created)?;
    // (3) [R24] recovery code 발급 + S 를 코드로 2중 wrap → blob 저장(평문 DB 안전, 코드로만 열림).
    let recovery_code = data_keys::issue_recovery(c, &scope, &key_id, &sk)?;
    Ok(EnableResult {
        key_id,
        recovery_code,
    })
}

// [R24] 복구 — recovery code 로 S 를 되찾아 이 기계의 vault 에 재저장(re-wrap). device OS 키체인의 KEK 취득이
// 전제(S 를 KEK 로 다시 wrap). 복구된 S 가 등록 P 와 일치(basepoint)해야 한다 — 코드가 맞아도 P 불일치면
// 거부(무결성). 성공 시 그 scope 봉인 레코드가 이 기계에서 다시 복호 가능(다른 기계/OS 이관 경로).
pub fn data_encrypt_recover(
    c: &rusqlite::Connection,
    keys: &dyn DataKeys,
    scope: String,
    recovery_code: String,
) -> Result<(), String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    // is_unlocked 게이트를 두지 않는다 — 복구 시나리오(키체인 분실/새 기계/폴더 sync)는 정의상 vault 가
    // 안 열리는 상태다. 여기서 게이트하면 정확한 복구코드로도 영영 못 여는 deadlock(적대검증 확인). 코드
    // 검증은 vault 없이 선행하고, 저장은 recover_into_vault 가 이 기계 KEK 로 vault 를 확보해 처리한다.
    let ak = doc::active_key(c, &scope)?
        .ok_or("암호화 비활성 scope — 복구 대상 아님")?;
    let blob_json = doc::active_recovery(c, &scope)?
        .ok_or("recovery blob 없음 — 이 키는 복구 코드 미발급")?;
    let blob: RecoveryBlob =
        serde_json::from_str(&blob_json).map_err(|e| e.to_string())?;
    let s_vec = recovery_unwrap(&recovery_code, &blob.salt, &blob.sealed)
        .map_err(|_| "복구 실패 — 잘못된 recovery code".to_string())?;
    if s_vec.len() != 32 {
        return Err("복구된 키 길이 오류".to_string());
    }
    let mut s = [0u8; 32];
    s.copy_from_slice(&s_vec);
    // 무결성 — 복구된 S 가 등록 P 와 일치해야(스왑·손상 거부).
    if public_from_secret(&s) != ak.public_key {
        return Err("복구된 키가 등록 publicKey 와 불일치 — 거부".to_string());
    }
    // 이 기계 KEK 로 vault 를 확보하고 S 저장 → 봉인 레코드가 여기서 다시 열린다. KEK 미도달(no secret
    // service)이면 여기서 loud Err. 코드 검증(unwrap+P 일치)을 통과한 뒤라 잘못된 코드는 여기 못 온다.
    keys.recover_into_vault(&ak.key_id, &s)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct RotateResult {
    pub old_key_id: String,
    pub new_key_id: String,
    pub rekeyed: usize,
    pub old_disposed: bool, // old 키로 봉인된 잔여 0 이라 폐기됨(아니면 다음 회전/재개에서)
    pub recovery_code: String, // 새 키의 새 복구코드(1회 반환·앱 미저장) — 회전이 복구 blob 을 재발급해야 무손실
}

// 키 회전(R18/B9) — 새 키페어로 scope 전체를 re-key. old S 로 개봉→new P 로 재봉인. 잔여 0 확인 후에만
// old 키를 폐기한다(영구손실 0). unlock 필요(old 개봉). 중단 시 keyId=old 잔여만 다음 회전에서 이어받음.
pub fn data_encrypt_rotate(
    c: &rusqlite::Connection,
    keys: &dyn DataKeys,
    scope: String,
) -> Result<RotateResult, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    if !keys.is_unlocked() {
        return Err(
            "KEK 취득 불가(no secret service) — 회전은 device 키체인 접근 필요(old 키 개봉)".to_string(),
        );
    }
    let old = doc::active_key(c, &scope)?
        .ok_or("암호화 비활성 scope — 회전 대상 아님")?;
    let old_s = keys
        .get_data_key(&old.key_id)?
        .ok_or("old 개인키 부재 — 회전 불가(무결성 이슈)")?;
    // 변조 검증 — old P==basepoint(old S). 스왑된 키로 회전하면 옛 레코드 개봉 실패 전손 위험.
    if public_from_secret(&old_s) != old.public_key {
        return Err("old publicKey 가 vault 키와 불일치(스왑 의심) — 회전 거부".to_string());
    }
    // 새 키페어 → vault wrap → 등록(old retired, new active). 이후 새 put 은 new 로 봉인.
    let (new_s, new_p) = gen_asym_keypair();
    let new_key_id = doc::new_key_id();
    keys.put_data_key(&new_key_id, &new_s)?;
    let created = crate::now_millis();
    doc::register_active_key(c, &scope, &new_key_id, &new_p, created)?;
    // 새 active 키의 복구 blob 재발급 — 빠뜨리면 회전 후 active_recovery=None 이라 기계 분실 시 봉인 데이터
    // 영구 손실. re-key 루프 전에 발급해 new_s 가 살아있는 동안 처리. 새 코드 1회 반환(앱 미저장).
    let recovery_code =
        data_keys::issue_recovery(c, &scope, &new_key_id, &new_s)?;
    // 전 레코드 re-key(배치 반복).
    let mut rekeyed = 0usize;
    loop {
        let n = store::rekey_scope(c, &scope, &old.key_id, &old_s, &new_key_id, &new_p, 512)?;
        rekeyed += n;
        if n == 0 {
            break;
        }
    }
    // 잔여 0(전 ns/coll) 확인 후에만 old 폐기(테이블 + vault). 잔여 있으면 다음 호출이 이어받음.
    let remaining = doc::count_sealed_with_key(c, &scope, &old.key_id)?;
    let old_disposed = remaining == 0;
    if old_disposed {
        doc::dispose_retired_key(c, &scope, &old.key_id)?;
        keys.delete_data_key(&old.key_id)?;
    }
    Ok(RotateResult {
        old_key_id: old.key_id,
        new_key_id,
        rekeyed,
        old_disposed,
        recovery_code,
    })
}

// [R24] 복구코드 변경 — 데이터 재암호화 없이 active 키의 S 를 새 복구코드로 다시 감싼다(저렴). 코드 분실·노출
// 시. device OS 키체인의 KEK 취득이 전제(active S 를 vault 에서 꺼내 새 코드로 재-wrap). 새 코드 1회 반환·앱
// 미저장. rotate 와 달리 keyId·봉인 레코드는 그대로 — 복구 blob 만 새 코드로 교체.
pub fn data_encrypt_change_recovery(
    c: &rusqlite::Connection,
    keys: &dyn DataKeys,
    scope: String,
) -> Result<String, String> {
    if scope.is_empty() {
        return Err("scope 필요".to_string());
    }
    if !keys.is_unlocked() {
        return Err(
            "KEK 취득 불가(no secret service) — 복구코드 변경은 device 키체인 접근 필요(S 재-wrap)"
                .to_string(),
        );
    }
    let ak = doc::active_key(c, &scope)?
        .ok_or("암호화 비활성 scope — 복구코드 변경 대상 아님")?;
    let s = keys
        .get_data_key(&ak.key_id)?
        .ok_or("active 개인키 부재 — 복구코드 변경 불가(무결성 이슈)")?;
    // 무결성 — vault 의 S 가 등록 P 와 일치(스왑 거부).
    if public_from_secret(&s) != ak.public_key {
        return Err("active publicKey 가 vault 키와 불일치(스왑 의심) — 복구코드 변경 거부".to_string());
    }
    data_keys::issue_recovery(c, &scope, &ak.key_id, &s)
}

// 기존 평문 레코드 봉인 변환(R17) — 암호화 활성 후 이미 쌓인 (ns,coll,scope) 평문을 active key 로 봉인.
// 레코드별 단일 트랜잭션이라 크래시 재개 가능. 배치 반복으로 전부 변환, 반환=변환 수.
pub fn data_encrypt_convert(
    c: &rusqlite::Connection,
    ns: String,
    coll: String,
    scope: String,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    let mut total = 0usize;
    loop {
        // 암호화 활성 scope 에선 새 put 이 이미 봉인(enc=1)이라 enc=0 은 줄기만 한다 → n==0 = 잔여 0.
        let n = store::convert_pending(c, &ns, &coll, &scope, 512)?;
        total += n;
        if n == 0 {
            break;
        }
    }
    // convert 는 평문 doc 을 in-place 로 봉인 전환한다. secure_delete=ON 이 freed 셀을 0 채우지만,
    // 확실한 잔존 제거를 위해 실제 전환이 있었으면 (1) FTS 그림자테이블의 tombstone 트라이그램을 rebuild 로
    // purge 하고 (2) full VACUUM(freelist 째 재기록) + WAL truncate 로 전환 이전 평문이 파일-carve 로
    // 복원되는 경로를 닫는다(doc 컬럼·FTS 세그먼트 양쪽).
    if total > 0 {
        store::purge_fts_residual(c, &ns, &coll)?;
        c.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())?;
    }
    Ok(total)
}

// scope 암호화 상태 — enabled(트리거), keyId, algo, vault unlock 여부(복호 가능 조건).
pub fn data_encrypt_status(
    c: &rusqlite::Connection,
    keys: &dyn DataKeys,
    scope: String,
) -> Result<EncryptionStatus, String> {
    let ak = doc::active_key(c, &scope)?;
    let unlocked = keys.is_unlocked();
    // unlock 상태에서만 S 기반 판정. tampered=키스왑(blocker④), key_missing=S 부재(R23 footgun: vault
    // 리셋/삭제로 P 는 남고 S 가 사라진 상태 — 그 scope 의 봉인 레코드는 영구 복호 불가).
    let mut tampered = false;
    let mut key_missing = false;
    if let (Some(k), true) = (&ak, unlocked) {
        match keys.get_data_key(&k.key_id)? {
            Some(s) => tampered = !data_keys::verify_active_key(c, &scope, &s)?,
            None => key_missing = true,
        }
    }
    Ok(EncryptionStatus {
        enabled: ak.is_some(),
        key_id: ak.as_ref().map(|k| k.key_id.clone()),
        algo: ak.as_ref().map(|_| doc::ALGO_V1.to_string()),
        unlocked,
        tampered,
        key_missing,
    })
}

