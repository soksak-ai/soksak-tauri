// 키 표와 복구 코드의 검사 — 규칙은 data_keys.rs 가, 그 증명은 여기가 진다.
//
// 회전이 복구 코드 발급을 빠뜨리면 새 active 키에 recovery 가 NULL 이 되고, 기계·키체인을
// 잃는 순간 봉인 데이터가 영구 복호불가다. 그 무손실을 여기서 지킨다.
use super::*;
use base64::Engine;
use serde_json::{json, Value};
use soksak_vault::gen_asym_keypair;

fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::store::init_base(&conn).unwrap();
    conn
}

fn sample() -> Value {
    json!({
        "id": "rec-1",
        "viewId": "term-7",        // 인덱스(평문 유지)
        "startTs": 1718900000000i64, // 인덱스(평문 유지)
        "commandLine": "export TOKEN=sk-abcd1234", // 봉인(자격증명)
        "output": "secret echo line\nrow2",        // 봉인
        "exitCode": 0,             // 봉인
        "nested": { "a": 1, "b": [true, null, "x"] } // 봉인(lossless 검증)
    })
}
fn idx() -> Vec<String> {
    vec!["viewId".to_string(), "startTs".to_string()]
}

// (c-a, blocker① 단위) crate::doc::seal_doc 결과: 인덱스 필드 + id 는 평문 top-level, 민감 필드는 부재.
#[test]
fn sealed_keeps_index_plaintext_hides_payload() {
    let (_s, p) = gen_asym_keypair();
    let aad = crate::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
    let sealed = crate::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
    let o = sealed.as_object().unwrap();
    // 평문 유지(json_extract query 가 타는 필드).
    assert_eq!(o.get("id").unwrap(), "rec-1");
    assert_eq!(o.get("viewId").unwrap(), "term-7");
    assert_eq!(o.get("startTs").unwrap(), 1718900000000i64);
    // 민감 필드는 top-level 에 평문으로 없어야(봉인됨).
    assert!(o.get("commandLine").is_none(), "commandLine 평문 노출 0");
    assert!(o.get("output").is_none(), "output 평문 노출 0");
    assert!(o.get("__enc").is_some(), "__enc 봉투 존재");
    // 직렬화 전체 문자열에도 비밀 평문 부재(blob 안에만).
    let s = serde_json::to_string(&sealed).unwrap();
    assert!(!s.contains("sk-abcd1234"), "자격증명 평문 누출 0");
    assert!(!s.contains("secret echo"), "output 평문 누출 0");
}

// (c-b) seal→open roundtrip — 원본 doc 전 필드·타입 복원(lossless, R22 중첩 객체·배열·null·bool·number).
#[test]
fn seal_open_roundtrip_lossless() {
    let (s, p) = gen_asym_keypair();
    let aad = crate::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
    let sealed = crate::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
    let opened = crate::doc::open_doc(&sealed, &s, &aad).unwrap();
    assert_eq!(
        opened,
        sample(),
        "개봉 doc 는 원본과 완전 동일(타입·값 보존)"
    );
}

// (c-c, R11) AAD 불일치(scope 변조) → open Err. 봉인을 타 scope 행으로 옮겨도 개봉 불가.
#[test]
fn cross_scope_move_rejected() {
    let (s, p) = gen_asym_keypair();
    let aad_a = crate::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
    let aad_b = crate::doc::canonical_aad("terminal", "command_blocks", "proj-b", "rec-1", "key-1");
    let sealed = crate::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad_a).unwrap();
    assert!(
        crate::doc::open_doc(&sealed, &s, &aad_b).is_err(),
        "타 scope AAD 로 개봉 거부"
    );
    assert!(crate::doc::open_doc(&sealed, &s, &aad_a).is_ok(), "정합 AAD 는 성공");
}

