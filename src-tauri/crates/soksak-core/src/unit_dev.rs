//! 개발 유닛 선언 읽기 — 홈 아래 config 파일 하나.
//!
//! 홈은 **인자로 온다**. 앱은 자기 정체성에서 홈을 파생하지만 cored 는 자기 정체성을
//! 추측하지 않는다 — 추측하면 홈이 갈릴 때 조용히 다른 identity 의 선언을 읽는다.
//!
//! 파일이 없으면 빈 목록이 정답이다(공식 설치본만 쓰는 상태). 부재를 오류로 올리면
//! 정상 상태가 실패로 보이고, 그 오해는 부팅을 멈춘다.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE: &str = "development-units.json";

/// 개발 소스 선언 하나 — 유닛 종류·id·체크아웃 경로.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UnitDevSource {
    pub kind: String,
    pub id: String,
    pub source: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct UnitDevConfig {
    version: u32,
    units: Vec<UnitDevSource>,
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join("config").join(CONFIG_FILE)
}

/// 홈 아래 선언 목록. 파일 부재 = 빈 목록(오류 아님). 판 불일치·파싱 실패는 Err —
/// 모르는 형식을 빈 목록으로 삼키면 사용자의 선언이 조용히 사라진다.
pub fn read_declared(home: &Path) -> Result<Vec<UnitDevSource>, String> {
    let path = config_path(home);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("development config 읽기 실패: {e}")),
    };
    let mut config: UnitDevConfig =
        serde_json::from_str(&raw).map_err(|e| format!("development config 파싱 실패: {e}"))?;
    if config.version != CONFIG_VERSION {
        return Err(format!(
            "지원하지 않는 development unit config version: {} (지원={CONFIG_VERSION})",
            config.version
        ));
    }
    config.units.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    Ok(config.units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("udev-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("config")).unwrap();
        d
    }

    #[test]
    fn a_missing_file_is_an_empty_list_not_an_error() {
        // 공식 설치본만 쓰는 상태가 정상이다 — 오류로 올리면 그 정상이 실패로 보인다.
        let home = std::env::temp_dir().join("udev-nonexistent-xyz");
        assert_eq!(read_declared(&home).unwrap(), Vec::new());
    }

    #[test]
    fn declarations_come_back_sorted() {
        let home = tmp("sorted");
        std::fs::write(
            config_path(&home),
            r#"{"version":1,"units":[
                {"kind":"plugin","id":"b","source":"/s/b"},
                {"kind":"plugin","id":"a","source":"/s/a"}
            ]}"#,
        )
        .unwrap();
        let units = read_declared(&home).unwrap();
        assert_eq!(units.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_unknown_version_fails_instead_of_being_swallowed() {
        // 모르는 형식을 빈 목록으로 삼키면 사용자의 선언이 조용히 사라진다.
        let home = tmp("version");
        std::fs::write(config_path(&home), r#"{"version":99,"units":[]}"#).unwrap();
        assert!(read_declared(&home).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_answer_follows_the_home_it_is_given() {
        let a = tmp("home-a");
        let b = tmp("home-b");
        std::fs::write(
            config_path(&a),
            r#"{"version":1,"units":[{"kind":"plugin","id":"x","source":"/s/x"}]}"#,
        )
        .unwrap();
        std::fs::write(config_path(&b), r#"{"version":1,"units":[]}"#).unwrap();
        assert_eq!(read_declared(&a).unwrap().len(), 1);
        assert_eq!(read_declared(&b).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
