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
    // config 파일에 이르는 경로가 링크면 읽는 곳이 검사한 곳과 달라진다.
    if path.exists() {
        crate::pathx::reject_symlink_components(&path)?;
    }
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
    // 선언 하나하나를 검사한다. 이 검사가 없으면 같은 config 를 앱은 거부하고 이 함수는
    // 통과시킨다 — 그 차이는 오류가 아니라 **한쪽에서만 보이는 유닛**으로 나타난다.
    let mut seen = std::collections::HashSet::new();
    for unit in &config.units {
        validate_declared(&unit.kind, &unit.id, Path::new(&unit.source))?;
        if !seen.insert((unit.kind.as_str(), unit.id.as_str())) {
            return Err(format!(
                "development unit config에 중복 key가 있습니다: {}/{}",
                unit.kind, unit.id
            ));
        }
    }
    config.units.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    Ok(config.units)
}

/// 지원하는 유닛 종류.
pub fn valid_kind(kind: &str) -> bool {
    matches!(kind, "plugin" | "sidecar" | "kit")
}

/// 유닛 id 규칙 — `^[a-z0-9][a-z0-9-]*$`.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 선언 하나의 유효성 — 종류·id·절대경로·심링크.
///
/// checkout 은 선언 뒤에 옮겨지거나 지워질 수 있으므로 **존재는 묻지 않는다.** 선언 자체는
/// 계속 노출해 적재기가 유닛별로 명시적 오류를 내게 하고, 공식 설치본으로 조용히 폴백하지
/// 않는다. 여기서 보는 것은 "이 선언이 말이 되는가"뿐이다.
pub fn validate_declared(kind: &str, id: &str, source: &Path) -> Result<(), String> {
    if !valid_kind(kind) {
        return Err(format!(
            "지원하지 않는 unit kind: {kind:?} (plugin|sidecar|kit)"
        ));
    }
    if !valid_id(id) {
        return Err(format!("잘못된 unit id: {id:?} (^[a-z0-9][a-z0-9-]*$)"));
    }
    if !source.is_absolute() {
        return Err(format!(
            "개발 source는 절대경로여야 합니다: {}",
            source.display()
        ));
    }
    crate::pathx::reject_symlink_components(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        // macOS 의 temp_dir 은 /var(심링크) 아래라 canonicalize 가 필요하다 — 심링크 거부가
        // 정당하게 걸린다(픽스처의 문제이지 기준의 문제가 아니다).
        let d = std::env::temp_dir()
            .canonicalize()
            .expect("실측 temp")
            .join(format!("udev-{}-{name}", std::process::id()));
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

#[cfg(test)]
mod drift_tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .canonicalize()
            .expect("실측 temp")
            .join(format!("udev-drift-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("config")).expect("픽스처");
        d
    }

    fn write_config(h: &Path, units: &str) {
        std::fs::write(
            config_path(h),
            format!(r#"{{"version":1,"units":[{units}]}}"#),
        )
        .expect("config");
    }

    /// 상대경로 소스는 거부돼야 한다. 앱 경로는 거부하는데 코어가 통과시키면, 같은 config 를
    /// 두 프로세스가 다르게 읽는다 — 그리고 그 차이는 오류가 아니라 **유닛 하나가 더 있는 것**
    /// 으로 나타난다(2026-07-28 감사).
    #[test]
    fn a_relative_source_is_refused() {
        let h = home("relative");
        write_config(&h, r#"{"kind":"plugin","id":"a","source":"relative/path"}"#);
        let why = read_declared(&h).expect_err("상대경로는 거부한다");
        assert!(why.contains("절대경로"), "{why}");
    }

    /// kind·id 도 검사한다 — 규칙 밖 이름이 통과하면 적재기가 없는 것을 찾는다.
    #[test]
    fn a_bad_kind_or_id_is_refused() {
        let h = home("kind");
        write_config(&h, r#"{"kind":"widget","id":"a","source":"/usr/local/x"}"#);
        assert!(read_declared(&h).is_err(), "모르는 kind 를 통과시켰다");

        let h2 = home("id");
        write_config(&h2, r#"{"kind":"plugin","id":"../etc","source":"/usr/local/x"}"#);
        assert!(read_declared(&h2).is_err(), "규칙 밖 id 를 통과시켰다");
    }

    /// 같은 (kind,id)가 두 번 있으면 어느 것이 이기는지 규칙이 없다 — 거부한다.
    #[test]
    fn a_duplicate_key_is_refused() {
        let h = home("dup");
        write_config(
            &h,
            r#"{"kind":"plugin","id":"a","source":"/usr/local/x"},{"kind":"plugin","id":"a","source":"/usr/local/y"}"#,
        );
        let why = read_declared(&h).expect_err("중복 key 는 거부한다");
        assert!(why.contains("중복"), "{why}");
    }

    /// 정상 config 는 그대로 읽힌다 — 검사를 얹었다고 되던 것이 깨지면 안 된다.
    #[test]
    fn a_valid_config_still_reads() {
        let h = home("ok");
        write_config(
            &h,
            r#"{"kind":"sidecar","id":"b","source":"/usr/local/b"},{"kind":"plugin","id":"a","source":"/usr/local/a"}"#,
        );
        let units = read_declared(&h).expect("정상 config");
        assert_eq!(units.len(), 2);
        // 정렬 규칙(kind,id)도 그대로다.
        assert_eq!(units[0].id, "a");
    }

    #[test]
    fn a_missing_config_is_still_an_empty_list() {
        assert!(read_declared(&home("absent")).unwrap().is_empty());
    }
}