// (c-d) 봉투가 keyId 를 자기기술(__enc.k) + 예약 필드 충돌 거부.
#[test]
fn key_id_and_reserved_field() {
    let (_s, p) = gen_asym_keypair();
    let aad = crate::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-9");
    let sealed = crate::doc::seal_doc(&sample(), &idx(), &p, "key-9", &aad).unwrap();
    assert_eq!(
        sealed.get(crate::doc::ENC_FIELD).unwrap().get("k").unwrap(),
        "key-9",
        "봉투가 keyId 자기기술"
    );
    // doc 가 이미 __enc 를 담으면 거부(봉투 자리 충돌).
    let bad = json!({ "id": "x", "__enc": 1 });
    assert!(crate::doc::seal_doc(&bad, &[], &p, "key-9", &aad).is_err());
}

// (k-a, fail-closed) crate::doc::active_key — 키 없으면 None, 등록 후 Some(P 라운드트립).
#[test]
fn active_key_trigger() {
    let c = mem();
    assert!(
        crate::doc::active_key(&c, "proj-a").unwrap().is_none(),
        "키 없으면 트리거 0"
    );
    let (_s, p) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
    let ak = crate::doc::active_key(&c, "proj-a").unwrap().unwrap();
    assert_eq!(ak.key_id, "key-1");
    assert_eq!(ak.public_key, p, "저장 P 가 b64 라운드트립으로 복원");
    // 다른 scope 는 독립(트리거 0).
    assert!(crate::doc::active_key(&c, "proj-b").unwrap().is_none());
}

// (k-b) 회전 — 새 active 등록 시 옛 active→retired, scope 당 active 1개 불변.
#[test]
fn rotation_retires_old() {
    let c = mem();
    let (_s1, p1) = gen_asym_keypair();
    let (_s2, p2) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
    crate::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap();
    let ak = crate::doc::active_key(&c, "proj-a").unwrap().unwrap();
    assert_eq!(ak.key_id, "key-2", "최신 키가 active");
    assert_eq!(ak.public_key, p2);
    // active 는 정확히 1개.
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM encryption_keys WHERE scope='proj-a' AND status='active'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "scope 당 active 1개 불변");
}

// (k-e, R24/B10) recovery blob 저장/조회 + 코드로 S 복구 — passphrase 분실 시 독립 복구 경로.
#[test]
fn recovery_blob_store_and_recover() {
    use soksak_vault::{
        gen_recovery_code, public_from_secret, recovery_unwrap, recovery_wrap, RecoveryBlob,
    };
    let c = mem();
    let (s, p) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
    // enable 흐름 모의 — recovery code 로 S wrap → blob 저장.
    let code = gen_recovery_code();
    let (salt, sealed) = recovery_wrap(&code, &s).unwrap();
    let blob_json = serde_json::to_string(&RecoveryBlob { salt, sealed }).unwrap();
    crate::doc::set_recovery(&c, "proj-a", "key-1", &blob_json).unwrap();
    // crate::doc::active_recovery 로 조회.
    let got = crate::doc::active_recovery(&c, "proj-a").unwrap().unwrap();
    let blob: RecoveryBlob = serde_json::from_str(&got).unwrap();
    // 코드로 S 복구 → 등록 P 와 일치(무결성).
    let recovered = recovery_unwrap(&code, &blob.salt, &blob.sealed).unwrap();
    assert_eq!(recovered, s.to_vec(), "코드로 S 복구");
    let mut rs = [0u8; 32];
    rs.copy_from_slice(&recovered);
    assert_eq!(public_from_secret(&rs), p, "복구된 S 가 등록 P 와 일치");
    // recovery 없는 scope → None.
    assert!(crate::doc::active_recovery(&c, "proj-z").unwrap().is_none());
}

