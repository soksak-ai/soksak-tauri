//! 저장소 쓰기 소유권 — "이 홈의 app.data 에 쓰는 프로세스는 하나다"를 **증명**한다.
//!
//! 지금까지 단일 쓰기자는 코드 배치로만 보장됐다: 앱 프로세스 안에 커넥션이 하나뿐이고
//! `Mutex` 가 그것을 직렬화하므로 `unchecked_transaction` 이 안전하다는 논증이다. 그 논증은
//! **프로세스가 하나일 때만** 성립한다. 두 번째 프로세스가 같은 파일을 열면 SQLite 는 그것을
//! 막지 않고 직렬화해 줄 뿐이라, 앱이 기대는 전제가 조용히 사라진다.
//!
//! 그래서 전제를 값으로 만든다. 쓰려는 프로세스는 먼저 이 잠금을 잡고, 못 잡으면 **쓰지
//! 않는다**. 잠금은 커널이 파일 서술자에 거는 권고 잠금이라 프로세스가 죽으면 자동으로
//! 풀린다 — PID 파일 방식이 늘 겪는 유령 잠금이 원리적으로 없다.
//!
//! 읽기는 잠그지 않는다. SQLite WAL 은 읽기 동시·쓰기 단일이고, 이 잠금이 지키려는 것은
//! 쓰기 하나뿐이다. 읽기까지 막으면 cored 가 앱이 도는 홈을 관측조차 못 한다.

use std::fs::File;
use std::path::{Path, PathBuf};

/// 잠금 파일 이름 — 저장소 옆에 산다. DB 파일 자체를 잠그지 않는 이유: SQLite 가 그 서술자를
/// 자기 규칙으로 다루고, 우리 권고 잠금과 섞이면 어느 쪽 규칙이 이겼는지 알 수 없게 된다.
pub const LOCK_FILE: &str = "soksak.db.writelock";

/// 이 데이터 디렉터리의 잠금 파일 경로.
pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCK_FILE)
}

/// 쓰기 소유권. 살아 있는 동안 이 프로세스가 이 저장소의 유일한 쓰기자다.
///
/// 드롭되면 풀린다. 일부러 `File` 을 들고 있다 — 서술자가 곧 잠금이라 이 값을 버리는 것이
/// 곧 소유권을 놓는 것이고, 그 대응이 타입에 드러나야 한다.
#[derive(Debug)]
pub struct WriteLock {
    _file: File,
    path: PathBuf,
}

impl WriteLock {
    /// 잠금 파일 경로 — 진단이 "누가 무엇을 쥐었나"를 말할 수 있어야 한다.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// 잠금 시도 결과. **거절과 고장을 가른다** — 남이 쥐고 있는 것(정상 동작)과 잠금 자체를
/// 못 만드는 것(디렉터리 부재·권한)은 부르는 쪽이 다르게 다뤄야 한다.
#[derive(Debug)]
pub enum Acquire {
    /// 이 프로세스가 쓰기 소유자다.
    Owned(WriteLock),
    /// 다른 프로세스가 쥐고 있다. 쓰지 마라 — 읽기는 해도 된다.
    Taken,
}

/// 쓰기 소유권을 시도한다. 기다리지 않는다: 기다리면 부팅이 남의 수명에 묶인다.
pub fn try_acquire(data_dir: &Path) -> Result<Acquire, String> {
    let path = lock_path(data_dir);
    // 잠금 파일은 만들어도 된다 — 내용이 없고, 존재 자체는 아무 뜻도 아니다(뜻은 잠금에 있다).
    let file = File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("쓰기 잠금 파일을 열지 못했다({}): {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(Acquire::Owned(WriteLock { _file: file, path })),
        Err(e) if is_would_block(&e) => Ok(Acquire::Taken),
        Err(e) => Err(format!("쓰기 잠금 시도 실패({}): {e}", path.display())),
    }
}

/// "남이 쥐고 있다"의 판정. std 는 이 경우를 전용 오류 종류로 준다 — 문자열을 보지 않는다.
fn is_would_block(e: &std::fs::TryLockError) -> bool {
    matches!(e, std::fs::TryLockError::WouldBlock)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"))
            .join(".soksak-core-test")
            .join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("픽스처");
        d
    }

    #[test]
    fn the_first_process_owns_the_writes() {
        let d = dir("lock-first");
        let got = try_acquire(&d).expect("잠금 시도");
        assert!(matches!(got, Acquire::Owned(_)), "{got:?}");
    }

    /// 같은 프로세스가 두 번 잡는 것은 **다른 서술자**라 두 번째가 거절돼야 한다.
    /// (권고 잠금은 서술자 단위다 — 프로세스 단위가 아니다.)
    #[test]
    fn a_second_holder_is_told_not_silently_allowed() {
        let d = dir("lock-second");
        let first = try_acquire(&d).expect("첫 시도");
        assert!(matches!(first, Acquire::Owned(_)));
        let second = try_acquire(&d).expect("둘째 시도");
        assert!(
            matches!(second, Acquire::Taken),
            "두 번째가 통과하면 이 잠금은 아무것도 지키지 않는다: {second:?}"
        );
    }

    /// 놓으면 다음 사람이 잡는다 — 프로세스가 죽어도 같은 일이 커널에서 일어난다.
    #[test]
    fn releasing_lets_the_next_process_in() {
        let d = dir("lock-release");
        {
            let held = try_acquire(&d).expect("첫 시도");
            assert!(matches!(held, Acquire::Owned(_)));
        }
        let again = try_acquire(&d).expect("둘째 시도");
        assert!(matches!(again, Acquire::Owned(_)), "놓았는데 못 잡았다: {again:?}");
    }

    /// 남이 쥔 것과 잠금을 못 만드는 것은 다른 사실이다 — 하나로 뭉치면 부르는 쪽이
    /// "쓰지 마라"와 "환경이 깨졌다"를 구분하지 못한다.
    #[test]
    fn a_broken_environment_is_not_reported_as_taken() {
        let why = try_acquire(std::path::Path::new("/nonexistent-xyz/data")).unwrap_err();
        assert!(why.contains("쓰기 잠금"), "{why}");
    }

    #[test]
    fn the_lock_sits_next_to_the_store_not_on_it() {
        let p = lock_path(std::path::Path::new("/tmp/x/data"));
        assert_eq!(p, Path::new("/tmp/x/data/soksak.db.writelock"));
        assert_ne!(p.file_name().unwrap(), crate::identity::DB_FILE);
    }
}
