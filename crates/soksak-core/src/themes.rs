//! 외부 테마 디렉터리 훑기 — 디렉터리는 **인자로 온다**.
//!
//! 테마는 외부에서 만들어져 홈 아래 `themes/*.json` 으로 들어온다. 검증은 프론트 테마
//! 엔진(단일 진실)이 하고 여기는 파일 입출력만 한다.
//!
//! 디렉터리를 홈에서 스스로 구하면 그 순간 "이 프로세스가 앱이다"가 답의 일부가 된다.
//! 받아 쓰면 앱이든 cored 든 같은 디렉터리에 같은 답을 낸다.

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

pub fn scan(dir: &Path) -> Result<Vec<ThemeFile>, String> {
    let mut out = Vec::new();
    let Some(entries) = read_dir_or_empty(dir)? else {
        return Ok(out);
    };
    for entry in entries {
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

/// 외부 경로의 테마 파일 하나를 `dir` 로 설치한다. 답은 설치된 경로다.
///
/// 동명 파일은 덮어쓴다 — 같은 이름의 테마를 다시 설치하는 것이 **갱신**이기 때문이다.
///
/// 목적지는 **이 함수가 만든다**. 훑기와 부작용이 갈리는 자리가 여기다: 읽기는 없는
/// 디렉터리를 보고 빈 목록을 답할 뿐 디스크를 만들지 않고(부재는 만들 이유가 아니다),
/// 쓰기는 쓸 곳이 있어야 하므로 자기 목적지를 만든다. 이 부작용을 부르는 쪽에 두면
/// 앱은 만들고 cored 는 안 만드는 식으로 프로세스마다 갈리는데, 그 차이는 답에 안 실린다.
pub fn install(dir: &Path, path: &str) -> Result<String, String> {
    let src = Path::new(path);
    if src.extension().is_none_or(|e| e != "json") {
        return Err("테마 파일은 .json 이어야 함".into());
    }
    let name = src
        .file_name()
        .ok_or("파일명 없음")?
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dst = dir.join(&name);
    std::fs::copy(src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-core-themes-{name}-{}",
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
    fn absence_and_unreadable_stay_different_answers() {
        // 원칙은 그대로다: "테마가 없다"와 "디렉터리를 못 읽었다"가 같아지면 안 된다.
        // 경계만 옮겼다 — 부재는 전자이고(빈 목록), 읽기 실패는 후자다(사유를 단 오류).
        let missing = std::env::temp_dir().join("soksak-core-themes-absent-xyz");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(scan(&missing).unwrap().len(), 0, "부재 = 설치된 테마 없음");

        let not_a_dir = std::env::temp_dir().join("soksak-core-themes-file-xyz");
        std::fs::write(&not_a_dir, b"x").unwrap();
        assert!(scan(&not_a_dir).is_err(), "못 읽음은 여전히 오류다");
    }

    #[test]
    fn install_makes_its_destination_and_answers_the_installed_path() {
        let src_dir = test_dir("install-src");
        let dst_dir = test_dir("install-dst");
        // 쓰기는 자기 목적지를 만든다 — 없는 상태에서 시작한다.
        std::fs::remove_dir_all(&dst_dir).unwrap();
        let src = src_dir.join("midnight.json");
        std::fs::write(&src, "{\"name\":\"Midnight\"}").unwrap();

        let dst = install(&dst_dir, src.to_str().unwrap()).unwrap();
        assert_eq!(dst, dst_dir.join("midnight.json").to_string_lossy());
        assert_eq!(
            std::fs::read_to_string(&dst).unwrap(),
            "{\"name\":\"Midnight\"}"
        );
        // 설치한 것을 훑기가 본다.
        assert_eq!(scan(&dst_dir).unwrap().len(), 1);

        // 동명 파일은 갱신이다.
        std::fs::write(&src, "{\"name\":\"Midnight2\"}").unwrap();
        install(&dst_dir, src.to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&dst).unwrap(),
            "{\"name\":\"Midnight2\"}"
        );
        assert_eq!(scan(&dst_dir).unwrap().len(), 1, "덮어썼지 늘리지 않았다");

        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dst_dir);
    }

    #[test]
    fn a_refused_install_does_not_make_the_destination() {
        let src_dir = test_dir("install-ext-src");
        let dst_dir = test_dir("install-ext-dst");
        std::fs::remove_dir_all(&dst_dir).unwrap();
        let src = src_dir.join("theme.txt");
        std::fs::write(&src, "not a theme").unwrap();

        assert_eq!(
            install(&dst_dir, src.to_str().unwrap()),
            Err("테마 파일은 .json 이어야 함".into())
        );
        assert!(!dst_dir.exists(), "거절해 놓고 목적지를 만들었다");

        // 없는 원본은 복사 실패다 — 검증을 지난 뒤라 목적지는 생긴다.
        assert!(install(&dst_dir, src_dir.join("ghost.json").to_str().unwrap()).is_err());

        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dst_dir);
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

