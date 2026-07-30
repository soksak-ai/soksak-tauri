//! 파일 하나를 고쳐 쓰는 동안의 **프로세스 간** 잠금.
//!
//! 프로세스 안의 `Mutex` 는 프로세스 둘을 못 막는다. 각자 자기 Mutex 를 잡고 서로를 못 보므로,
//! 겹친 read-modify-write 가 남의 선언을 지운 채로 **성공을 답한다**. 그 손실은 오류로 보이지
//! 않는다 — 파일은 멀쩡하고 내용만 뒤로 돌아간다.
//!
//! 커널 권고 잠금이라 프로세스가 죽으면 자동으로 풀린다(PID 파일이 늘 겪는 유령 잠금이 없다).
//! 저장소 쓰기 소유권(store_lock)과 같은 원리이고, 다른 점은 **기다린다**는 것뿐이다:
//! 저장소 소유권은 "못 잡으면 위임"이지만, 설정 한 벌을 고치는 일은 짧고 양보할 대상이 없다.

use std::fs::File;
use std::path::{Path, PathBuf};

/// 잠금 파일 경로 — 대상 옆에 `<이름>.lock` 으로 산다. 대상 파일 자체를 잠그지 않는다:
/// 그 서술자는 read-modify-write 가 열고 닫으므로 잠금 수명과 어긋난다.
pub fn lock_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".lock");
    target.with_file_name(name)
}

/// 잠금을 쥔 동안 살아 있는 값. 드롭되면 풀린다 — 서술자가 곧 잠금이라 이 값을 버리는 것이
/// 곧 놓는 것이다.
pub struct Guard {
    _file: File,
}

/// 대상 파일을 고치는 동안 잡는다. 남이 쥐고 있으면 **기다린다**.
///
/// 기다리는 이유: 이 잠금이 지키는 것은 짧은 read-modify-write 하나다. 못 잡았다고 돌아서면
/// 부른 쪽은 "왜 안 됐는지" 모르는 실패를 받고, 그 실패는 재시도 말고는 할 일이 없다.
pub fn acquire(target: &Path) -> Result<Guard, String> {
    let path = lock_path(target);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("잠금 디렉터리를 못 만들었다: {e}"))?;
    }
    let file = File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("잠금 파일을 열지 못했다({}): {e}", path.display()))?;
    file.lock()
        .map_err(|e| format!("잠금 실패({}): {e}", path.display()))?;
    Ok(Guard { _file: file })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_lives_next_to_its_target() {
        assert_eq!(
            lock_path(Path::new("/h/development-units.json")),
            PathBuf::from("/h/development-units.json.lock")
        );
    }

    /// 같은 프로세스 안에서도 겹치지 않는다 — 파일 잠금은 서술자 단위라, 두 번째 열기는
    /// 첫 번째가 놓을 때까지 기다린다.
    #[test]
    fn a_second_holder_waits_for_the_first() {
        let dir = std::env::temp_dir().join(format!("soksak-filelock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("units.json");

        let held = acquire(&target).expect("첫 잠금");
        let (tx, rx) = std::sync::mpsc::channel();
        let t = {
            let target = target.clone();
            std::thread::spawn(move || {
                let _g = acquire(&target).expect("둘째 잠금");
                let _ = tx.send(());
            })
        };
        // 첫 잠금을 쥔 동안에는 둘째가 못 든다 — 신호가 오지 않는다.
        assert!(
            rx.try_recv().is_err(),
            "첫 잠금을 쥔 동안 둘째가 들어왔다"
        );
        drop(held);
        t.join().expect("둘째 스레드");
        rx.recv().expect("놓으면 둘째가 든다");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
