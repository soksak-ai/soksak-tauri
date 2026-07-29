//! 문서 봉인 — 레코드 하나를 잠그고 여는 규칙.
//!
//! 저장 연산과 **같은 크레이트**에 산다: 봉인 형식이 두 벌이면 한쪽이 쓴 레코드를 다른 쪽이
//! 못 열고, 그 실패는 오류가 아니라 **빈 결과**로 나타난다.
//!
//! 볼트(마스터 키·복구 코드·키체인)는 여기 없다. 그것은 프로세스가 지는 자원이고, 여기 있는
//! 것은 "이 바이트를 이 열쇠로 잠근다"뿐이다.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use rusqlite::{Connection, OptionalExtension};
use soksak_seal::SealedBox;

// 현재 봉투 알고리즘 식별자 — 미래 마이그레이션 분기용(헤더에 기록).
pub const ALGO_V1: &str = "x25519-hkdf-sha256-xchacha20poly1305-v1";

// 새 keyId — "k-" + 9 랜덤바이트 base64url(검증 통과 문자만: A-Za-z0-9-_). vault key·테이블 PK 양쪽 안전.
pub fn new_key_id() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use rand::RngCore;
    let mut b = [0u8; 9];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("k-{}", URL_SAFE_NO_PAD.encode(b))
}

// 봉인된 나머지 페이로드가 담기는 예약 필드. 평문 doc 에 이 키가 있으면 충돌이므로 호출자가 거부해야.
pub const ENC_FIELD: &str = "__enc";

// AAD canonical — 봉인 컨텍스트 바인딩. enc 표식 "1" 고정(평문은 봉인 안 함). 구분자 '|' 는
// 필드값에 등장 가능하나 ns/coll/scope/id/keyId 는 검증된 식별자(영숫자·-·_·.)라 '|' 미포함 → 모호성 0.
pub fn canonical_aad(ns: &str, coll: &str, scope: &str, id: &str, key_id: &str) -> Vec<u8> {
    format!("{ns}|{coll}|{scope}|{id}|{key_id}|1").into_bytes()
}

// doc 를 (평문 top-level: id ∪ plaintext_fields) + (봉인 나머지)로 분할해 공개키 P 로 봉인.
// plaintext_fields = 선언된 인덱스 필드(query 가능 유지). 반환 = 저장할 Value(enc=1 형태).
pub fn seal_doc(
    doc: &Value,
    plaintext_fields: &[String],
    recipient_pk: &[u8; 32],
    key_id: &str,
    aad: &[u8],
) -> Result<Value, String> {
    let obj = doc.as_object().ok_or("doc 는 객체여야 함")?;
    if obj.contains_key(ENC_FIELD) {
        return Err(format!("doc 가 예약 필드 {ENC_FIELD} 를 포함함"));
    }
    let mut public = Map::new();
    let mut sealed_part = Map::new();
    for (k, v) in obj {
        if k == "id" || plaintext_fields.iter().any(|f| f == k) {
            public.insert(k.clone(), v.clone()); // 평문 유지(query·order)
        } else {
            sealed_part.insert(k.clone(), v.clone()); // 봉인 대상
        }
    }
    let payload = serde_json::to_vec(&Value::Object(sealed_part)).map_err(|e| e.to_string())?;
    let boxed = soksak_seal::seal_to(recipient_pk, &payload, aad)?;
    public.insert(ENC_FIELD.to_string(), json!({ "k": key_id, "b": boxed }));
    Ok(Value::Object(public))
}

// 봉인 doc 개봉 → 원본 doc 복원. 개인키 S 로 __enc 개봉 후 평문 top-level 과 병합(__enc 제거).
// aad 불일치·변조·잘못된 키 → Err(평문 누출 0).
pub fn open_doc(stored: &Value, secret: &[u8; 32], aad: &[u8]) -> Result<Value, String> {
    let obj = stored.as_object().ok_or("저장 doc 는 객체여야 함")?;
    let enc = obj.get(ENC_FIELD).ok_or("__enc 필드 없음(평문 레코드?)")?;
    let boxed: SealedBox = serde_json::from_value(enc.get("b").cloned().ok_or("__enc.b 없음")?)
        .map_err(|e| e.to_string())?;
    let payload = soksak_seal::open_sealed(secret, &boxed, aad)?;
    let sealed_part: Value = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    let mut out = Map::new();
    for (k, v) in obj {
        if k != ENC_FIELD {
            out.insert(k.clone(), v.clone()); // 평문 top-level(id+인덱스)
        }
    }
    if let Value::Object(sp) = sealed_part {
        for (k, v) in sp {
            out.insert(k, v); // 봉인 페이로드 병합
        }
    }
    Ok(Value::Object(out))
}

// ── encryption_keys — scope 별 봉투 키 메타(R18) ─────────────────────────────
// 공개키 P 만 여기(평문 — 공개값). 개인키 S 는 vault 에만(KEK wrap, commands 레벨). status='active'
// 행의 존재 자체가 **암호화 트리거**다(fail-closed, blocker high) — 별도 enable 불리언 없음.
// 회전 = 새 active 추가 + 옛 active→retired. retired 폐기는 그 키로 봉인된 enc=1 레코드 0일 때만(R18).

#[derive(Debug, Clone, PartialEq)]
pub struct ActiveKey {
    pub key_id: String,
    pub public_key: [u8; 32],
}

