// app.data 에서 **이 프로세스의 몫** — 저장소가 어디 있고, 이 프로세스가 그 연결을 어떻게 쥐는가.
//
// 저장소의 규칙(여는 절차·스키마·질의·백업 링)은 soksak_store 가 소유한다. 규칙이 여기 살던
// 시절은 앱이 유일한 백엔드이던 시절이고, 지금은 같은 홈을 앱과 cored 가 함께 본다 — 규칙이
// 두 벌이면 같은 파일을 둘이 다르게 열고 그 차이는 오류가 아니라 데이터의 성질로 나타난다.
//
// 여기 남는 것은 프로세스의 것뿐이다: 앰비언트 홈에서 파생한 DB 경로와, 그 연결 하나를 쥔 상태.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

pub mod commands;
mod process_probe;
pub mod ring;
// 저장 연산의 재수출은 두지 않는다. `crate::data::store` 라는 이름은 저장소 규칙이 이 폴더에
// 사는 것처럼 읽히게 하고, 이름을 감춘 결합은 게이트만이 아니라 읽는 사람도 속인다.
// 부르는 쪽이 `soksak_store::store` 를 직접 부른다.

// 단일 쓰기 커넥션(Mutex). SQLite WAL 은 읽기 동시·쓰기 단일 — 이 한 커넥션을 직렬화한다.
// 부팅 setup 에서 개방 결과를 채운다(소켓 서버 기동 이전). 연결은 프로세스의 자원이라
// 규칙 쪽으로 못 간다 — 규칙은 `&Connection` 을 받고, 그 연결을 쥐는 것은 여기다.
#[derive(Default)]
pub struct DbState {
    pub conn: Mutex<Option<Connection>>,
}

impl DbState {
    pub fn set(&self, conn: Connection) {
        *self.conn.lock().unwrap() = Some(conn);
    }
}

// ~/.soksak/data/soksak.db — 단일 파일(백업=파일 복사/VACUUM INTO).
// SOKSAK_DATA_DIR 오버라이드(debug 빌드 전용): 있으면 DB(+WAL/SHM/FTS)가 이 디렉토리에 산다. e2e·도구가
// 홈의 설치본 플러그인·사이드카는 그대로 쓰면서 DB 만 disposable temp 로 격리하는 오픈-테스트 메커니즘
// (SOKSAK_VAULT_PATH 의 DB 대칭, home.rs SOKSAK_HOME 과 동형 debug-gate). DB 위치를 옮기는 env 는 새
// 프로덕션 표면이라 release 엔 이 분기를 컴파일하지 않는다.
fn data_dir_from(data_dir_env: Option<&str>, home: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = data_dir_env.filter(|s| !s.is_empty()) {
        return PathBuf::from(d);
    }
    #[cfg(not(debug_assertions))]
    let _ = data_dir_env;
    // 규약 경로는 코어가 소유한다 — 여기서 이름을 다시 적으면 cored 와 갈릴 수 있다.
    soksak_core::identity::data_dir(home)
}

/// 주어진 홈 아래의 DB 경로. 홈은 **인자로 온다** — cored 프로세스는 자기 홈을 전역으로
/// 알 수 없고, 잘못 파생된 홈은 거부가 아니라 **다른 identity 의 DB 를 여는 것**으로 끝난다.
pub fn db_path_in(home: &Path) -> Result<PathBuf, String> {
    let dir = data_dir_from(std::env::var("SOKSAK_DATA_DIR").ok().as_deref(), home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(soksak_core::identity::DB_FILE))
}

/// 이 프로세스의 홈 기준 DB 경로 — 앰비언트를 읽는 것은 여기 한 곳이다.
pub fn db_path() -> Result<PathBuf, String> {
    db_path_in(crate::identity::ambient().home())
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;

/// 이 홈의 저장소를 **누가 여는가.**
///
/// 앱과 cored 가 같은 홈에서 각자 DB 를 열면 쓰기자가 둘이 된다. SQLite 는 막지 않고
/// 직렬화만 한다 — `soksak_core::store_lock` 이 시끄럽게 만들려던 바로 그 조용한 경우다.
///
/// 그래서 부팅에서 소유권을 잡아 보고, 그 결과가 이 값이다. 못 잡은 것은 **실패가 아니다** —
/// 이미 그 홈의 주인이 있다는 사실이고, 그때는 그쪽에 물어 답한다. 실패로 다루면 두 번째
/// 프레임워크가 저장소를 통째로 못 쓰고, 그것이 "동시에 켠다"가 막히던 자리다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreOwner {
    /// 이 프로세스가 쓰기 소유권을 잡았다 — 자기 커넥션으로 답한다.
    Local,
    /// 남이 주인이다(그 홈의 cored). 그쪽에 물어 답한다.
    Remote,
}

