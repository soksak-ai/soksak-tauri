// app.data 암호화(단계②) — 인덱스 인지 doc 분할 봉인. blocker① 해소의 핵심:
// query 는 `json_extract(doc, '$.field')` 표현식 인덱스로 필터한다(store.rs). doc 전체를 봉인하면
// json_extract 가 NULL → 0 행(헤드라인 비동작). 그래서 **선언된 인덱스 필드 + id 는 평문 top-level 로
// 남기고**(query·order 가 그대로 탄다), 나머지 민감 페이로드만 X25519 SealedBox 로 봉인한다.
//
// 저장 형태(enc=1): { id, <인덱스필드들>, __enc: { k: keyId, b: SealedBox } }
//   - 평문: id ∪ 인덱스필드 — 저자가 query 가능하라고 선언한 비밀 아닌 필드(R6/R19).
//   - 봉인: 그 외 전부(output/commandLine/cwd…) — whole-doc 보안에서 인덱스만 뺀 것(R19).
// FTS 가 봉인 필드를 가리키면 암호화 scope 에선 색인 불가(자격증명 평문 노출 금지, R19) — 호출자가 무력화.
//
// AAD = canonical(ns|coll|scope|id|keyId|enc) 를 inner AEAD 에 바인딩 → 재배치/replay/교차-scope 이동 거부(R11).
// 봉인은 공개키 P 만 쓴다(개인키 불요) → vault lock 중에도 at-rest 쓰기 가능(단계③ auto-lock 의 전제).

use base64::Engine;
use rusqlite::Connection;
use serde_json::{json, Value};

// 복구 코드 발급은 **볼트의 일**이라 여기 남는다 — 저장 크레이트는 "이 바이트를 이 열쇠로
// 잠근다"까지이고, 사람에게 줄 코드를 만드는 것은 그 위층이다.
// enable·rotate·change-recovery 공유 — 지정 키의 S 를 새 복구코드로 감싸 blob 을 저장하고 코드를 돌려준다.
// 키를 active 로 만든 모든 경로가 호출해야 한다: 회전이 이걸 빠뜨리면 새 active 키에 recovery 가 NULL 이라
// soksak_store::doc::active_recovery=None → 기계·키체인 분실 시 봉인 데이터가 영구 복호불가(무손실 위반). 코드는 앱 미저장.
pub fn issue_recovery(
    conn: &Connection,
    scope: &str,
    key_id: &str,
    secret: &[u8],
) -> Result<String, String> {
    let code = crate::secrets::gen_recovery_code();
    let (salt, sealed) = crate::secrets::recovery_wrap(&code, secret)?;
    let blob = serde_json::to_string(&crate::secrets::RecoveryBlob { salt, sealed })
        .map_err(|e| e.to_string())?;
    soksak_store::doc::set_recovery(conn, scope, key_id, &blob)?;
    Ok(code)
}



