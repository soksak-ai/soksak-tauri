// 볼트의 프레임워크 자리에 대한 검사 — 몸의 증명은 soksak-vault 가 진다.
//
// 여기서 재는 것은 이 프레임워크가 지고 있는 것뿐이다: KEK 를 어디서 얻는가.
// 생성만으로는 키체인에 닿지 않는다(keyring::Entry 는 read/write 에서만 만들어진다).
use super::*;
use crate::identity::Identity;

// KEK 서비스명도 정체성에서 온다 — 전역 identifier 를 읽으면 cored 가 남의 KEK 를 연다.
// 생성만으로는 키체인에 닿지 않는다(keyring::Entry 는 read/write 에서만 만들어진다).
#[test]
fn the_kek_service_name_comes_from_the_identity() {
    let dev = OsKekSource::for_identity(&Identity::new("<local-evidence>/x-dev", "com.soksak.dev"));
    let debug = OsKekSource::for_identity(&Identity::new("<local-evidence>/x-debug", "com.soksak.debug"));
    assert_eq!(dev.service(), "com.soksak.dev");
    assert_ne!(dev.service(), debug.service(), "정체성이 KEK 를 가른다");
}
