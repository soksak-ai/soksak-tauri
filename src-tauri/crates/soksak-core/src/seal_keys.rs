// 봉인 열쇠 계약 — 화면 체크포인트를 잠그고 여는 열쇠가 오는 **한 점**.
//
// 스트림 출구(StreamSink)·활동 원장(ActivitySink)·정체성(Identity)에 한 것과 같은 이유다.
// 지금 이 자리는 `tauri::Manager::state::<SecretsState>(app)` 이고, 그 한 줄 때문에 "봉인된
// 화면을 읽는다"는 일 전체가 앱 프로세스에 묶인다 — 열쇠가 필요한 것이지 프레임워크가
// 필요한 것이 아닌데도.
//
// 계약은 셋이다:
//   ① 지금 열쇠를 낼 수 있는가(볼트가 잠겨 있으면 못 낸다).
//   ② 새 열쇠 하나를 만들어 보관하고 그 이름과 공개키를 준다.
//   ③ 이름으로 보관된 열쇠를 돌려준다.
//
// **못 하는 것은 값으로 답한다.** 잠긴 볼트는 오류가 아니라 사실이고, 그때의 올바른 행동은
// "이번 세션은 체크포인트 없이"다. 여기서 오류로 만들면 잠금 하나가 터미널을 못 쓰게 한다.
//
// 열쇠 자체는 이 계약을 지나가지 않는다 — 봉인·해제는 열쇠를 쥔 쪽이 한다. 바이트로 꺼내
// 나르면 그 바이트가 로그·패닉 메시지·코어덤프로 샌다.

/// 봉인 열쇠 보관소. 구현은 호스트마다 하나다.
pub trait SealKeys: Send + Sync {
    /// 지금 열쇠를 다룰 수 있는가. 거짓이면 나머지를 부르지 않는다.
    fn unlocked(&self) -> bool;

    /// 새 봉인 열쇠 — `(키 이름, 공개키)`. 못 만들면 None(사유는 구현이 남긴다).
    ///
    /// 이름을 함께 주는 이유: 봉인된 화면은 나중에 **다른 실행**이 연다. 그때 어느 열쇠였는지
    /// 알 길이 이름뿐이다.
    fn new_key(&self) -> Option<(String, Vec<u8>)>;

    /// 이 이름으로 보관된 비밀키. 없으면 Ok(None) — "없음"과 "못 읽음"은 다른 사실이다.
    fn secret(&self, key_id: &str) -> Result<Option<Vec<u8>>, String>;
}

/// 열쇠가 없는 호스트 — 봉인을 다루지 않는다고 **선언**한다.
///
/// 조용한 no-op 이 아니다: `unlocked()` 가 거짓이라 부르는 쪽이 체크포인트 없이 가고, 그 길은
/// 이미 있는 길이다(볼트 잠김과 같다). 없는 것을 있는 척하면 봉인되지 않은 화면이 봉인된
/// 것으로 기록된다.
pub struct NoSealKeys;

impl SealKeys for NoSealKeys {
    fn unlocked(&self) -> bool {
        false
    }
    fn new_key(&self) -> Option<(String, Vec<u8>)> {
        None
    }
    fn secret(&self, _key_id: &str) -> Result<Option<Vec<u8>>, String> {
        Err("이 프로세스에는 봉인 열쇠 보관소가 없습니다".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 계약만 구현한 보관소 — 프레임워크 없이 봉인 경로를 검증할 수 있어야 한다.
    #[derive(Default)]
    struct Vault {
        keys: Mutex<Vec<(String, Vec<u8>)>>,
        locked: bool,
    }

    impl SealKeys for Vault {
        fn unlocked(&self) -> bool {
            !self.locked
        }
        fn new_key(&self) -> Option<(String, Vec<u8>)> {
            if self.locked {
                return None;
            }
            let mut k = self.keys.lock().unwrap();
            let id = format!("ptyk-{}", k.len() + 1);
            k.push((id.clone(), vec![7, 7, 7]));
            Some((id, vec![1, 2, 3]))
        }
        fn secret(&self, key_id: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .keys
                .lock()
                .unwrap()
                .iter()
                .find(|(id, _)| id == key_id)
                .map(|(_, s)| s.clone()))
        }
    }

    #[test]
    fn a_store_needs_no_framework_type() {
        let v = Vault::default();
        assert!(v.unlocked());
        let (id, pk) = v.new_key().expect("열쇠");
        assert!(id.starts_with("ptyk-"));
        assert_eq!(pk, vec![1, 2, 3]);
        assert_eq!(v.secret(&id).unwrap(), Some(vec![7, 7, 7]));
    }

    /// 없는 이름은 오류가 아니다 — "없음"과 "못 읽음"이 같은 답이면 부르는 쪽이 가를 수 없다.
    #[test]
    fn an_unknown_key_is_absence_not_failure() {
        let v = Vault::default();
        assert_eq!(v.secret("ptyk-none").unwrap(), None);
    }

    /// 잠긴 볼트는 오류가 아니라 사실이다 — 오류로 만들면 잠금 하나가 터미널을 못 쓰게 한다.
    #[test]
    fn a_locked_vault_says_so_instead_of_failing() {
        let v = Vault { locked: true, ..Default::default() };
        assert!(!v.unlocked());
        assert!(v.new_key().is_none());
    }

    /// 열쇠 없는 호스트는 **선언한다**. 있는 척하면 봉인 안 된 화면이 봉인된 것으로 기록된다.
    #[test]
    fn a_host_without_keys_declares_it() {
        let n = NoSealKeys;
        assert!(!n.unlocked());
        assert!(n.new_key().is_none());
        assert!(n.secret("x").is_err());
    }

    /// 이름이 매번 달라야 두 세션의 봉인이 서로를 덮지 않는다.
    #[test]
    fn each_key_gets_its_own_name() {
        let v = Vault::default();
        let (a, _) = v.new_key().unwrap();
        let (b, _) = v.new_key().unwrap();
        assert_ne!(a, b);
    }
}
