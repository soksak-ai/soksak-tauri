//! 설치 플러그인 디렉터리 훑기 — 베이스 디렉터리는 **인자로 온다**.
//!
//! 매니페스트(`plugin.json`)와 설치 상태(`.soksak.json`) 원문만 나른다. 내용 검증은 프론트
//! 스펙이 단일 진실이다. 읽기 실패는 침묵 누락 대신 `error` 로 나간다 — 목록에서 사라진
//! 플러그인은 사용자에게 "설치되지 않은 것"으로 보이고, 그 오답은 조용하다.

use serde::Serialize;
use std::path::Path;

/// 플러그인 id = `^[a-z0-9][a-z0-9-]*$` (스펙 §3 과 동일).
///
/// 경로 탈출 차단이 **문자셋 자체**에 있다 — 허용 문자에 `.` 도 `/` 도 없어서 `..` 류가
/// 규칙에 걸리기 전에 이미 없다. 그래서 이 검사가 두 벌이 되면 안 된다: 한쪽만 느슨해지면
/// 그쪽에서만 홈 밖이 열리고, 그 차이는 검사를 통과한 쪽에서는 보이지 않는다.
pub fn sanitize_id(id: &str) -> Result<(), String> {
    let mut chars = id.chars();
    let head_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if head_ok && rest_ok {
        Ok(())
    } else {
        Err(format!("잘못된 플러그인 id: {id:?}"))
    }
}

/// 설치본 디렉터리를 통째로 지운다 — 전용 저장소(`plugins-data/<id>`)는 **남긴다**.
///
/// 그 자리는 이 함수가 만지는 베이스 밖이다. 함께 지우면 재설치가 빈 상태로 시작하고,
/// 사용자가 잃은 것은 오류로 나타나지 않는다(플러그인이 기본값으로 뜰 뿐이다).
///
/// 순서가 이 함수에 있는 이유: 설치본은 읽기전용으로 잠겨 있어서(`chmod -R a-w`) 잠금을
/// 풀기 전에 `remove_dir_all` 을 부르면 막힌다. 순서가 두 벌이면 한쪽만 잠긴 트리를 못 지우고,
/// 그 실패는 "권한 없음" 한 줄이라 원인이 순서라는 것이 안 보인다.
///
/// `unlock` 이 콜백인 이유: 잠금을 푸는 것은 프로세스 스폰(`chmod`)이고, 스폰은 프레임워크
/// 없는 로직의 것이 아니다. **무엇을 언제 하는가**는 여기가 소유하고, 그 한 걸음만 부르는
/// 쪽이 준다. 실패해도 멈추지 않는다 — 잠기지 않은 트리에서도 제거는 서야 한다(best-effort).
pub fn remove(base: &Path, id: &str, unlock: impl FnOnce(&Path)) -> Result<(), String> {
    sanitize_id(id)?;
    let dir = base.join(id);
    // 부재를 성공으로 접으면 없앤 적 없는 것을 없앴다가 된다 — 오탈자 하나가 조용히 지나간다.
    if !dir.exists() {
        return Err(format!("설치되지 않은 플러그인: {id}"));
    }
    unlock(&dir);
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

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
/// 없는 디렉터리는 오류가 아니라 **아무것도 없는 상태**다 — 다만 그것만 그렇다.
///
/// "없음"과 "못 읽음"을 같은 답으로 만들면 안 된다는 원칙은 그대로다: `NotFound` 만 빈
/// 목록으로 가르고, 권한 거부·디렉터리 아님 같은 다른 실패는 사유를 달고 올린다.
///
/// 이 구분이 필요한 이유는 소유자가 갈렸기 때문이다. 앱은 스캔 전에 `create_dir_all` 로
/// 자기 홈 배치를 만들어 두므로 부재를 볼 일이 없다. cored 는 남의 홈을 읽을 뿐이라 그
/// 부작용을 지지 않고(읽기 명령이 디스크를 만들지 않는다), 신선한 홈에서 곧장 부재를 만난다.
/// 그때 오류를 올리면 같은 이름의 명령이 프로세스마다 다른 답을 낸다
/// (2026-07-28 라이브 실측: 앱 `[]`, cored `os error 2`).
fn read_dir_or_empty(dir: &std::path::Path) -> Result<Option<std::fs::ReadDir>, String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(Some(entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn scan(base: &Path) -> Result<Vec<PluginScanEntry>, String> {
    let mut out = Vec::new();
    let Some(entries) = read_dir_or_empty(base)? else {
        return Ok(out);
    };
    for entry in entries {
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
    fn absence_and_unreadable_stay_different_answers() {
        // 원칙은 그대로다: "설치된 게 없다"와 "디렉터리를 못 읽었다"가 같아지면 안 된다.
        // 경계만 옮겼다 — 부재는 전자이고(빈 목록), 읽기 실패는 후자다(사유를 단 오류).
        let missing = std::env::temp_dir().join("soksak-core-plugins-absent-xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(scan(&missing).unwrap().len(), 0, "부재 = 설치된 플러그인 없음");

        let not_a_dir = std::env::temp_dir().join("soksak-core-plugins-file-xyz");
        std::fs::write(&not_a_dir, b"x").unwrap();
        assert!(scan(&not_a_dir).is_err(), "못 읽음은 여전히 오류다");
    }

    /// 문자셋 자체가 경로 탈출을 막는다 — 거부 문장은 앱이 쓰던 것 그대로다.
    #[test]
    fn sanitize_id_keeps_the_charset_that_forbids_escape() {
        assert!(sanitize_id("memo").is_ok());
        assert!(sanitize_id("git-2").is_ok());
        assert!(sanitize_id("").is_err());
        assert!(sanitize_id("-a").is_err());
        assert!(sanitize_id("A").is_err());
        assert!(sanitize_id("a/b").is_err());
        assert!(sanitize_id("a..b").is_err());
        assert!(sanitize_id("한글").is_err());
        assert_eq!(
            sanitize_id("../x").unwrap_err(),
            "잘못된 플러그인 id: \"../x\""
        );
    }

    /// 잠긴 트리도 지워진다 — 잠금 해제가 제거보다 **먼저** 불린다.
    #[test]
    fn remove_unlocks_before_it_deletes() {
        let base = test_base("remove-locked");
        make(&base, "memo", Some("{\"id\":\"memo\"}"), None);
        let dir = base.join("memo");
        let mut order = Vec::new();
        remove(&base, "memo", |d| {
            assert!(d.exists(), "해제는 제거 전에 온다");
            order.push(d.to_path_buf());
        })
        .expect("제거");
        assert_eq!(order, vec![dir.clone()], "잠금 해제가 대상 디렉터리에 걸린다");
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 부재와 잘못된 id 는 서로 다른 사유로 거절된다 — 둘 다 성공이 아니다.
    #[test]
    fn remove_refuses_absence_and_a_bad_id() {
        let base = test_base("remove-refusals");
        let mut unlocked = false;
        assert_eq!(
            remove(&base, "ghost", |_| unlocked = true).unwrap_err(),
            "설치되지 않은 플러그인: ghost"
        );
        assert!(!unlocked, "없는 것을 풀려 들면 안 된다");
        assert_eq!(
            remove(&base, "../etc", |_| {}).unwrap_err(),
            "잘못된 플러그인 id: \"../etc\""
        );
        let _ = std::fs::remove_dir_all(&base);
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

