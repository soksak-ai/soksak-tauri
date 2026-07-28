//! 정체성 파생 — "이 identifier 는 어느 홈·어느 빌드·어느 CLI 인가".
//!
//! 규칙은 identifier 문자열 하나에서 전부 나온다: 마지막 세그먼트가 `app` 이면 release,
//! 그 외는 그 세그먼트가 그대로 빌드 이름이자 홈 접미가 된다. 하드코딩 목록이 없어 새
//! identity 는 자동으로 자기 홈을 갖는다.
//!
//! 값의 출처는 전부 인자다. 환경(`HOME`/`USERPROFILE`)도, 플랫폼도 받아 쓴다 — 여기서
//! 읽으면 cored 가 앱과 다른 홈을 답하고, 그 오답은 조용하다(없는 파일을 "없음"으로 답할
//! 뿐 오류가 아니다).

use std::path::{Path, PathBuf};

/// 한 실행물의 정체성 — 홈과 identifier 는 **함께** 다닌다. 따로 넘기면 어긋난 조합
/// ("A 홈인데 B identifier")이 만들어지고, 그 조합은 어느 identity 에도 없다.
///
/// 이 값이 코어에 사는 이유: 앱과 cored 가 **같은 정체성을 같은 규칙으로** 읽어야 한다.
/// 각자 자기 struct 를 들면 파생 규칙이 두 벌이 되고, 두 벌은 언젠가 갈라진다.
/// 앰비언트 읽기는 여기 없다 — 이 값은 프로세스마다 **부팅 때 받는다**(앱은 셸 설정에서,
/// cored 는 띄운 쪽의 인자에서). 받는 것과 추측하는 것은 다르다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    home: PathBuf,
    identifier: String,
}

impl Identity {
    pub fn new(home: impl Into<PathBuf>, identifier: impl Into<String>) -> Self {
        Identity {
            home: home.into(),
            identifier: identifier.into(),
        }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn identifier(&self) -> &str {
        &self.identifier
    }

    /// release core 판정 — updater 채널만 결정한다.
    pub fn is_release(&self) -> bool {
        core_build_for_identifier(&self.identifier) == "release"
    }

    /// 이 정체성의 core build 이름(release/dev/debug/…).
    pub fn core_build(&self) -> String {
        core_build_for_identifier(&self.identifier)
    }

    /// 이 정체성의 CLI 이름(sok / sok-dev / sok-debug).
    pub fn cli_name(&self) -> String {
        cli_for_core_build(&self.core_build())
    }

    /// 홈 아래 경로 — 홈을 직접 조립하는 호출자를 없앤다.
    ///
    /// **항상 홈 아래**다. `Path::join` 은 절대경로를 받으면 베이스를 통째로 버리는데,
    /// 이 계약의 값은 "홈 아래"를 보장하는 데 있다. 조용히 탈출을 허용하면 계약이
    /// 거짓말이 되고, 그 거짓말은 호출자가 검사를 생략하는 근거가 된다. 절대경로·`..`
    /// 는 루트와 부모 컴포넌트를 떼어 상대 경로로 읽는다.
    pub fn path(&self, rel: impl AsRef<Path>) -> PathBuf {
        use std::path::Component;
        let mut out = self.home.clone();
        for c in rel.as_ref().components() {
            match c {
                Component::Normal(part) => out.push(part),
                // 루트·프리픽스·"."·".." 는 홈을 벗어나거나 되돌리는 컴포넌트다 — 버린다.
                _ => continue,
            }
        }
        out
    }

    // ── 홈 아래 규약 경로 ────────────────────────────────────────────────────
    //
    // 이름을 여기 모으는 이유: 같은 디렉터리를 두 프로세스가 각자 문자열로 적으면 한쪽만
    // 고쳐질 수 있고, 그 어긋남은 오류가 아니라 **빈 결과**로 나타난다(없는 곳을 훑고
    // "없음"이라 답한다). 앱은 fs.rs·plugins.rs 에서, cored 는 서빙 표에서 같은 곳을 봐야 한다.

    /// 설치된 테마 파일이 사는 곳.
    pub fn themes_dir(&self) -> PathBuf {
        themes_dir(&self.home)
    }

    /// 설치·개발 플러그인이 함께 사는 단일 폴더.
    pub fn plugins_dir(&self) -> PathBuf {
        plugins_dir(&self.home)
    }

    /// app.data 저장소 디렉터리. 앱은 debug 빌드에서 이 자리를 env 로 옮길 수 있고
    /// (테스트 격리), 그때는 **옮긴 쪽이 cored 에도 같은 경로를 준다** — cored 가 규칙만 보고
    /// 파생하면 앱과 다른 DB 를 열고, 그 오답은 조용하다.
    pub fn data_dir(&self) -> PathBuf {
        data_dir(&self.home)
    }

    /// app.data 단일 파일.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir().join(DB_FILE)
    }
}

