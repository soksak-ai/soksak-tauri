//! 설치 플러그인 디렉터리 훑기 — 베이스 디렉터리는 **인자로 온다**.
//!
//! 매니페스트(`plugin.json`)와 설치 상태(`.soksak.json`) 원문만 나른다. 내용 검증은 프론트
//! 스펙이 단일 진실이다. 읽기 실패는 침묵 누락 대신 `error` 로 나간다 — 목록에서 사라진
//! 플러그인은 사용자에게 "설치되지 않은 것"으로 보이고, 그 오답은 조용하다.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginScanEntry {
    pub dir: String,
    pub dir_name: String,
    pub manifest: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// 베이스의 직속 하위 디렉터리 전부, 디렉터리명순.
///
/// 파일과 `.` 로 시작하는 이름은 제외한다 — 설치 중 임시 디렉터리(`.tmp-*`)가 그 규칙에
/// 자연히 걸린다.
pub fn scan(base: &Path) -> Result<Vec<PluginScanEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(base).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name.starts_with('.') {
            continue;
        }
        let (manifest, error) = match std::fs::read_to_string(path.join("plugin.json")) {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(format!("plugin.json 읽기 실패: {e}"))),
        };
        let state = std::fs::read_to_string(path.join(".soksak.json")).ok();
        out.push(PluginScanEntry {
            dir: path.to_string_lossy().to_string(),
            dir_name: name,
            manifest,
            state,
            error,
        });
    }
    out.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-core-plugins-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make(base: &Path, name: &str, manifest: Option<&str>, state: Option<&str>) {
        let dir = base.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(m) = manifest {
            std::fs::write(dir.join("plugin.json"), m).unwrap();
        }
        if let Some(s) = state {
            std::fs::write(dir.join(".soksak.json"), s).unwrap();
        }
    }

    #[test]
    fn directories_are_listed_by_name_with_their_two_files() {
        let base = test_base("basic");
        make(&base, "zeta", Some("{\"id\":\"zeta\"}"), None);
        make(
            &base,
            "alpha",
            Some("{\"id\":\"alpha\"}"),
            Some("{\"version\":\"0.0.1\"}"),
        );
        let found = scan(&base).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|e| e.dir_name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
        assert_eq!(found[0].state.as_deref(), Some("{\"version\":\"0.0.1\"}"));
        assert_eq!(found[1].state, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_manifest_is_reported_not_dropped() {
        // 목록에서 빼면 사용자에게 "설치 안 된 것"으로 보인다 — 거부 사유를 달고 남긴다.
        let base = test_base("no-manifest");
        make(&base, "broken", None, None);
        let found = scan(&base).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].manifest, None);
        assert!(found[0]
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("plugin.json 읽기 실패")));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_and_dot_names_are_not_plugins() {
        let base = test_base("filter");
        make(&base, ".tmp-1234", Some("{\"id\":\"x\"}"), None);
        std::fs::write(base.join("readme.md"), "x").unwrap();
        make(&base, "real", Some("{\"id\":\"real\"}"), None);
        let found = scan(&base).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|e| e.dir_name.as_str())
                .collect::<Vec<_>>(),
            vec!["real"]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_base_is_an_error_not_an_empty_list() {
        let missing = std::env::temp_dir().join("soksak-core-plugins-absent-xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(scan(&missing).is_err());
    }

    #[test]
    fn the_answer_follows_the_base_it_is_given() {
        let a = test_base("two-a");
        let b = test_base("two-b");
        make(&a, "only-here", Some("{\"id\":\"only-here\"}"), None);
        assert_eq!(scan(&a).unwrap().len(), 1);
        assert_eq!(scan(&b).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
