// 파일 읽기·쓰기 표면. 로직은 soksak-core 이 소유한다 — 여기 남는 것은 앰비언트에서
// 값으로 건너오는 한 지점(홈)과 Tauri 노출뿐이다.
//
// 홈이 **둘**이라는 것이 이 파일의 요점이다. 파일 트리의 뿌리와 `~` 확장이 보는 것은 OS
// 사용자 홈(`~`)이고, 앱이 만든 프로젝트 폴더가 사는 곳은 정체성 홈(`~/.soksak-dev`)이다.
// 둘을 한 이름으로 부르면 트리가 정체성 홈 아래에서 시작한다.

use std::path::PathBuf;

pub use soksak_core::fsx::{ChildListing, FileData, TextData};

// OS 사용자 홈 — 정체성 홈이 아니다. 이 프로세스의 환경에서 읽는 유일한 지점이고,
// 그 아래로는 값이 흐른다(코어는 이 값을 인자로 받는다).
fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

#[tauri::command]
pub fn read_text_file(path: String, offset: Option<u64>) -> Result<TextData, String> {
    soksak_core::fsx::read_text_file(&path, offset, Some(&home_dir()))
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<FileData, String> {
    soksak_core::fsx::read_file_base64(&path)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    soksak_core::fsx::write_text_file(&path, &content)
}

/// base64 이진 쓰기 — read_file_base64 의 대칭. 몸은 코어가 진다.
#[tauri::command]
pub fn write_file_base64(path: String, base64: String) -> Result<serde_json::Value, String> {
    let bytes = soksak_core::fsx::write_file_base64(&path, &base64)?;
    Ok(serde_json::json!({ "path": path, "bytes": bytes }))
}

#[tauri::command]
pub fn list_children(path: Option<String>, meta: Option<bool>) -> Result<ChildListing, String> {
    soksak_core::fsx::list_children(path.as_deref(), meta, Some(&home_dir()))
}

#[tauri::command]
pub fn ensure_project_dir(folder: String) -> Result<String, String> {
    soksak_core::fsx::ensure_project_dir(&folder, &crate::identity::ambient())
}

#[tauri::command]
pub fn validate_project_root(path: String) -> Result<String, String> {
    soksak_core::fsx::validate_project_root(&path, Some(&home_dir()))
}

#[cfg(test)]
mod write_tests {
    use super::*;

    // 래퍼가 실제로 디스크까지 닿는지 — 코어 단위 검사와 별개로 이 배선을 본다.
    #[test]
    fn write_text_file_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("soksak-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("edit.txt");
        let fp = f.to_string_lossy().to_string();

        write_text_file(fp.clone(), "first\nedit".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "first\nedit");

        // 재저장(편집 후 ⌘S 재호출 시나리오) → 이전 내용 완전 대체.
        write_text_file(fp, "replaced".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "replaced");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // 사용자 홈과 정체성 홈은 다른 값이다 — 트리의 기본 뿌리가 정체성 홈으로 미끄러지면
    // 사용자는 자기 파일 대신 앱 관리 폴더를 본다.
    #[test]
    fn the_tree_root_is_the_user_home_not_the_identity_home() {
        let listed = list_children(None, None).expect("사용자 홈 나열");
        let identity_home = crate::identity::ambient().home().to_string_lossy().to_string();
        assert_ne!(listed.root, identity_home, "트리가 정체성 홈에서 시작했다");
    }
}

// ── 외부 테마(플러그인 모델) ─────────────────────────────────────────────────
// 테마는 외부에서 만들어져 <정체성 홈>/themes/*.json 으로 들어온다. 검증은 프론트
// 테마 엔진(단일 진실)이 담당 — 여기는 파일 입출력만.

fn themes_dir() -> PathBuf {
    crate::identity::ambient().themes_dir()
}

pub use soksak_core::themes::ThemeFile;

// 외부 테마 디렉토리의 *.json 전부(내용 포함). 훑기는 soksak-core 이 소유한다 —
// 여기서는 홈에서 디렉토리를 해소하는 일만 한다. 읽기는 디스크를 만들지 않는다.
#[tauri::command]
pub fn themes_scan() -> Result<Vec<ThemeFile>, String> {
    soksak_core::themes::scan(&themes_dir())
}

// 테마 파일 설치(외부 경로 → <정체성 홈>/themes/). 동명 파일은 덮어쓴다(갱신).
// 검증·복사·목적지 생성은 soksak-core 이 소유한다 — cored 도 같은 규칙으로 설치한다.
#[tauri::command]
pub fn theme_install(path: String) -> Result<String, String> {
    soksak_core::themes::install(&themes_dir(), &path)
}
