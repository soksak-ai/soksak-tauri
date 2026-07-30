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

/// 파일에 실린 모양 — 판과 선언 목록. `deny_unknown_fields` 는 낡은 판을 조용히 통과시키지
/// 않는다: 모르는 필드를 버리면 그 필드를 쓰는 쪽에서만 유닛이 사라진다.
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

/// 이 정체성이 받아들이는 선언만 — 나머지는 사유와 함께 갈라 낸다.
///
/// 홈 레인 규칙: dev 소스는 dev 정체성에서만 적재된다. 그 판정은 선언 자체의 유효성과 다른
/// 축이라 `read_declared` 뒤에 온다 — 잘못 쓴 선언은 어느 정체성에서도 오류이고, 남의 홈을
/// 가리키는 선언은 **이 정체성에서만** 거부다.
pub fn list_accepted(home: &Path, core_build: &str) -> Result<Partitioned, String> {
    let (accepted, rejected) = read_declared(home)?
        .into_iter()
        .partition(|u| crate::identity::dev_source_accepted(Path::new(&u.source), home, core_build));
    Ok(Partitioned { accepted, rejected })
}

/// 받아들인 것과 갈라 낸 것. 거부를 버리지 않는다 — 왜 안 보이는지가 답의 일부다.
pub struct Partitioned {
    pub accepted: Vec<UnitDevSource>,
    pub rejected: Vec<UnitDevSource>,
}

