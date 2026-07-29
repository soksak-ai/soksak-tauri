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
