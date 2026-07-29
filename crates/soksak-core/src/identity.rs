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
/// 앰비언트 읽기는 여기 없다 — 이 값은 프로세스마다 **부팅 때 받는다**(앱은 프레임워크 설정에서,
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

    /// 플러그인 전용 저장소가 사는 곳 — 설치 트리와 **다른 자리**다. 플러그인을 지워도
    /// 여기는 남는다(재설치 시 데이터 보존).
    pub fn plugin_data_dir(&self) -> PathBuf {
        plugin_data_dir(&self.home)
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

    /// 이 identity 의 제어 소켓 자리.
    ///
    /// 규칙이지 관측이 아니다 — 누가 거기 붙어 있는지는 말하지 않는다. 붙는 것은 셸의
    /// 일이고, **어디에** 붙어야 하는지는 이 한 규칙이 정한다(앱·sok CLI·cored 가 각자
    /// 문자열을 적으면 한쪽만 고쳐질 수 있고, 그 어긋남은 "연결 실패"로만 나타난다).
    pub fn control_socket(&self) -> PathBuf {
        control_socket(&self.home, &self.identifier)
    }

    // 사용자 홈(`~`)은 여기서 파생하지 않는다. `<사용자 홈>/.soksak<접미>` 라는 관계는
    // **배포 배치에서만** 참이고, 격리·픽스처·테스트 배치에서는 부모가 사용자 홈이 아니다 —
    // 그리고 그 오답은 오류가 아니라 "세션 없음"·"빈 트리"로 나타나 오류로 보이지 않는다.
    // 사용자 홈이 필요한 프로세스는 부팅 인자로 받는다(cored 의 --user-home).
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

/// 플러그인 전용 저장소가 사는 곳.
///
/// 이름이 여기 있는 이유는 나머지와 같다: 앱은 이 문자열을 plugins.rs 에서 직접 적었고
/// cored 도 적으면 두 벌이 된다. 한쪽만 고쳐지면 어긋남은 오류가 아니라 **빈 목록**으로
/// 나타난다 — 없는 곳을 훑고 "저장된 게 없다"고 답한다.
pub fn plugin_data_dir(home: &Path) -> PathBuf {
    home.join("plugins-data")
}

/// app.data 저장소 디렉터리.
pub fn data_dir(home: &Path) -> PathBuf {
    home.join("data")
}

/// 제어 소켓 자리 — `<홈>/<identifier>.sock`.
pub fn control_socket(home: &Path, identifier: &str) -> PathBuf {
    home.join(format!("{identifier}.sock"))
}

/// 제품 이름 — 프레임워크 이름이 아니다. 접미가 붙어도 뿌리는 하나다.
pub const PRODUCT: &str = "soksak";

/// identifier 의 두 축 — `com.soksak.<framework>.<env>`.
///
/// 축이 둘인 이유: 두 프레임워크가 **같은 env 에서 동시에** 설 수 있어야 한다. 저장소는 단일
/// 쓰기 소유이고 소켓·데몬도 홈당 하나라, 동시에 서려면 홈이 갈려야 하고 홈은 이름에서 나온다.
///
/// 목록을 하드코딩하지 않는다 — 새 framework 도 새 env 도 자동으로 자기 홈을 갖는다.
/// 세그먼트가 모자라면(`com.soksak.dev` 같은 옛 모양) framework 는 없고 env 만 있다.
pub fn axes_of_identifier(identifier: &str) -> (Option<String>, String) {
    let segs: Vec<&str> = identifier.split('.').filter(|s| !s.is_empty()).collect();
    match segs.len() {
        0 => (None, "release".to_string()),
        1 => (None, segs[0].to_string()),
        _ => {
            let env = segs[segs.len() - 1].to_string();
            let fw = segs[segs.len() - 2];
            // `com.soksak.dev` 의 `soksak` 은 프레임워크가 아니라 제품이다.
            if segs.len() >= 4 && fw != PRODUCT {
                (Some(fw.to_string()), env)
            } else {
                (None, env)
            }
        }
    }
}

/// release core 판정.
pub fn is_release_identifier(identifier: &str) -> bool {
    core_build_for_identifier(identifier) == "release"
}

/// identifier → core build 이름(release/dev/debug/…). 옛 모양의 `app` 도 release 로 읽는다.
pub fn core_build_for_identifier(identifier: &str) -> String {
    let (_, env) = axes_of_identifier(identifier);
    if env == "app" { "release".to_string() } else { env }
}

/// identifier → 프레임워크 축(없으면 None).
///
/// 이 축은 **이름**을 가른다 — 제어 소켓·제품 표시 이름·프레임워크 전용 디렉터리. 홈은
/// 가르지 않는다(`home_suffix_for_identifier` 머리말).
pub fn framework_for_identifier(identifier: &str) -> Option<String> {
    axes_of_identifier(identifier).0
}

/// core build → CLI 이름. 접미 규칙은 홈과 같다 — 이름이 갈리면 어느 CLI 가 어느 홈인지 모른다.
pub fn cli_for_core_build(core_build: &str) -> String {
    match core_build {
        "release" => "sok".to_string(),
        other => format!("sok-{other}"),
    }
}

/// identifier → CLI 이름. **홈과 같은 축(env)이다** — CLI 는 홈을 다루는 도구이므로,
/// 프레임워크를 실으면 같은 홈에 서로 다른 이름의 CLI 가 둘 생긴다.
pub fn cli_for_identifier(identifier: &str) -> String {
    cli_for_core_build(&core_build_for_identifier(identifier))
}

/// identifier → 제품 표시 이름. **프레임워크 축을 싣는다**(홈과 다른 규칙이다).
///
/// 안 정하면 프레임워크의 이름이 그대로 앱 이름이 된다(Dock·메뉴바·알림). 프레임워크는
/// 렌더러일 뿐이고 제품은 하나다. 그러면서도 둘이 동시에 떠 있을 때 Dock 에서 갈려야 하므로
/// 여기에는 프레임워크가 실린다 — 홈은 하나여도 창은 둘이다.
pub fn product_name_for_identifier(identifier: &str) -> String {
    let (fw, env) = axes_of_identifier(identifier);
    let mut name = PRODUCT.to_string();
    if let Some(fw) = fw {
        name.push('-');
        name.push_str(&fw);
    }
    if !is_release_env(&env) {
        name.push('-');
        name.push_str(&env);
    }
    name
}

fn is_release_env(env: &str) -> bool {
    env == "release" || env == "app"
}

/// 홈 디렉터리명 접미 — **env 만 본다.** release 면 무접미, 그 외는 `-<env>`.
///
/// 프레임워크는 홈을 가르지 않는다. 홈에 든 것(플러그인·프로젝트·테마·볼트)은 프레임워크의
/// 것이 아니라 **사용자의 것**이고, 홈을 프레임워크로 가르면 프레임워크를 바꾸는 순간 그것이
/// 통째로 갈 곳을 잃는다 — 새 홈은 비어 있고, 그 비어 있음은 오류로 나타나지 않는다.
///
/// 둘이 동시에 서는 근거는 홈이 갈려서가 아니라 **이름이 갈려서**다: 제어 소켓은
/// `<home>/<identifier>.sock` 이라 identifier 가 다르면 이미 다른 파일이다.
pub fn home_suffix_for_identifier(identifier: &str) -> String {
    let (_, env) = axes_of_identifier(identifier);
    if is_release_env(&env) {
        String::new()
    } else {
        format!("-{env}")
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

    /// 픽스처가 오라클이다 — 이 파일 하나를 JS 쪽 검사도 읽는다. 규칙이 두 벌이면 같은
    /// identifier 가 프로세스마다 다른 홈을 답하고, 그 어긋남은 "내 데이터가 안 보인다"로
    /// 나타난다(오류가 아니다).
    #[test]
    fn the_fixture_binds_both_implementations() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/identity.json")).expect("픽스처");
        assert_eq!(doc["product"].as_str(), Some(PRODUCT));
        let cases = doc["cases"].as_array().expect("cases");
        assert!(!cases.is_empty(), "픽스처가 비었다 — 판정할 수 없다");
        for c in cases {
            let id = c["identifier"].as_str().unwrap();
            let why = c["why"].as_str().unwrap_or("");
            assert_eq!(
                framework_for_identifier(id).as_deref(),
                c["framework"].as_str(),
                "{id}: framework — {why}"
            );
            assert_eq!(core_build_for_identifier(id), c["coreBuild"].as_str().unwrap(), "{id}: coreBuild");
            assert_eq!(home_suffix_for_identifier(id), c["homeSuffix"].as_str().unwrap(), "{id}: homeSuffix");
            assert_eq!(product_name_for_identifier(id), c["productName"].as_str().unwrap(), "{id}: productName");
            assert_eq!(cli_for_identifier(id), c["cli"].as_str().unwrap(), "{id}: cli");
        }
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

    /// 소켓 자리는 홈과 identifier 둘 다에서 나온다 — 한쪽만 갈려도 다른 파일이 된다.
    #[test]
    fn the_control_socket_sits_in_the_home_named_by_the_identifier() {
        let id = Identity::new("/home/max/.soksak-dev", "com.soksak.dev");
        assert_eq!(
            id.control_socket(),
            PathBuf::from("/home/max/.soksak-dev/com.soksak.dev.sock")
        );
        // 두 identity 는 두 소켓이다(같은 자리를 쓰면 나중 것이 앞 것을 거절한다).
        assert_ne!(
            Identity::new("/home/max/.soksak", "com.soksak.app").control_socket(),
            id.control_socket()
        );
    }


    /// 전용 저장소는 설치 트리와 **다른 자리**다 — 같은 자리로 파생하면 플러그인 제거가
    /// 데이터까지 지운다(재설치 시 보존 결정이 조용히 깨진다).
    #[test]
    fn the_plugin_store_sits_beside_the_install_tree_not_inside_it() {
        let id = Identity::new("/u/max/.soksak-dev", "com.soksak.dev");
        assert_eq!(
            id.plugin_data_dir(),
            PathBuf::from("/u/max/.soksak-dev/plugins-data")
        );
        assert_ne!(id.plugin_data_dir(), id.plugins_dir());
        assert!(!id.plugin_data_dir().starts_with(id.plugins_dir()));
        // 자유 함수와 메서드가 같은 규칙이다 — 정체성을 아직 못 모은 자리도 같은 곳을 본다.
        assert_eq!(
            id.plugin_data_dir(),
            plugin_data_dir(Path::new("/u/max/.soksak-dev"))
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
