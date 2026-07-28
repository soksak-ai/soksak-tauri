//! 외부 테마 디렉터리 훑기 — 디렉터리는 **인자로 온다**.
//!
//! 테마는 외부에서 만들어져 홈 아래 `themes/*.json` 으로 들어온다. 검증은 프론트 테마
//! 엔진(단일 진실)이 하고 여기는 파일 입출력만 한다.
//!
//! 디렉터리를 홈에서 스스로 구하면 그 순간 "이 프로세스가 앱이다"가 답의 일부가 된다.
//! 받아 쓰면 앱이든 헬퍼든 같은 디렉터리에 같은 답을 낸다.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemeFile {
    pub file: String,
    pub content: String,
}

/// 디렉터리의 `*.json` 전부(내용 포함), 경로순.
///
/// 디렉터리를 못 읽으면 오류다. 개별 파일을 못 읽으면 그 파일만 빠진다 — 목록의 나머지는
/// 여전히 옳고, 테마 하나 때문에 전체 목록을 잃는 것이 더 나쁘다.
pub fn scan(dir: &Path) -> Result<Vec<ThemeFile>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                out.push(ThemeFile {
                    file: path.to_string_lossy().to_string(),
                    content,
                });
            }
        }
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-portable-themes-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_json_files_are_carried_and_the_order_is_by_path() {
        let dir = test_dir("basic");
        std::fs::write(dir.join("b.json"), "{\"name\":\"b\"}").unwrap();
        std::fs::write(dir.join("a.json"), "{\"name\":\"a\"}").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let found = scan(&dir).unwrap();
        assert_eq!(
            found.iter().map(|t| t.content.as_str()).collect::<Vec<_>>(),
            vec!["{\"name\":\"a\"}", "{\"name\":\"b\"}"]
        );
        assert!(found[0].file.ends_with("a.json"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_is_an_error_not_an_empty_list() {
        // 빈 목록으로 답하면 "테마가 없다"와 "디렉터리를 못 읽었다"가 같아진다.
        let missing = std::env::temp_dir().join("soksak-portable-themes-absent-xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(scan(&missing).is_err());
    }

    #[test]
    fn the_answer_follows_the_directory_it_is_given() {
        let a = test_dir("two-a");
        let b = test_dir("two-b");
        std::fs::write(a.join("t.json"), "{\"name\":\"a\"}").unwrap();
        assert_eq!(scan(&a).unwrap().len(), 1);
        assert_eq!(scan(&b).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