// ── 홈 기준 레이아웃 ─────────────────────────────────────────────────────────
//
// 정체성을 아직 모으지 못한 자리(홈만 인자로 받는 함수)도 같은 규칙을 봐야 하므로 자유
// 함수로 둔다. `Identity` 는 이것들을 부를 뿐이다 — 홈만으로 정체성을 **지어내면**
// identifier 가 빈 조합이 만들어지고, 그건 이 타입이 막으려던 바로 그 어긋남이다.

/// app.data 파일명 — 백업 슬롯(`.bak.N`)도 이 이름에서 파생된다.
pub const DB_FILE: &str = "soksak.db";

/// 설치된 테마 파일이 사는 곳.
pub fn themes_dir(home: &Path) -> PathBuf {
    home.join("themes")
}

/// 설치·개발 플러그인이 함께 사는 단일 폴더.
pub fn plugins_dir(home: &Path) -> PathBuf {
    home.join("plugins")
}

/// app.data 저장소 디렉터리.
pub fn data_dir(home: &Path) -> PathBuf {
    home.join("data")
}

/// release core 판정 — identifier 마지막 세그먼트가 `app`.
pub fn is_release_identifier(identifier: &str) -> bool {
    identifier.rsplit('.').next() == Some("app")
}

/// identifier → core build 이름(release/dev/debug/…).
pub fn core_build_for_identifier(identifier: &str) -> String {
    match identifier.rsplit('.').next().unwrap_or("app") {
        "app" => "release".to_string(),
        "dev" => "dev".to_string(),
        "debug" => "debug".to_string(),
        other => other.to_string(),
    }
}

/// core build → CLI 이름(sok / sok-dev / sok-debug / …).
pub fn cli_for_core_build(core_build: &str) -> String {
    match core_build {
        "release" => "sok".to_string(),
        other => format!("sok-{other}"),
    }
}

/// 홈 디렉터리명 접미 — `app` 은 무접미, 그 외는 `-<세그먼트>`.
pub fn home_suffix_for_identifier(identifier: &str) -> String {
    let seg = identifier.rsplit('.').next().unwrap_or("app");
    if seg == "app" {
        String::new()
    } else {
        format!("-{seg}")
    }
}

/// 홈 베이스 경로 — 플랫폼과 환경 값을 받아 결정한다.
///
/// Windows 는 `HOME` 미설정이 흔하다. 빈 값이 되면 볼트·DB 경로가 cwd 상대 `.soksak` 로
/// 깨지므로 `USERPROFILE` 로 폴백한다. macOS/Linux 는 `HOME` 그대로다(`USERPROFILE` 없음).
pub fn home_base(is_windows: bool, home: Option<&str>, userprofile: Option<&str>) -> PathBuf {
    fn non_empty(v: Option<&str>) -> Option<&str> {
        v.filter(|s| !s.is_empty())
    }
    let base = if is_windows {
        non_empty(home).or(non_empty(userprofile))
    } else {
        non_empty(home)
    };
    PathBuf::from(base.unwrap_or(""))
}

/// identity 홈(절대경로) — 베이스 + `.soksak<접미>`.
///
/// identifier 가 없으면 무접미(`~/.soksak`). runtime override 는 없다 — 홈은 identifier
/// 에서만 파생된다(distribution 불변식).
pub fn home_for(
    identifier: Option<&str>,
    is_windows: bool,
    home: Option<&str>,
    userprofile: Option<&str>,
) -> PathBuf {
    let base = home_base(is_windows, home, userprofile);
    let suffix = identifier
        .map(home_suffix_for_identifier)
        .unwrap_or_default();
    base.join(format!(".soksak{suffix}"))
}

/// `source` 가 이 홈이 아닌 **다른 identity 홈** 안에 있으면 그 홈 경로를 돌려준다.
///
/// identity 홈은 형제로 나란히 산다(`~/.soksak`, `~/.soksak-dev`, …). 새 identity 가
/// 자동으로 자기 홈을 갖기 때문에 목록을 하드코딩하지 않고, 이 홈의 형제 중 같은 이름
/// 규칙을 만족하는 디렉터리를 홈으로 본다. 홈 밖(작업 checkout)은 대상이 아니다.
///
/// 디스크를 만지지 않는다 — 이름 규칙만 본다.
pub fn foreign_identity_home(source: &Path, home: &Path) -> Option<PathBuf> {
    let parent = home.parent()?;
    source
        .ancestors()
        .find(|anc| {
            anc.parent() == Some(parent)
                && *anc != home
                && anc
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n == ".soksak" || n.starts_with(".soksak-"))
        })
        .map(Path::to_path_buf)
}

