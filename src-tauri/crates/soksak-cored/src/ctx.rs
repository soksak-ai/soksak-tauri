//! cored 프로세스의 부팅 상태 — **띄운 쪽이 준 값**이지 cored 가 추측한 값이 아니다.
//!
//! 처음 판은 이 상태를 아예 두지 않고 매 호출마다 정체성을 인자로 요구했다. 근거는
//! "cored 는 자기 정체성을 추측하지 않는다"였고 그 근거 자체는 옳다. 틀린 것은 결론이다:
//! **받는 것과 추측하는 것은 다르다.** 앱도 자기 정체성을 추측하지 않는다 — 부팅 때 셸
//! 설정에서 받아(`home::init(app.config().identifier)`) 전역에 세운다. cored 는 띄운 쪽의
//! 인자에서 받으면 되고, 그러면 추측은 여전히 0 이다.
//!
//! 매 호출 인자로 요구했을 때 실제로 무슨 일이 났는가(2026-07-28 라이브 실측): UI 는
//! `invoke("app_environment")` 를 인자 없이 부른다 — 앱 명령이 인자를 안 받기 때문이다.
//! 그래서 cored 가 서빙한다고 믿은 5개가 전부 INVALID_PARAMS 로 거절됐고, 그 거절은 셸
//! 로그 한 줄이라 조용했다. UI 는 자기가 누구와 말하는지 모른다 — 모양이 같아야 한다.
//!
//! 그래서 규칙은 둘이다:
//!   ① 호출자가 보내는 값은 인자다(ns·key·host·port …).
//!   ② 프로세스가 갖는 값은 부팅 상태다(정체성·홈·데이터 경로).
//! 둘을 섞으면 같은 이름의 명령이 프로세스마다 다른 모양이 된다.

use std::path::{Path, PathBuf};

use soksak_core::identity::Identity;
use soksak_core::store_lock::{self, Acquire, WriteLock};

/// 이 프로세스가 서빙하는 대상. 하나의 cored 는 하나의 정체성을 서빙한다 — 여러 홈을 한
/// 프로세스가 서빙하면 "어느 홈에 물었나"가 매 호출의 인자가 되고, 그건 다시 ①/② 를
/// 섞는 일이다.
#[derive(Debug)]
pub struct Ctx {
    identity: Identity,
    /// app.data 디렉터리. 보통은 홈에서 파생되지만, 앱이 debug 빌드에서 이 자리를 옮겼다면
    /// (`SOKSAK_DATA_DIR`) **옮긴 쪽이 같은 경로를 넘겨야** 두 프로세스가 같은 DB 를 본다.
    /// cored 가 규칙만 보고 파생하면 앱과 다른 파일을 열고, 그 오답은 오류가 아니라 빈 결과다.
    data_dir: PathBuf,
    /// 이 저장소의 쓰기 소유권. 잡았으면 `Some` 이고, 그때만 쓰기 명령이 선다.
    ///
    /// 부팅 때 한 번 시도하고 결과를 지고 간다 — 호출마다 다시 잡으면 같은 프로세스가
    /// 자기 잠금과 경쟁하고, 그 사이에 남이 끼어들 틈도 생긴다. 못 잡았으면 읽기만 서빙한다:
    /// 쓰기를 조용히 성공시키는 것이 이 잠금이 막으려는 바로 그 일이다.
    write_lock: Option<WriteLock>,
}

impl Ctx {
    /// 홈에서 파생한 기본 배치.
    pub fn new(identity: Identity) -> Self {
        let data_dir = identity.data_dir();
        Ctx {
            identity,
            data_dir,
            write_lock: None,
        }
    }

    /// 저장소 쓰기 소유권을 시도한다. 부팅에서 **한 번** 부른다.
    ///
    /// 못 잡은 것은 실패가 아니다 — 그 홈의 앱이 도는 정상 상태이고, 그때 cored 는 읽기
    /// 서버로 산다. 잠금 자체를 못 만드는 것(디렉터리 부재·권한)만 오류다.
    pub fn claim_writes(&mut self) -> Result<bool, String> {
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| format!("데이터 디렉터리를 만들지 못했다({}): {e}", self.data_dir.display()))?;
        match store_lock::try_acquire(&self.data_dir)? {
            Acquire::Owned(lock) => {
                self.write_lock = Some(lock);
                Ok(true)
            }
            Acquire::Taken => Ok(false),
        }
    }

    /// 이 프로세스가 이 저장소에 써도 되는가.
    pub fn owns_writes(&self) -> bool {
        self.write_lock.is_some()
    }

    /// 데이터 디렉터리를 띄운 쪽이 지목한 경우.
    pub fn with_data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.data_dir = dir.into();
        self
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn home(&self) -> &Path {
        self.identity.home()
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// app.data 단일 파일 — 이름 규칙은 코어가 소유한다.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(soksak_core::identity::DB_FILE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev() -> Identity {
        Identity::new("/tmp/x-dev", "com.soksak.dev")
    }

    #[test]
    fn the_boot_state_derives_the_home_layout() {
        let ctx = Ctx::new(dev());
        assert_eq!(ctx.data_dir(), Path::new("/tmp/x-dev/data"));
        assert_eq!(ctx.db_path(), Path::new("/tmp/x-dev/data/soksak.db"));
        assert_eq!(ctx.identity().cli_name(), "sok-dev");
    }

    /// 앱이 DB 를 옮겼으면 cored 도 그리로 가야 한다 — 규칙만 보고 파생하면 두 프로세스가
    /// 다른 파일을 열고, 그 차이는 오류가 아니라 "없음"으로 나타난다.
    #[test]
    fn a_relocated_store_is_told_not_guessed() {
        let ctx = Ctx::new(dev()).with_data_dir("/tmp/e2e-iso");
        assert_eq!(ctx.db_path(), Path::new("/tmp/e2e-iso/soksak.db"));
        // 홈은 그대로다 — 데이터만 옮긴 것이지 정체성이 바뀐 게 아니다.
        assert_eq!(ctx.home(), Path::new("/tmp/x-dev"));
    }

    /// cored 의 홈 레이아웃은 앱의 것과 **같은 함수**에서 나온다.
    #[test]
    fn the_helper_and_the_app_read_one_layout() {
        let ctx = Ctx::new(dev());
        assert_eq!(
            ctx.identity().themes_dir(),
            soksak_core::identity::themes_dir(Path::new("/tmp/x-dev"))
        );
        assert_eq!(
            ctx.identity().plugins_dir(),
            soksak_core::identity::plugins_dir(Path::new("/tmp/x-dev"))
        );
    }
}