// [blocker④] active key 의 publicKey P 가 vault 의 개인키 S 에서 파생됐는지 검증 — P==basepoint(S).
// 공격자가 encryption_keys.publicKey 를 자기 키로 스왑하면 byte-eq 가 깨진다 → 탐지. S 는 vault 에서
// (호출자가 unlock 후 get_data_key 로). 키 없으면 검증 대상 아님(true). 스왑 탐지 시 false.
pub fn verify_active_key(
    conn: &Connection,
    scope: &str,
    secret: &[u8; 32],
) -> Result<bool, String> {
    match soksak_store::doc::active_key(conn, scope)? {
        Some(ak) => Ok(crate::secrets::public_from_secret(secret) == ak.public_key),
        None => Ok(true),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::gen_asym_keypair;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::data::init_base(&conn).unwrap();
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

    // (c-a, blocker① 단위) soksak_store::doc::seal_doc 결과: 인덱스 필드 + id 는 평문 top-level, 민감 필드는 부재.
    #[test]
    fn sealed_keeps_index_plaintext_hides_payload() {
        let (_s, p) = gen_asym_keypair();
        let aad = soksak_store::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let sealed = soksak_store::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
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
        let aad = soksak_store::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let sealed = soksak_store::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad).unwrap();
        let opened = soksak_store::doc::open_doc(&sealed, &s, &aad).unwrap();
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
        let aad_a = soksak_store::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-1");
        let aad_b = soksak_store::doc::canonical_aad("terminal", "command_blocks", "proj-b", "rec-1", "key-1");
        let sealed = soksak_store::doc::seal_doc(&sample(), &idx(), &p, "key-1", &aad_a).unwrap();
        assert!(
            soksak_store::doc::open_doc(&sealed, &s, &aad_b).is_err(),
            "타 scope AAD 로 개봉 거부"
        );
        assert!(soksak_store::doc::open_doc(&sealed, &s, &aad_a).is_ok(), "정합 AAD 는 성공");
    }

    // (c-d) 봉투가 keyId 를 자기기술(__enc.k) + 예약 필드 충돌 거부.
    #[test]
    fn key_id_and_reserved_field() {
        let (_s, p) = gen_asym_keypair();
        let aad = soksak_store::doc::canonical_aad("terminal", "command_blocks", "proj-a", "rec-1", "key-9");
        let sealed = soksak_store::doc::seal_doc(&sample(), &idx(), &p, "key-9", &aad).unwrap();
        assert_eq!(
            sealed.get(soksak_store::doc::ENC_FIELD).unwrap().get("k").unwrap(),
            "key-9",
            "봉투가 keyId 자기기술"
        );
        // doc 가 이미 __enc 를 담으면 거부(봉투 자리 충돌).
        let bad = json!({ "id": "x", "__enc": 1 });
        assert!(soksak_store::doc::seal_doc(&bad, &[], &p, "key-9", &aad).is_err());
    }

    // (k-a, fail-closed) soksak_store::doc::active_key — 키 없으면 None, 등록 후 Some(P 라운드트립).
    #[test]
    fn active_key_trigger() {
        let c = mem();
        assert!(
            soksak_store::doc::active_key(&c, "proj-a").unwrap().is_none(),
            "키 없으면 트리거 0"
        );
        let (_s, p) = gen_asym_keypair();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        let ak = soksak_store::doc::active_key(&c, "proj-a").unwrap().unwrap();
        assert_eq!(ak.key_id, "key-1");
        assert_eq!(ak.public_key, p, "저장 P 가 b64 라운드트립으로 복원");
        // 다른 scope 는 독립(트리거 0).
        assert!(soksak_store::doc::active_key(&c, "proj-b").unwrap().is_none());
    }

    // (k-b) 회전 — 새 active 등록 시 옛 active→retired, scope 당 active 1개 불변.
    #[test]
    fn rotation_retires_old() {
        let c = mem();
        let (_s1, p1) = gen_asym_keypair();
        let (_s2, p2) = gen_asym_keypair();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap();
        let ak = soksak_store::doc::active_key(&c, "proj-a").unwrap().unwrap();
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
        use crate::secrets::{
            gen_recovery_code, public_from_secret, recovery_unwrap, recovery_wrap, RecoveryBlob,
        };
        let c = mem();
        let (s, p) = gen_asym_keypair();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
        // enable 흐름 모의 — recovery code 로 S wrap → blob 저장.
        let code = gen_recovery_code();
        let (salt, sealed) = recovery_wrap(&code, &s).unwrap();
        let blob_json = serde_json::to_string(&RecoveryBlob { salt, sealed }).unwrap();
        soksak_store::doc::set_recovery(&c, "proj-a", "key-1", &blob_json).unwrap();
        // soksak_store::doc::active_recovery 로 조회.
        let got = soksak_store::doc::active_recovery(&c, "proj-a").unwrap().unwrap();
        let blob: RecoveryBlob = serde_json::from_str(&got).unwrap();
        // 코드로 S 복구 → 등록 P 와 일치(무결성).
        let recovered = recovery_unwrap(&code, &blob.salt, &blob.sealed).unwrap();
        assert_eq!(recovered, s.to_vec(), "코드로 S 복구");
        let mut rs = [0u8; 32];
        rs.copy_from_slice(&recovered);
        assert_eq!(public_from_secret(&rs), p, "복구된 S 가 등록 P 와 일치");
        // recovery 없는 scope → None.
        assert!(soksak_store::doc::active_recovery(&c, "proj-z").unwrap().is_none());
    }

    // (k-f, R24) 회전-복구 무손실 — 새 키를 active 로 올린 뒤 issue_recovery 를 부르지 않으면 soksak_store::doc::active_recovery
    // 가 None(옛 키 blob 은 retired 라 안 잡힘) → 기계 분실 시 영구 손실. issue_recovery 후엔 새 코드로 새 S
    // 복구가 가능해야 한다. 회전이 recovery 재발급을 빠뜨리는 회귀를 이 테스트가 잡는다.
    #[test]
    fn rotation_reissues_recovery_or_loses_data() {
        use crate::secrets::{public_from_secret, recovery_unwrap, RecoveryBlob};
        let c = mem();
        let (s1, p1) = gen_asym_keypair();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
        let code1 = issue_recovery(&c, "proj-a", "key-1", &s1).unwrap();
        // 회전 — 새 키를 active 로(옛 키 retired). 이 시점엔 새 키 recovery 미발급.
        let (s2, p2) = gen_asym_keypair();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap();
        // RED 조건: recovery 재발급 전엔 active(key-2) 의 blob 이 없어 복구 경로가 죽는다.
        assert!(
            soksak_store::doc::active_recovery(&c, "proj-a").unwrap().is_none(),
            "재발급 전엔 새 active 키에 recovery blob 이 없다(손실 위험)"
        );
        // GREEN: 회전 경로가 반드시 부르는 issue_recovery — 새 코드로 새 S 복구.
        let code2 = issue_recovery(&c, "proj-a", "key-2", &s2).unwrap();
        assert_ne!(code1, code2, "회전마다 새 복구코드");
        let got = soksak_store::doc::active_recovery(&c, "proj-a").unwrap().unwrap();
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
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p, 100).unwrap();
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
        soksak_store::doc::register_active_key(&c, "proj-a", "key-1", &p1, 100).unwrap();
        // key-1 로 봉인된 레코드 1개 직접 주입.
        c.execute(
            "INSERT INTO records(ns,coll,scope,id,doc,created,updated,enc,keyId) \
             VALUES('terminal','command_blocks','proj-a','r1','{}',1,1,1,'key-1')",
            [],
        )
        .unwrap();
        soksak_store::doc::register_active_key(&c, "proj-a", "key-2", &p2, 200).unwrap(); // key-1 retired
        assert_eq!(soksak_store::doc::count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 1);
        assert!(
            soksak_store::doc::dispose_retired_key(&c, "proj-a", "key-1").is_err(),
            "잔존 레코드 → 폐기 거부"
        );
        // 레코드를 key-2 로 재봉인(변환)했다고 가정 → key-1 잔존 0.
        c.execute("UPDATE records SET keyId='key-2' WHERE id='r1'", [])
            .unwrap();
        assert_eq!(soksak_store::doc::count_sealed_with_key(&c, "proj-a", "key-1").unwrap(), 0);
        assert!(
            soksak_store::doc::dispose_retired_key(&c, "proj-a", "key-1").is_ok(),
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
}