/// 이 홈이 이 dev 소스를 받아들이는가 — 홈 레인 원칙의 판정.
///
/// non-dev identity(debug·release)는 dev 소스를 **전부** 거부한다: 발행본 설치로만
/// 검증한다. dev identity 는 다른 identity 홈 안의 소스만 거부한다.
pub fn dev_source_accepted(source: &Path, home: &Path, core_build: &str) -> bool {
    core_build == "dev" && foreign_identity_home(source, home).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_is_the_app_segment_and_nothing_else() {
        assert!(is_release_identifier("com.soksak.app"));
        assert!(!is_release_identifier("com.soksak.dev"));
        assert!(!is_release_identifier("com.soksak.debug"));
    }

    #[test]
    fn the_last_segment_names_the_build_and_the_cli() {
        assert_eq!(core_build_for_identifier("com.soksak.app"), "release");
        assert_eq!(core_build_for_identifier("com.soksak.dev"), "dev");
        assert_eq!(core_build_for_identifier("com.soksak.debug"), "debug");
        assert_eq!(cli_for_core_build("release"), "sok");
        assert_eq!(cli_for_core_build("dev"), "sok-dev");
        assert_eq!(cli_for_core_build("debug"), "sok-debug");
    }

    #[test]
    fn a_new_identity_gets_its_own_home_without_a_list() {
        assert_eq!(home_suffix_for_identifier("com.soksak.app"), "");
        assert_eq!(home_suffix_for_identifier("com.soksak.dev"), "-dev");
        assert_eq!(home_suffix_for_identifier("com.soksak.debug"), "-debug");
        assert_eq!(home_suffix_for_identifier("com.soksak.beta"), "-beta");
        assert_eq!(core_build_for_identifier("com.soksak.beta"), "beta");
        assert_eq!(cli_for_core_build("beta"), "sok-beta");
    }

    #[test]
    fn windows_falls_back_to_userprofile_and_others_do_not() {
        assert_eq!(
            home_base(false, Some("/home/max"), Some("C:\\Users\\max")),
            PathBuf::from("/home/max")
        );
        assert_eq!(
            home_base(true, Some("H:\\home"), Some("C:\\Users\\max")),
            PathBuf::from("H:\\home")
        );
        assert_eq!(
            home_base(true, None, Some("C:\\Users\\max")),
            PathBuf::from("C:\\Users\\max")
        );
        assert_eq!(
            home_base(true, Some(""), Some("C:\\Users\\max")),
            PathBuf::from("C:\\Users\\max")
        );
        assert_eq!(
            home_base(false, None, Some("C:\\Users\\max")),
            PathBuf::from("")
        );
    }

    #[test]
    fn the_home_derives_from_the_identifier_only() {
        assert_eq!(
            home_for(Some("com.soksak.debug"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak-debug")
        );
        assert_eq!(
            home_for(Some("com.soksak.app"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak")
        );
        assert_eq!(
            home_for(Some("com.soksak.beta"), false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak-beta")
        );
        assert_eq!(
            home_for(None, false, Some("/home/max"), None),
            PathBuf::from("/home/max/.soksak")
        );
    }

    #[test]
    fn the_platform_is_an_argument_not_a_compile_target() {
        // 같은 입력이 플랫폼 인자로만 갈린다 — 바이너리가 무엇인지로 갈리지 않는다.
        assert_ne!(
            home_for(Some("com.soksak.app"), true, None, Some("C:\\Users\\max")),
            home_for(Some("com.soksak.app"), false, None, Some("C:\\Users\\max"))
        );
    }

    #[test]
    fn a_sibling_identity_home_is_foreign() {
        let home = Path::new("/u/max/.soksak-dev");
        assert_eq!(
            foreign_identity_home(Path::new("/u/max/.soksak-debug/plugins/x"), home),
            Some(PathBuf::from("/u/max/.soksak-debug"))
        );
        assert_eq!(
            foreign_identity_home(Path::new("/u/max/.soksak/plugins/x"), home),
            Some(PathBuf::from("/u/max/.soksak"))
        );
    }

    #[test]
    fn this_home_and_plain_checkouts_are_not_foreign() {
        let home = Path::new("/u/max/.soksak-dev");
        assert_eq!(
            foreign_identity_home(Path::new("/u/max/.soksak-dev/plugins/x"), home),
            None
        );
        assert_eq!(
            foreign_identity_home(Path::new("/u/max/work/plugin"), home),
            None
        );
        // 이름이 비슷해도 형제가 아니면 홈이 아니다.
        assert_eq!(
            foreign_identity_home(Path::new("/other/.soksak-debug/x"), home),
            None
        );
    }

    #[test]
    fn only_the_dev_lane_accepts_a_dev_source() {
        let home = Path::new("/u/max/.soksak-dev");
        let own = Path::new("/u/max/work/plugin");
        assert!(dev_source_accepted(own, home, "dev"));
        assert!(!dev_source_accepted(own, home, "debug"));
        assert!(!dev_source_accepted(own, home, "release"));
        // dev 레인이라도 남의 홈 안은 거부한다.
        assert!(!dev_source_accepted(
            Path::new("/u/max/.soksak-debug/plugins/x"),
            home,
            "dev"
        ));
    }
}