impl StoreOwner {
    /// 부팅의 소유권 시도 결과에서 온다.
    pub fn from_claim(owned: bool) -> Self {
        if owned {
            StoreOwner::Local
        } else {
            StoreOwner::Remote
        }
    }

    /// 남에게 넘기는가.
    pub fn delegates(self) -> bool {
        matches!(self, StoreOwner::Remote)
    }

    /// 오류인가 — **아니다.** 이 물음을 남겨 두는 이유는, 못 잡은 것을 오류로 읽는 것이
    /// 이 설계에서 가장 하기 쉬운 실수이기 때문이다.
    pub fn is_error(self) -> bool {
        false
    }
}

/// 이 홈의 저장소 쓰기 소유권을 잡아 본다.
///
/// 잡은 잠금은 **프로세스가 사는 동안** 들고 있어야 한다 — 떨어뜨리면 그 순간 남이 잡고
/// 둘이 함께 쓰게 된다. 그래서 여기 붙잡아 둔다(커널이 fd 로 들고 있으므로 프로세스가 죽으면
/// 저절로 풀린다 — 죽은 잠금을 거두는 장치가 따로 필요 없다).
pub fn claim_store(db_path: &std::path::Path) -> StoreOwner {
    static HELD: std::sync::Mutex<Option<soksak_core::store_lock::WriteLock>> =
        std::sync::Mutex::new(None);
    let Some(dir) = db_path.parent() else {
        return StoreOwner::Remote;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return StoreOwner::Remote;
    }
    match soksak_core::store_lock::try_acquire(dir) {
        Ok(soksak_core::store_lock::Acquire::Owned(lock)) => {
            *HELD.lock().unwrap_or_else(|e| e.into_inner()) = Some(lock);
            StoreOwner::Local
        }
        // 남이 들고 있다 — 정상이다. 잠금 자체를 못 만드는 경우도 여기로 온다:
        // 그때 여는 쪽을 고르면 두 쓰기자가 되므로, 모르면 넘긴다.
        _ => StoreOwner::Remote,
    }
}

/// 저장소 명령 하나가 **어디로 가는가.**
///
/// 소유권 갈래만 세우고 명령이 그대로 자기 커넥션을 보면, 위임된 프로세스는 "DB 미초기화"로
/// 전부 실패한다 — 조용히 안 되는 것보다 낫지만 여전히 못 켜는 것이다.
///
/// 그리고 "DB 미초기화"와 "남이 주인"은 **다른 사실**이다. 한 오류로 뭉치면 둘째 프레임워크의
/// 정상 상태가 결함처럼 보이고, 사람이 없는 결함을 쫓는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreRoute {
    /// 이 프로세스가 주인이다 — 자기 커넥션으로 답한다.
    OwnConnection,
    /// 남이 주인이다 — 그쪽(cored)에 물어 답한다.
    AskOwner,
}

impl StoreRoute {
    pub fn for_owner(owner: StoreOwner) -> Self {
        match owner {
            StoreOwner::Local => StoreRoute::OwnConnection,
            StoreOwner::Remote => StoreRoute::AskOwner,
        }
    }
}

/// 이 프로세스의 저장소 갈래 — 부팅의 소유권 시도가 정한다.
///
/// 커넥션이 있는가로 판정하지 않는다: 아직 안 연 것과 남이 주인인 것이 같아 보이고, 그 둘은
/// 다른 사실이다(하나는 기다리면 되고 하나는 영영 안 온다).
static ROUTE: std::sync::OnceLock<StoreRoute> = std::sync::OnceLock::new();

pub fn set_route(owner: StoreOwner) {
    let _ = ROUTE.set(StoreRoute::for_owner(owner));
}

/// 아직 안 정해졌으면 자기 커넥션이다 — 부팅 전에 부르는 자리(검사 등)의 오늘 동작을 지킨다.
pub fn route() -> StoreRoute {
    *ROUTE.get().unwrap_or(&StoreRoute::OwnConnection)
}

#[cfg(test)]
#[path = "store_owner_tests.rs"]
mod store_owner_tests;
