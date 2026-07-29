//! 경로 확장 — 홈은 **인자로 온다**.
//!
//! `~` 확장은 홈 하나만 알면 되는 순수 계산이다. 그런데 홈을 함수 안에서 읽으면
//! 그 순간 "이 프로세스의 환경"이 답의 일부가 되고, 프로세스가 갈리면 같은 입력이 다른
//! 경로를 낸다 — 그것도 조용히. 홈을 받으면 전제가 사라진다.
//!
//! 다른 사용자의 홈(`~user`)은 지원하지 않는다. 그것을 풀려면 사용자 데이터베이스를
//! 읽어야 하고, 그건 이 프로세스가 무엇인지에 다시 의존하게 된다 — 우리는 셸이 아니다.

use std::path::{Path, PathBuf};

/// 선행 `~` 를 주어진 홈으로 확장한다. `~` 단독과 `~/...` 만 처리한다.
pub fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}


/// 프로젝트 루트로 쓸 수 있는 경로인가 — **정규화된** 경로와 홈을 받아 판정한다.
///
/// 규칙: 홈(~) 자신과 파일시스템 루트(/)는 될 수 없다. 루트 초기화 정책이 그 트리 전체를
/// 대상으로 동작하므로, 홈이나 루트를 프로젝트로 잡으면 그 정책이 사용자 전체 파일에 걸린다.
///
/// 디스크를 만지지 않는다 — 존재 확인·정규화는 호출자가 하고 여기는 **판정만** 한다.
/// 그래야 같은 규칙을 어느 프로세스에서도 같은 답으로 물을 수 있다.
pub fn project_root_verdict(canonical: &Path, home: &Path) -> Result<(), String> {
    if canonical == home {
        return Err("홈 디렉토리(~)는 프로젝트 루트가 될 수 없음".to_string());
    }
    if canonical.parent().is_none() {
        return Err("파일시스템 루트(/)는 프로젝트 루트가 될 수 없음".to_string());
    }
    Ok(())
}

/// `start` 부터 조상으로 올라가며 `name` 이라는 **실물 파일**을 가진 첫 디렉터리.
///
/// 배치를 열거하는 대신 규칙 하나로 잡는다: 개발 트리(빌드 산출물 직하), 번들
/// (`….app/Contents/MacOS` → 빌드 트리), 실행물 동봉(exe 옆) 이 전부 같은 걸음이다.
/// 배치를 목록으로 적으면 새 배치가 생길 때마다 조용히 못 찾는다.
///
/// 시작점은 **인자**다 — 여기서 실행 파일 경로를 읽으면 프로세스마다 다른 곳부터 걷는다.
/// 디렉터리(심링크 대상 포함)는 답이 아니다: 찾는 것은 실행할 파일이다.
pub fn find_dir_holding(start: &Path, name: &str, max_up: usize) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..=max_up {
        if dir.join(name).is_file() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}



/// 경로의 **어느 컴포넌트도** 심링크가 아님을 확인한다. `..` 는 그 자체로 거부다.
///
/// 마지막 컴포넌트만 보면 안 된다: 중간 디렉터리가 링크면 최종 경로는 검사한 곳과 다른 데를
/// 가리키고, 그 차이는 검사를 통과한 뒤에 생긴다. 없는 컴포넌트는 건너뛴다 — 아직 안 만든
/// 경로를 미리 검사하는 호출자가 있고, 부재는 링크가 아니다.
///
/// 코어에 사는 이유: 앱과 cored 가 같은 config·같은 소스 경로를 읽는데, 검사가 한쪽에만
/// 있으면 통과 기준이 프로세스마다 달라진다. 그 차이는 거부가 아니라 **한쪽에서만 보이는
/// 유닛**으로 나타난다(2026-07-28 실측).
/// 링크로 볼 것 — 유닉스의 심링크와 윈도우의 junction(reparse point) 둘 다.
///
/// `is_symlink()` 만 보면 junction 이 그대로 통과한다. 윈도우에서 junction 은 심링크가
/// 아닌 별개 종류라, 검사가 있는데도 링크를 지나 다른 곳을 열게 된다.
#[cfg(windows)]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub fn reject_symlink_components(path: &Path) -> Result<(), String> {
    use std::path::Component;
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(format!("경로에 '..'를 사용할 수 없습니다: {}", path.display()))
            }
            Component::Normal(part) => current.push(part),
        }
        if current.as_os_str().is_empty() {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if is_link_like(&metadata) {
            return Err(format!("심링크 경로는 허용하지 않습니다: {}", current.display()));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "pathx_tests.rs"]
mod tests;
