//! 이 프로세스의 볼트 — 봉인 개인키가 사는 곳.
//!
//! 볼트는 홈에 사는 파일 하나와 OS 키체인의 KEK 하나다. 둘 다 **플랫폼** 자원이라 어느
//! 프로세스든 세울 수 있고, 저장소를 소유한 쪽이 함께 지는 것이 맞다 — 봉인 레코드를 읽고
//! 쓰는 것이 그 쪽이기 때문이다.
//!
//! **정직한 한계**: macOS 키체인 항목의 접근 권한은 바이너리 단위(ACL)다. 앱과 이 프로세스는
//! 다른 실행물이라, 같은 항목을 처음 읽을 때 OS 가 거절하는 것이 아니라 **사용자에게 묻는다**.
//! 그 물음을 한 번으로 만들려면 키체인을 만지는 실행물을 하나로 못박아야 하고, 그것은 배포가
//! 정할 일이다. 여기서는 못 얻으면 이름을 달고 거절한다 — 조용히 새 KEK 를 만들면 옛 KEK 로
//! wrap 된 볼트가 영구 복호불가가 된다.

use crate::ctx::Ctx;

/// 이 프로세스의 볼트 하나. 둘을 두면 같은 파일을 두 상태가 만지고, 그 둘은 서로를 모른다.
fn state() -> &'static soksak_vault::SecretsState {
    static V: std::sync::OnceLock<soksak_vault::SecretsState> = std::sync::OnceLock::new();
    V.get_or_init(soksak_vault::SecretsState::default)
}

/// 부팅 1회 — 경로와 KEK 출처를 확정한다. 두 번째 설치는 무시된다(볼트는 하나다).
///
/// 경로도 출처도 **정체성에서** 온다. 이 프로세스가 자기 환경에서 캐면 자기를 띄운 쪽의
/// 환경을 사용자의 것인 양 읽고, 그 오답은 오류가 아니라 남의 홈에 만들어진 빈 볼트다.
pub fn install(ctx: &Ctx) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let identity = ctx.identity();
        match soksak_vault::resolve_vault_path(|k| std::env::var(k).ok(), identity) {
            Ok(p) => state().set_path(p),
            // 경로 미해소면 볼트는 미구성으로 남는다 — 이후 봉인 연산이 이름을 달고 실패한다
            // (전역 홈 폴백 없음 = 남의 홈에 볼트를 만들지 않는다).
            Err(e) => eprintln!("[cored] 볼트 경로 계산 실패: {e}"),
        }
        state().set_kek_source(Box::new(soksak_vault::OsKekSource::for_identity(identity)));
    });
}

/// 봉인 열쇠 보관소 — 규칙(soksak_store::encryption)이 계약으로 받는 그 모양.
pub struct VaultKeys;

impl soksak_store::encryption::DataKeys for VaultKeys {
    fn is_unlocked(&self) -> bool {
        state().is_unlocked()
    }
    fn put_data_key(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        state().put_data_key(key_id, secret)
    }
    fn get_data_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        state().get_data_key(key_id)
    }
    fn delete_data_key(&self, key_id: &str) -> Result<(), String> {
        state().delete_data_key(key_id).map(|_| ())
    }
    fn recover_into_vault(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        state().recover_into_vault(key_id, secret)
    }
}

/// 시크릿 표면 — 볼트를 그대로 연다. 봉인 열쇠와 같은 볼트다.
pub fn secrets() -> &'static soksak_vault::SecretsState {
    state()
}

/// [R23] 봉투 키가 등록돼 있으면 볼트가 있어야 한다 — 부재 시 자동생성을 거부한다(전손 차단).
/// 저장소가 열린 뒤에만 답할 수 있어 부팅과 분리한다.
pub fn expect_vault_from_store(ctx: &Ctx) {
    let _ = ctx.with_db(|c| {
        state().set_expect_vault(soksak_store::doc::has_any_keys(c).unwrap_or(false));
        Ok(())
    });
}