// (k-f, R24) 회전-복구 무손실 — 새 키를 active 로 올린 뒤 issue_recovery 를 부르지 않으면 crate::doc::active_recovery
// 가 None(옛 키 blob 은 retired 라 안 잡힘) → 기계 분실 시 영구 손실. issue_recovery 후엔 새 코드로 새 S
// 복구가 가능해야 한다. 회전이 recovery 재발급을 빠뜨리는 회귀를 이 테스트가 잡는다.
#[test]
fn rotation_reissues_recovery_or_loses_data() {
    use soksak_vault::{public_from_secret, recovery_unwrap, RecoveryBlob};
    let c = mem();
    let (s1, p1) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
    let code1 = issue_recovery(&c, "proj-a", "key-1", &s1).unwrap();
    // 회전 — 새 키를 active 로(옛 키 retired). 이 시점엔 새 키 recovery 미발급.
    let (s2, p2) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap();
    // RED 조건: recovery 재발급 전엔 active(key-2) 의 blob 이 없어 복구 경로가 죽는다.
    assert!(
        crate::doc::active_recovery(&c, "proj-a").unwrap().is_none(),
        "재발급 전엔 새 active 키에 recovery blob 이 없다(손실 위험)"
    );
    // GREEN: 회전 경로가 반드시 부르는 issue_recovery — 새 코드로 새 S 복구.
    let code2 = issue_recovery(&c, "proj-a", "key-2", &s2).unwrap();
    assert_ne!(code1, code2, "회전마다 새 복구코드");
    let got = crate::doc::active_recovery(&c, "proj-a").unwrap().unwrap();
    let blob: RecoveryBlob = serde_json::from_str(&got).unwrap();
    let recovered = recovery_unwrap(&code2, &blob.salt, &blob.sealed).unwrap();
    assert_eq!(recovered, s2.to_vec(), "회전 후 새 코드로 새 active S 복구");
    let mut rs = [0u8; 32];
    rs.copy_from_slice(&recovered);
    assert_eq!(public_from_secret(&rs), p2, "복구된 S 가 새 active P 와 일치");
    // 옛 코드로는 새 blob 이 안 열린다(무결성).
    assert!(
        recovery_unwrap(&code1, &blob.salt, &blob.sealed).is_err(),
        "옛 복구코드로는 새 blob 개봉 불가"
    );
}

// (k-d, blocker④) 키스왑 탐지 — publicKey 를 공격자 P 로 변조하면 verify_active_key 가 false.
#[test]
fn key_swap_detected() {
    let c = mem();
    let (s, p) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
    assert!(
        verify_active_key(&c, "proj-a", &s).unwrap(),
        "정상 키페어는 검증 통과"
    );
    // 공격자가 테이블의 publicKey 를 자기 P 로 스왑.
    let (_s_atk, p_atk) = gen_asym_keypair();
    c.execute(
        "UPDATE encryption_keys SET publicKey=?1 WHERE scope='proj-a' AND keyId='key-1'",
        [base64::engine::general_purpose::STANDARD.encode(p_atk)],
    )
    .unwrap();
    assert!(
        !verify_active_key(&c, "proj-a", &s).unwrap(),
        "스왑된 P 는 우리 S 와 불일치 → 탐지"
    );
    // 키 없는 scope 는 검증 대상 아님(true).
    assert!(verify_active_key(&c, "proj-z", &s).unwrap());
}

// (k-c, R18) retired 폐기 가드 — 그 키로 봉인된 enc=1 레코드가 있으면 폐기 거부, 0 이면 성공.
#[test]
fn dispose_blocked_until_zero() {
    let c = mem();
    let (_s1, p1) = gen_asym_keypair();
    let (_s2, p2) = gen_asym_keypair();
    crate::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
    // key-1 로 봉인된 레코드 1개 직접 주입.
    c.execute(
        "INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc,keyId) \
         VALUES('terminal','command_blocks','proj-a','r1','{}',1,1,1,'key-1')",
        [],
    )
    .unwrap();
    crate::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap(); // key-1 retired
    assert_eq!(crate::doc::count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 1);
    assert!(
        crate::doc::dispose_retired_key(&c, "proj-a", "key-1").is_err(),
        "잔존 레코드 → 폐기 거부"
    );
    // 레코드를 key-2 로 재봉인(변환)했다고 가정 → key-1 잔존 0.
    c.execute("UPDATE records SET keyId='key-2' WHERE id='r1'", [])
        .unwrap();
    assert_eq!(crate::doc::count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 0);
    assert!(
        crate::doc::dispose_retired_key(&c, "proj-a", "key-1").is_ok(),
        "잔존 0 → 폐기 성공"
    );
    // 폐기 후 메타에서 사라짐.
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM encryption_keys WHERE keyId='key-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}
