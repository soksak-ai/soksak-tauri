//! cored 프로세스의 부팅 상태 — **띄운 쪽이 준 값**이지 cored 가 추측한 값이 아니다.
//!
//! 처음 판은 이 상태를 아예 두지 않고 매 호출마다 정체성을 인자로 요구했다. 근거는
//! "cored 는 자기 정체성을 추측하지 않는다"였고 그 근거 자체는 옳다. 틀린 것은 결론이다:
//! **받는 것과 추측하는 것은 다르다.** 앱도 자기 정체성을 추측하지 않는다 — 부팅 때
//! 프레임워크 설정에서 받아(`home::init(app.config().identifier)`) 전역에 세운다. cored 는 띄운 쪽의
//! 인자에서 받으면 되고, 그러면 추측은 여전히 0 이다.
//!
//! 매 호출 인자로 요구했을 때 실제로 무슨 일이 났는가(2026-07-28 라이브 실측): UI 는
//! `invoke("app_environment")` 를 인자 없이 부른다 — 앱 명령이 인자를 안 받기 때문이다.
//! 그래서 cored 가 서빙한다고 믿은 5개가 전부 INVALID_PARAMS 로 거절됐고, 그 거절은
//! 프레임워크 로그 한 줄이라 조용했다. UI 는 자기가 누구와 말하는지 모른다 — 모양이 같아야 한다.
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
    /// OS 사용자 홈(`~`) — 정체성 홈(`~/.soksak-dev`)과 **다른 값**이다. 파일 트리의 기본
    /// 뿌리이자 `~` 확장의 기준이라, 이것을 정체성 홈으로 대신하면 트리가 앱 관리 폴더
    /// 아래에서 시작한다.
    ///
    /// 정체성 홈의 부모로 파생하지 않는다. 그 관계는 배포 배치에서만 참이고(`~/.soksak*`),
    /// 격리·픽스처 배치에서는 조용히 엉뚱한 디렉터리를 가리킨다. 띄운 쪽이 아는 값이다.
    ///
    /// `Option` 인 이유: 못 받은 프로세스도 절대경로 호출은 그대로 답해야 한다. 홈이 필요한
    /// 호출만 이름을 달고 거절한다 — 못 하는 것 하나가 나머지를 막지 않는다.
    user_home: Option<PathBuf>,
    /// 이 저장소의 쓰기 소유권. 잡았으면 `Some` 이고, 그때만 쓰기 명령이 선다.
    ///
    /// 부팅 때 한 번 시도하고 결과를 지고 간다 — 호출마다 다시 잡으면 같은 프로세스가
    /// 자기 잠금과 경쟁하고, 그 사이에 남이 끼어들 틈도 생긴다. 못 잡았으면 읽기만 서빙한다:
    /// 쓰기를 조용히 성공시키는 것이 이 잠금이 막으려는 바로 그 일이다.
    write_lock: Option<WriteLock>,
    /// 띄운 쪽이 준 로그인 셸(없을 수 있다).
    login_shell: Option<String>,
    /// 이 프로세스가 서빙하는 소켓 — 띄운 쪽이 준다(`--socket`). 자기 경로를 파생하지 않는다:
    /// 파생하면 지목과 다른 자리를 자식에게 알려 준다.
    socket_path: Option<String>,
}

