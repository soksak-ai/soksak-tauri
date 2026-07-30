// OS 키체인 device KEK — **몸은 soksak-vault 가 진다.**
//
// 키체인은 플랫폼 자원이지 프레임워크 자원이 아니다. 볼트 파일은 홈에 사는데 그 열쇠가
// 프레임워크로 갈리면 파일과 열쇠가 서로 다른 축이 되고, 홈을 공유해도 둘째 껍데기는
// 그 볼트를 못 연다.
//
// 이 모듈의 이름으로 부르던 호출자가 그대로 서게 다시 내보낸다.

pub use soksak_vault::{get_or_create_kek, KekError, KekStore, OsKekSource, SecretStore};