// 부팅 시 1회 — 테이블 + active 부분 인덱스. init_base 에서 호출(멱등). recovery = R24 복구 blob(암호문,

// 평문 저장 안전 — recovery code 로만 열림). 기존 DB(recovery 컬럼 없는)는 멱등 ALTER 로 추가.
pub fn init_keys_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS encryption_keys (\
            scope TEXT NOT NULL, keyId TEXT NOT NULL,\
            publicKey TEXT NOT NULL, algo TEXT NOT NULL,\
            status TEXT NOT NULL, created INTEGER NOT NULL,\
            recovery TEXT,\
            PRIMARY KEY(scope, keyId)\
         );\
         CREATE INDEX IF NOT EXISTS encryption_keys_active ON encryption_keys(scope) WHERE status='active';",
    )
    .map_err(|e| e.to_string())?;
    // [R24] 기존 DB(recovery 컬럼 부재) 멱등 마이그레이션.
    let has_recovery: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('encryption_keys') WHERE name='recovery'")
        .map_err(|e| e.to_string())?
        .exists([])
        .map_err(|e| e.to_string())?;
    if !has_recovery {
        conn.execute_batch("ALTER TABLE encryption_keys ADD COLUMN recovery TEXT;")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// [R24] 키 행에 recovery blob 저장(JSON 문자열). enable 시 keypair 생성 직후 1회.
pub fn set_recovery(
    conn: &Connection,
    scope: &str,
    key_id: &str,
    recovery_json: &str,
) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE encryption_keys SET recovery=?3 WHERE scope=?1 AND keyId=?2",
            (scope, key_id, recovery_json),
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("키 {key_id} 없음 — recovery 저장 실패"));
    }
    Ok(())
}


// [R24] active 키의 recovery blob 조회 — 복구 흐름이 읽는다. 없으면 None.
pub fn active_recovery(conn: &Connection, scope: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT recovery FROM encryption_keys WHERE scope=?1 AND status='active'",
        [scope],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|o| o.flatten())
}

fn decode_pk(b64: &str) -> Result<[u8; 32], String> {
    let raw = STANDARD
        .decode(b64)
        .map_err(|e| format!("publicKey b64: {e}"))?;
    if raw.len() != 32 {
        return Err("publicKey 길이 오류(32B 아님)".to_string());
    }
    let mut p = [0u8; 32];
    p.copy_from_slice(&raw);
    Ok(p)
}

// [R23] 이 DB 에 봉투 키가 하나라도 등록됐는가 — 등록됐다면 그 개인키 S 가 vault 에 있어야 한다(과거
// vault 존재 증거). 부팅 시 이게 true 인데 vault 파일이 없으면(삭제·손실) secrets 가 새 vault 자동생성을
// 거부한다 — 임의 passphrase 가 통과해 봉인 레코드가 영구 복호불가가 되는 footgun 차단(prevention).
pub fn has_any_keys(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM encryption_keys)", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n != 0)
    .map_err(|e| e.to_string())
}

// 특정 키로 봉인된(enc=1) 레코드 수 — retired 키 폐기 가드(R18: 0 일 때만 폐기 안전).
pub fn count_sealed_with_key(conn: &Connection, scope: &str, key_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM records WHERE scope=?1 AND keyId=?2 AND enc=1",
        (scope, key_id),
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// scope 의 active 키 — Some 이면 이 scope 의 put 은 반드시 봉인해야(fail-closed 트리거).
pub fn active_key(conn: &Connection, scope: &str) -> Result<Option<ActiveKey>, String> {
    let row = conn
        .query_row(
            "SELECT keyId, publicKey FROM encryption_keys WHERE scope=?1 AND status='active'",
            [scope],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some((key_id, pk_b64)) => Ok(Some(ActiveKey {
            key_id,
            public_key: decode_pk(&pk_b64)?,
        })),
        None => Ok(None),
    }
}

// 새 active 키 등록 — 기존 active 가 있으면 retired 로 내리고(단일 트랜잭션) 새 active 삽입(회전 포함).
// publicKey 는 호출자가 S 로부터 public_from_secret 으로 만든 P(검증된 페어). created=now.
pub fn register_active_key(
    conn: &Connection,
    scope: &str,
    key_id: &str,
    public_key: &[u8; 32],
    created: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE encryption_keys SET status='retired' WHERE scope=?1 AND status='active'",
        [scope],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO encryption_keys(scope,keyId,publicKey,algo,status,created) \
         VALUES(?1,?2,?3,?4,'active',?5)",
        (scope, key_id, STANDARD.encode(public_key), ALGO_V1, created),
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// retired 키 폐기 — 그 키로 봉인된 enc=1 레코드가 0 일 때만(아니면 Err, 영구손실 차단). vault 의 S 삭제는
/// 호출자(commands)가 이 성공 직후 동일 흐름에서 수행한다.
pub fn dispose_retired_key(conn: &Connection, scope: &str, key_id: &str) -> Result<(), String> {
    let remaining = count_sealed_with_key(conn, scope, key_id)?;
    if remaining != 0 {
        return Err(format!(
            "키 {key_id} 로 봉인된 레코드 {remaining}개 잔존 — 폐기 거부(R18)"
        ));
    }
    conn.execute(
        "DELETE FROM encryption_keys WHERE scope=?1 AND keyId=?2 AND status='retired'",
        (scope, key_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
