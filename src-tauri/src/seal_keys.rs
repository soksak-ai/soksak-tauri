// 봉인 열쇠의 **이 프레임워크 구현** — 계약은 코어가 소유한다(soksak_core::seal_keys).
//
// 벤더 타입에 코어 트레이트를 직접 달 수 없다(고아 규칙). 얇은 껍질만 두른다 — 껍질은
// 볼트에 위임만 하고 정책을 갖지 않는다.
//
// 열쇠 바이트는 이 자리를 지나가지만 **머무르지 않는다**: 만들자마자 볼트에 넣고 이름만
// 돌려준다. 여기에 캐시를 두면 그 캐시가 로그·패닉 메시지·코어덤프로 새는 자리가 된다.

use soksak_core::seal_keys::SealKeys;

/// 이 앱의 볼트 — `SecretsState` 를 그대로 쓴다.
pub(crate) struct VaultKeys<'a>(pub &'a crate::secrets::SecretsState);

impl SealKeys for VaultKeys<'_> {
    fn unlocked(&self) -> bool {
        self.0.is_unlocked()
    }

    fn new_key(&self) -> Option<(String, Vec<u8>)> {
        let (secret, public) = crate::secrets::gen_asym_keypair();
        let key_id = format!("ptyk-{}", uuid::Uuid::new_v4());
        if let Err(e) = self.0.put_data_key(&key_id, &secret) {
            // 보관 실패는 "열쇠 없음"이다 — 보관되지 않은 열쇠로 봉인하면 다음 실행이 못 연다.
            eprintln!("[pty] seal key store failed: {e}");
            return None;
        }
        Some((key_id, public.to_vec()))
    }

    fn secret(&self, key_id: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.get_data_key(key_id)?.map(|k| k.to_vec()))
    }
}