/// 선언한 source 가 **지금 실체로 있는가.**
///
/// `validate_declared` 는 선언이 말이 되는지만 본다(절대경로·kind·id·심링크). 여기서는 그
/// 위에 존재까지 확인한다 — 선언 시점에는 검증하지만, 목록은 checkout 이 사라져도 계속
/// 노출해 적재기가 유닛별로 오류를 내게 한다. 두 질문을 한 함수가 겸하면 그 구분이 사라진다.
pub fn validate_source_exists(source: &Path) -> Result<(), String> {
    if !source.is_absolute() {
        return Err(format!(
            "개발 source는 절대경로여야 합니다: {}",
            source.display()
        ));
    }
    crate::pathx::reject_symlink_components(source)?;
    if !source.is_dir() {
        return Err(format!(
            "개발 source 디렉터리가 없습니다: {}",
            source.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod read_tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .canonicalize()
            .expect("실측 temp")
            .join(format!("udev-read-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("config")).unwrap();
        d
    }

    #[test]
    fn a_dev_identity_accepts_an_outside_source() {
        let h = home("accept");
        let src = h.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            config_path(&h),
            format!(
                r#"{{"version":1,"units":[{{"kind":"plugin","id":"a","source":"{}"}}]}}"#,
                src.to_string_lossy()
            ),
        )
        .unwrap();
        let p = list_accepted(&h, "dev").expect("dev");
        assert_eq!(p.accepted.len(), 1);
        assert!(p.rejected.is_empty());

        // dev 아닌 정체성은 같은 선언을 갈라 낸다 — 버리지 않고 사유로 남는다.
        let p2 = list_accepted(&h, "release").expect("release");
        assert!(p2.accepted.is_empty());
        assert_eq!(p2.rejected.len(), 1);
    }

    #[test]
    fn a_missing_source_directory_is_refused() {
        assert!(validate_source_exists(Path::new("/nonexistent-xyz-abc")).is_err());
        assert!(validate_source_exists(Path::new("relative")).is_err());
        let d = std::env::temp_dir().canonicalize().unwrap();
        assert!(validate_source_exists(&d).is_ok());
    }
}

// ── 쓰기와 판정 ───────────────────────────────────────────────────────────────
//
// 읽기와 같은 자리에 산다. 갈라 두면 앱과 cored 가 같은 파일을 다른 규칙으로 쓰고, 그 차이는
// 거부가 아니라 **한쪽에서만 보이는 유닛**으로 나타난다.
//
// 공유 config 의 read-modify-write 는 **프로세스 간** 잠금 아래에서 한다(`*_locked`). 프로세스
// 안의 Mutex 는 프로세스 둘을 못 막는다 — 각자 자기 것을 잡고 서로를 못 보므로, 겹친 쓰기가
// 남의 선언을 지운 채로 성공을 답한다. 그 손실은 오류로 안 보인다: 파일은 멀쩡하고 내용만
// 뒤로 돌아간다.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEnvironment {
    /// 읽기 경계에서 거부된 dev 유닛(타 identity 홈 소스) — 잔재 수습 안내용.
    pub rejected_development_units: Vec<UnitDevSource>,
    pub core_build: String,
    pub identity: String,
    pub cli: String,
    pub home: String,
    pub build_profile: &'static str,
    pub updater_enabled: bool,
    pub unit_mode: &'static str,
    pub development_units: Vec<UnitDevSource>,
}


// 선언 유효성 규칙은 코어가 소유한다 — 앱과 cored 가 같은 config 를 읽으므로 규칙이 두
// 벌이면 통과 기준이 프로세스마다 달라지고, 그 차이는 거부가 아니라 한쪽에서만 보이는
// 유닛으로 나타난다(2026-07-28 실측).

pub fn validate_source(home: &Path, kind: &str, id: &str, source: &Path) -> Result<(), String> {
    validate_declared(kind, id, source)?;
    validate_source_path_in(source, home)
}

pub fn validate_source_path_in(source: &Path, home: &Path) -> Result<(), String> {
    // 절대경로·심링크·존재는 코어가 본다(cored 의 unit_dev_validate_path 와 같은 규칙).
    validate_source_exists(source)?;
    // 홈 레인 판정은 여기 남는다 — 이 검사는 **어느 홈에서 묻는가**에 따라 답이 달라져서,
    // 홈을 인자로 받는 코어 함수와 달리 호출자의 홈이 곧 답의 일부다.
    if let Some(foreign) = foreign_identity_home(source, home) {
        return Err(format!(
            "다른 identity 홈({}) 안의 경로는 이 홈의 개발 source 가 될 수 없습니다: {}. \
             그 홈의 앱으로 검증하거나, 발행한 뒤 이 홈에 설치해서 검증하십시오.",
            foreign.display(),
            source.display()
        ));
    }
    Ok(())
}

/// source 가 이 홈이 아닌 다른 identity 홈 안에 있으면 그 홈 경로를 돌려준다.
///
/// 이름 규칙 판정은 soksak-core 이 소유한다 — 홈 레인 규칙은 앱과 cored 가 같아야 한다.
pub fn foreign_identity_home(source: &Path, home: &Path) -> Option<PathBuf> {
    crate::identity::foreign_identity_home(source, home)
}

pub fn read_config_in(home: &Path) -> Result<UnitDevConfig, String> {
    let path = config_path(home);
    if !path.exists() {
        return Ok(UnitDevConfig {
            version: CONFIG_VERSION,
            units: Vec::new(),
        });
    }
    crate::pathx::reject_symlink_components(&path)?;
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("{} 읽기 실패: {e}", path.display()))?;
    let mut config: UnitDevConfig =
        serde_json::from_str(&raw).map_err(|e| format!("{} 파싱 실패: {e}", path.display()))?;
    if config.version != CONFIG_VERSION {
        return Err(format!(
            "지원하지 않는 development unit config version: {} (지원={CONFIG_VERSION})",
            config.version
        ));
    }
    let mut keys = std::collections::HashSet::new();
    for unit in &config.units {
        // checkout은 선택 뒤 이동/삭제될 수 있다. 선언 자체는 계속 노출해 loader가 unit별로
        // 명시적 오류를 보고하게 하고, 공식 설치본으로 fallback하지 않는다.
        validate_declared(&unit.kind, &unit.id, Path::new(&unit.source))?;
        if !keys.insert((unit.kind.as_str(), unit.id.as_str())) {
            return Err(format!(
                "development unit config에 중복 key가 있습니다: {}/{}",
                unit.kind, unit.id
            ));
        }
    }
    config
        .units
        .sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    Ok(config)
}

pub fn write_config_in(home: &Path, config: &UnitDevConfig) -> Result<(), String> {
    let path = config_path(home);
    let parent = path
        .parent()
        .ok_or_else(|| "development config 상위 경로 없음".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    crate::pathx::reject_symlink_components(parent)?;
    let tmp = parent.join(format!(".{CONFIG_FILE}.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("development config 원자 교체 실패: {e}"));
    }
    Ok(())
}

/// 설정의 유닛을 (유효, 거부) 로 분리한다 — 읽기 경계 강제(과거 기록도 예외 없음):
/// non-dev identity 는 dev 소스 유닛 **전부**를 거부한다(홈 레인 원칙 — debug·release 는
/// 발행본 설치로만 검증), dev identity 는 타 identity 홈 소스만 거부한다.
pub fn partition_for_identity(
    units: Vec<UnitDevSource>,
    home: &Path,
    core_build: &str,
) -> (Vec<UnitDevSource>, Vec<UnitDevSource>) {
    units.into_iter().partition(|u| {
        crate::identity::dev_source_accepted(Path::new(&u.source), home, core_build)
    })
}

pub fn rejected_in(home: &Path, core_build: &str) -> Result<Vec<UnitDevSource>, String> {
    let (_, rejected) = partition_for_identity(read_config_in(home)?.units, home, core_build);
    Ok(rejected)
}

pub fn list_in(home: &Path, core_build: &str) -> Result<Vec<UnitDevSource>, String> {
    // 빌드 축은 부른 쪽이 준다 — 여기서 프로세스 환경을 읽으면 같은 홈을 두 프로세스가
    // 다르게 읽는다. 목록은 축에 따라 갈리므로(거부된 선언이 빠진다) 그 차이가 곧 "한쪽에서만
    // 보이는 유닛"이다.
    list_in_for(home, core_build)
}

pub fn list_in_for(home: &Path, core_build: &str) -> Result<Vec<UnitDevSource>, String> {
    // 읽기 규칙은 코어가 소유한다 — cored 가 같은 명령을 서빙하므로 두 벌이면 답이 갈린다.
    let p = list_accepted(home, core_build)?;
    let (valid, rejected) = (p.accepted, p.rejected);
    for r in &rejected {
        eprintln!(
            "[unit-dev] dev 소스 거부(읽기 경계, identity={core_build}): {} {} — {}",
            r.kind, r.id, r.source
        );
    }
    Ok(valid)
}

pub fn set_in(home: &Path, kind: &str, id: &str, source: &Path) -> Result<UnitDevSource, String> {
    validate_source(home, kind, id, source)?;
    // lexical 절대경로를 그대로 보존한다. canonicalize로 symlink를 숨기지 않는다.
    let selected = UnitDevSource {
        kind: kind.to_string(),
        id: id.to_string(),
        source: source.to_string_lossy().into_owned(),
    };
    let mut config = read_config_in(home)?;
    config.units.retain(|u| !(u.kind == kind && u.id == id));
    config.units.push(selected.clone());
    config
        .units
        .sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    write_config_in(home, &config)?;
    Ok(selected)
}

pub fn remove_in(home: &Path, kind: &str, id: &str) -> Result<bool, String> {
    if !valid_kind(kind) {
        return Err(format!(
            "지원하지 않는 unit kind: {kind:?} (plugin|sidecar|kit)"
        ));
    }
    if !valid_id(id) {
        return Err(format!("잘못된 unit id: {id:?} (^[a-z0-9][a-z0-9-]*$)"));
    }
    let mut config = read_config_in(home)?;
    let before = config.units.len();
    config.units.retain(|u| !(u.kind == kind && u.id == id));
    let removed = before != config.units.len();
    if removed {
        write_config_in(home, &config)?;
    }
    Ok(removed)
}

/// 선언 하나를 앉힌다 — 홈은 인자다. **프로세스 간** 잠금 아래에서 read-modify-write 한다.
pub fn set_source(home: &Path, kind: &str, id: &str, source: &Path) -> Result<UnitDevSource, String> {
    let _guard = crate::file_lock::acquire(&config_path(home))?;
    set_in(home, kind, id, source)
}

/// 지우는 것도 같은 read-modify-write 라 같은 잠금 아래에 둔다.
pub fn remove_source(home: &Path, kind: &str, id: &str) -> Result<bool, String> {
    let _guard = crate::file_lock::acquire(&config_path(home))?;
    remove_in(home, kind, id)
}

/// dev 소스 작업은 dev identity 전용(홈 레인 원칙) — debug·release 홈은 발행본 설치로 검증한다.
///
/// 규칙이라 여기 산다. 껍데기에 두면 두 껍데기가 같은 이름에 다른 기준을 갖는다.
/// 제거는 어디서나 허용한다 — 잔재 수습을 막지 않는다.
pub fn ensure_dev_identity_build(core_build: &str) -> Result<(), String> {
    if core_build == "dev" {
        return Ok(());
    }
    Err(format!(
        "dev 소스 작업은 dev 환경 전용입니다(현재: {core_build}). \
         debug·release 홈은 발행한 유닛을 설치해서 검증하십시오."
    ))
}

#[cfg(test)]
#[path = "unit_dev_tests.rs"]
mod unit_dev_tests;