impl Ctx {
    /// 홈에서 파생한 기본 배치.
    pub fn new(identity: Identity) -> Self {
        let data_dir = identity.data_dir();
        Ctx {
            identity,
            data_dir,
            user_home: None,
            write_lock: None,
            login_shell: None,
            socket_path: None,
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
                // 저장소를 **만드는 것도 쓰기**다. 소유권을 잡은 이 자리에서만 형태를 세운다 —
                // 앱이 없는 홈(Electron)에서는 아무도 안 만들어 주고, 그 부재는 오류가 아니라
                // "테이블 없음"으로만 드러난다(실측: activity_publish·data_kv_* 전부 실패).
                self.ensure_schema()?;
                Ok(true)
            }
            Acquire::Taken => Ok(false),
        }
    }

    /// 저장소 기본 형태를 세운다(멱등). 문장은 코어가 소유하고 연결만 여기서 만든다.
    fn ensure_schema(&self) -> Result<(), String> {
        let conn = rusqlite::Connection::open(self.db_path())
            .map_err(|e| format!("저장소 열기 실패({}): {e}", self.db_path().display()))?;
        conn.execute_batch(soksak_core::kv::BASE_SCHEMA_SQL)
            .map_err(|e| format!("저장소 형태 세우기 실패: {e}"))
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

    /// 사용자 로그인 셸. 띄운 쪽이 값으로 준다 — `$SHELL` 은 프로세스 속성이 아니라 사용자
    /// 계정 속성이라, 이 프로세스가 자기 환경에서 읽으면 띄운 쪽의 답을 흉내내는 것이 된다.
    pub fn with_login_shell(mut self, shell: impl Into<String>) -> Self {
        self.login_shell = Some(shell.into());
        self
    }

    /// 로그인 셸 — 받지 못했으면 없다. 없는 것을 있는 척 추측하지 않는다(자기 환경을 읽는
    /// 것이 곧 그 추측이다). 셸이 필요한 명령은 사유를 달고 거절한다.
    pub fn login_shell(&self) -> Option<&str> {
        self.login_shell.as_deref()
    }

    /// OS 사용자 홈을 띄운 쪽이 알려준 경우.
    pub fn with_user_home(mut self, dir: impl Into<PathBuf>) -> Self {
        self.user_home = Some(dir.into());
        self
    }

    /// 파일 트리의 기본 뿌리. 못 받았으면 `None` — 추측하지 않는다.
    pub fn user_home(&self) -> Option<&Path> {
        self.user_home.as_deref()
    }

    /// 이 프로세스가 서빙하는 소켓 경로. 자식 셸의 `SOKSAK_SOCKET` 이 이 값이다 —
    /// 터미널 안에서 부른 `sok` 이 이 프로세스에 붙는다. 모르면 주입하지 않는다:
    /// 빈 값을 심으면 자식이 없는 소켓에 붙으려 하고, 그 실패는 터미널 안에서만 보인다.
    pub fn socket_path(&self) -> Option<&str> {
        self.socket_path.as_deref()
    }

    pub fn with_socket_path(mut self, path: impl Into<String>) -> Self {
        self.socket_path = Some(path.into());
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

    /// 사용자 홈이 **꼭 필요한** 호출을 위한 자리 — 없으면 이름을 달고 실패한다.
    ///
    /// 정체성 홈의 부모로 파생하지 않는다. `<사용자 홈>/.soksak<접미>` 라는 관계는 배포
    /// 배치에서만 참이고, 격리·픽스처에서는 엉뚱한 곳을 가리킨다 — 그리고 그 오답은 오류가
    /// 아니라 "세션 없음"·"빈 트리"로 나타나 오류로 보이지 않는다. 받지 못했으면 없는 것이다.
    pub fn require_user_home(&self) -> Result<&Path, String> {
        self.user_home().ok_or_else(|| {
            "사용자 홈을 받지 못했다 — 띄운 쪽이 --user-home 으로 넘겨야 한다(정체성 홈의 \
             부모로 때우면 격리 배치에서 다른 곳을 훑는다)"
                .to_string()
        })
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

    /// 사용자 홈은 정체성 홈과 다른 축이다 — 못 받았으면 없는 것이지 부모로 때우지 않는다.
    #[test]
    fn the_user_home_is_told_never_derived_from_the_identity_home() {
        let ctx = Ctx::new(dev());
        assert_eq!(ctx.user_home(), None, "안 받았으면 없는 것이다");
        let told = Ctx::new(dev()).with_user_home("/u/max");
        assert_eq!(told.user_home(), Some(Path::new("/u/max")));
        // 정체성 홈은 그대로다 — 두 홈은 서로를 대신하지 않는다.
        assert_eq!(told.home(), Path::new("/tmp/x-dev"));
        assert_ne!(told.user_home(), Some(told.home()));
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
