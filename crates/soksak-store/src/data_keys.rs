// app.data 암호화의 볼트 쪽 — 복구 코드 발급과 활성 키 검증.
//
// 봉인 형식과 키 표는 soksak-store(doc)가, 열쇠 유도·복구 코드는 soksak-vault 가 진다.
// 여기 남는 것은 그 둘을 잇는 두 함수뿐이고, 어느 쪽도 창을 모른다.

use rusqlite::Connection;

// 복구 코드 발급은 **볼트의 일**이라 여기 남는다 — 저장 크레이트는 "이 바이트를 이 열쇠로
// 잠근다"까지이고, 사람에게 줄 코드를 만드는 것은 그 위층이다.
// enable·rotate·change-recovery 공유 — 지정 키의 S 를 새 복구코드로 감싸 blob 을 저장하고 코드를 돌려준다.
// 키를 active 로 만든 모든 경로가 호출해야 한다: 회전이 이걸 빠뜨리면 새 active 키에 recovery 가 NULL 이라
// crate::doc::active_recovery=None → 기계·키체인 분실 시 봉인 데이터가 영구 복호불가(무손실 위반). 코드는 앱 미저장.
pub fn issue_recovery(
    conn: &Connection,
    scope: &str,
    key_id: &str,
    secret: &[u8],
) -> Result<String, String> {
    let code = soksak_vault::gen_recovery_code();
    let (salt, sealed) = soksak_vault::recovery_wrap(&code, secret)?;
    let blob = serde_json::to_string(&soksak_vault::RecoveryBlob { salt, sealed })
        .map_err(|e| e.to_string())?;
    crate::doc::set_recovery(conn, scope, key_id, &blob)?;
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
    match crate::doc::active_key(conn, scope)? {
        Some(ak) => Ok(soksak_vault::public_from_secret(secret) == ak.public_key),
        None => Ok(true),
    }
}

#[cfg(test)]
#[path = "data_keys_tests.rs"]
mod tests;
