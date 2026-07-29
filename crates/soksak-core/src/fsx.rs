//! 파일 읽기·쓰기 — 경로도 홈도 **인자로 온다**.
//!
//! 이 모듈이 보는 홈은 **OS 사용자 홈**(`~`)이지 정체성 홈(`~/.soksak-dev`)이 아니다. 둘은
//! 다른 값이고, 파일 트리의 기본 뿌리와 `~` 확장이 보는 것은 전자다. 그래서 여기 있는
//! 함수는 `Identity` 가 아니라 사용자 홈을 받는다 — `Identity` 를 받으면 그 안의 홈이
//! 사용자 홈인 줄 알고 쓰게 되고, 그러면 트리가 `~/.soksak-dev` 아래에서 시작한다.
//! 예외는 `ensure_project_dir` 하나다: 앱이 만든 폴더는 앱 관리 영역에 살아야 하므로 그것만
//! 정체성 홈을 받는다.
//!
//! 심링크·`..` 검사(`path_security`)는 여기 없다. 그 검사는 **우리 트리에 파일을 실체화하는**
//! 설치자 계열의 것이다(심어 둔 링크가 쓰기를 딴 데로 돌리는 위협). 이쪽은 사용자가 자기
//! 디스크를 훑는 표면이라, 링크를 거부하면 심링크된 작업 폴더를 가진 트리가 통째로 안 열린다.
//! 검사를 여기 붙이면 그건 이식이 아니라 앱과 cored 가 다른 답을 내는 새 결함이다.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::identity::Identity;
use crate::pathx;

/// 홈이 필요한 호출에 홈이 없을 때의 사유. 추측 대신 이름을 달고 실패한다 — 자기 환경의
/// 홈을 읽으면 프로세스마다 다른 트리를 훑고, 그 오답은 오류가 아니라 다른 목록으로 나타난다.
const NO_USER_HOME: &str =
    "이 호출은 사용자 홈이 필요한데 이 프로세스는 받지 못했습니다 — 띄울 때 --user-home 을 주세요";

/// 사용자 홈 — 없을 수 있다. `Option` 인 이유는 홈을 못 받은 프로세스도 절대경로 호출은
/// 그대로 답해야 하기 때문이다(못 하는 것 하나가 나머지를 막지 않는다).
type UserHome<'a> = Option<&'a Path>;

fn require_home(home: UserHome<'_>) -> Result<&Path, String> {
    home.ok_or_else(|| NO_USER_HOME.to_string())
}

/// 선행 `~` 확장 — 홈이 실제로 필요할 때만 요구한다. `~` 가 없는 경로는 홈 없이도 푼다.
fn expand(path: &str, home: UserHome<'_>) -> Result<PathBuf, String> {
    if path == "~" || path.starts_with("~/") {
        return Ok(pathx::expand_tilde(path, require_home(home)?));
    }
    Ok(PathBuf::from(path))
}

// ── 텍스트 읽기 ──────────────────────────────────────────────────────────────

/// 텍스트 로드 상한. editor 의 LARGE_FILE_HEAP_OPERATION_THRESHOLD(256MiB, ~512MB 메모리)와
/// 같은 숫자. 크기로 "열기"를 막지 않고 전체를 보되, 이 상한을 넘으면 앞부분만 읽고
/// truncated 로 알린다(webview/IPC OOM 방지).
const TEXT_READ_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct TextData {
    pub content: String,
    pub truncated: bool,
    pub read_bytes: u64,
    pub total_bytes: u64,
    /// 읽은 구간의 줄 수(editor 의 30만 줄 토큰화 임계 판단용).
    pub line_count: u64,
}

/// 파일을 텍스트로 읽는다. 큰 파일은 앞 `TEXT_READ_LIMIT` 바이트만(truncated=true). 바이너리는
/// NUL 바이트 유무로 판정(텍스트엔 NUL 이 없다) 후 에러 → 프론트가 폴백 분기.
///
/// `offset`: 지정 시 그 바이트부터 끝까지만 — 증가하는 로그/JSONL 의 증분 tail. `total_bytes`
/// 를 다음 offset 으로 추적하면 델타만 읽는다(폴링 아님 + O(delta)). offset 이 현재 크기보다
/// 크면(파일 축소·교체) 빈 내용 + 실제 total 을 돌려 프론트가 전체 재독을 판단한다.
pub fn read_text_file(
    path: &str,
    offset: Option<u64>,
    user_home: UserHome<'_>,
) -> Result<TextData, String> {
    use std::io::{Read, Seek, SeekFrom};
    let real = expand(path, user_home)?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아님".to_string());
    }
    let total = meta.len();
    let start = offset.unwrap_or(0).min(total);
    let mut f = std::fs::File::open(&real).map_err(|e| e.to_string())?;
    if start > 0 {
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::new();
    f.take(TEXT_READ_LIMIT)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.contains(&0) {
        return Err("바이너리 파일".to_string());
    }
    let read_bytes = buf.len() as u64;
    let line_count = buf.iter().filter(|&&b| b == b'\n').count() as u64;
    Ok(TextData {
        // 잘린 멀티바이트 문자/드문 비 UTF-8 바이트는 lossy 로 안전 처리.
        content: String::from_utf8_lossy(&buf).into_owned(),
        truncated: total > start + read_bytes,
        read_bytes,
        total_bytes: total,
        line_count,
    })
}

// ── 바이너리 미리보기 ────────────────────────────────────────────────────────

/// 미리보기(이미지/PDF/비디오/오디오) 최대 크기. 초과하면 메모리/IPC 부담 방지로 에러.
const MAX_PREVIEW_BYTES: u64 = 40_000_000;

#[derive(Debug, Serialize)]
pub struct FileData {
    pub mime: String,
    pub base64: String,
}

/// 확장자 → MIME. 미리보기 가능한 바이너리 위주. 미지정은 octet-stream.
fn mime_for(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let m = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    };
    m.to_string()
}

/// 파일을 읽어 base64 + MIME 로 반환(프론트가 data URL 로 렌더). asset 프로토콜 스코프/
/// 재시작 변수에 의존하지 않는 경로 — 미리보기를 신뢰성 있게 보장한다.
///
/// `~` 를 풀지 않는다. 미리보기는 트리가 이미 해소한 절대경로로 부르는 자리라 홈이 필요
/// 없었고, 여기서 확장을 새로 붙이면 앱과 cored 가 아니라 **어제와 오늘**이 갈린다.
pub fn read_file_base64(path: &str) -> Result<FileData, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아님".to_string());
    }
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!("미리보기 한도 초과: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(FileData {
        mime: mime_for(path),
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────────

/// 파일 저장(에디터 편집 내용). 텍스트를 그대로 덮어쓴다.
///
/// **잠그지 않는다.** 저장소 쓰기(`data_kv_set`)가 잠금을 요구하는 이유는 app.data 가 우리가
/// 소유한 한 파일이고 단일 쓰기자가 그 파일의 불변식이기 때문이다. 여기 파일은 호출자가
/// 이름을 대는 남의 파일이라 우리가 지킬 불변식이 없다: 이 트리는 이미 편집기·git·빌드가
/// 함께 쓰는 곳이고, 그 집합은 처음부터 하나였던 적이 없다.
///
/// 저장소 잠금을 이 명령에 끼우는 것은 틀린 결합이다 — app.data 의 소유권은 사용자의
/// `notes.txt` 에 대해 아무 말도 하지 않는데, 그 잠금으로 거절하면 이 파일과 무관한 사실을
/// 근거로 저장을 막는 셈이 된다. 파일별 잠금도 답이 아니다: 앱 경로에는 없으니 같은 호출이
/// 프로세스마다 다르게 실패하고, 진짜 경쟁 상대(사용자의 편집기)는 그 잠금을 보지 않는다.
///
/// 그래서 규칙은 OS 의 것 그대로다 — 파일 단위로 마지막 쓰기가 남는다.
pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

// ── 디렉터리 나열 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ChildListing {
    /// 실제로 해석된 절대경로(path 가 없으면 사용자 홈).
    pub root: String,
    pub children: Vec<Child>,
}

#[derive(Debug, Serialize)]
pub struct Child {
    pub name: String,
    pub dir: bool,
    /// 수정시각(unix 초). meta=true 일 때만 채운다(평상시 트리는 stat 회피 — TCC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
}

/// 한 디렉터리의 직속 자식만(재귀 X). path 가 없거나 비면 사용자 홈. lazy 트리의 단위 —
/// 거대 디렉터리도 펼치기 전엔 한 read_dir 만 하므로 폭주하지 않는다.
///
/// `meta=Some(true)`: 각 자식의 수정시각(unix 초)도 함께. 기본은 stat 회피(TCC).
pub fn list_children(
    path: Option<&str>,
    meta: Option<bool>,
    user_home: UserHome<'_>,
) -> Result<ChildListing, String> {
    let root: PathBuf = match path {
        Some(p) if !p.is_empty() => expand(p, user_home)?,
        _ => require_home(user_home)?.to_path_buf(),
    };
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        return Err(format!("디렉토리가 아님: {}", root.to_string_lossy()));
    }
    let want_meta = meta.unwrap_or(false);

    let mut children = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        // dirent 의 file_type 사용(stat 없음) → 보호 폴더(다운로드/데스크탑/문서)를 건드리지
        // 않아 TCC 프롬프트가 불필요하게 뜨지 않는다. 심링크만 대상 종류 확인차 stat.
        let dir = match entry.file_type() {
            Ok(ft) if ft.is_symlink() => entry.path().metadata().map(|m| m.is_dir()).unwrap_or(false),
            Ok(ft) => ft.is_dir(),
            Err(_) => false,
        };
        // mtime 은 명시 요청 시에만(stat 1회). unix epoch 초.
        let modified = if want_meta {
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
        } else {
            None
        };
        children.push(Child { name, dir, modified });
    }
    // 폴더 먼저, 그 다음 이름순(대소문자 무시).
    children.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ChildListing {
        root: root.to_string_lossy().to_string(),
        children,
    })
}

// ── 프로젝트 루트 ────────────────────────────────────────────────────────────

/// 자동 지정 루트(`<정체성 홈>/projects/<폴더명>`) 생성 — 새 프로젝트에서 폴더를 지정하지
/// 않은 경우. 앱이 만든 폴더는 앱 관리 영역에 둔다. 그래서 여기만 `Identity` 를 받는다.
///
/// `folder` 는 디렉터리명 계약 — 슬러그만 허용(탈출/주입 차단).
pub fn ensure_project_dir(folder: &str, identity: &Identity) -> Result<String, String> {
    let valid = !folder.is_empty()
        && folder
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !folder.starts_with('-');
    if !valid {
        return Err(format!(
            "폴더명 형식 위반: \"{folder}\" — ^[a-z0-9][a-z0-9-]*$"
        ));
    }
    let dir = identity.path("projects").join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 프로젝트 루트 검증 — 존재하는 디렉터리이고, 사용자 홈(`~`)과 파일시스템 루트(`/`)가
/// 아니어야 한다(루트 초기화 정책이 루트 전체를 대상으로 동작하므로). 통과 시 정규화
/// 경로 반환 — 중복 비교의 기준.
///
/// `~` 를 풀지 않는다(앱 경로도 풀지 않는다). 홈이 필요한 것은 **판정**뿐이라, 홈을 못 받은
/// 프로세스는 판정을 못 한다고 이름을 달고 말한다 — 홈 검사를 건너뛴 통과는 그 정책이
/// 사용자 전체 파일에 걸리는 문을 조용히 여는 일이다.
pub fn validate_project_root(path: &str, user_home: UserHome<'_>) -> Result<String, String> {
    let home = require_home(user_home)?;
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(format!("디렉토리 아님: {path}"));
    }
    let canon = dir
        .canonicalize()
        .map_err(|e| format!("경로 정규화 실패: {e}"))?;
    // 판정 규칙은 pathx 가 소유한다 — 여기서는 정규화만 한다.
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    pathx::project_root_verdict(&canon, &home)?;
    Ok(canon.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("soksak-core-fsx-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn a_text_file_carries_its_size_and_line_count() {
        let dir = test_dir("read");
        let f = dir.join("a.txt");
        std::fs::write(&f, "one\ntwo\n").unwrap();
        let got = read_text_file(&s(&f), None, None).unwrap();
        assert_eq!(got.content, "one\ntwo\n");
        assert_eq!(got.total_bytes, 8);
        assert_eq!(got.read_bytes, 8);
        assert_eq!(got.line_count, 2);
        assert!(!got.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// offset 은 델타만 읽는다 — 증분 tail 의 축.
    #[test]
    fn an_offset_reads_only_the_delta_and_still_reports_the_whole_size() {
        let dir = test_dir("offset");
        let f = dir.join("log");
        std::fs::write(&f, "aaaa\nbbbb\n").unwrap();
        let got = read_text_file(&s(&f), Some(5), None).unwrap();
        assert_eq!(got.content, "bbbb\n");
        assert_eq!(got.read_bytes, 5);
        assert_eq!(got.total_bytes, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 파일이 줄어들었으면(교체) 빈 내용 + 실제 크기 — 프론트가 전체 재독을 판단한다.
    #[test]
    fn an_offset_past_the_end_reads_empty_with_the_real_size() {
        let dir = test_dir("shrunk");
        let f = dir.join("log");
        std::fs::write(&f, "ab").unwrap();
        let got = read_text_file(&s(&f), Some(99), None).unwrap();
        assert_eq!(got.content, "");
        assert_eq!(got.total_bytes, 2);
        assert!(!got.truncated, "다 읽었다 — 잘린 게 아니다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_binary_file_is_refused_and_a_directory_is_not_a_file() {
        let dir = test_dir("binary");
        let f = dir.join("b.bin");
        std::fs::write(&f, [0u8, 1]).unwrap();
        assert_eq!(read_text_file(&s(&f), None, None).unwrap_err(), "바이너리 파일");
        assert_eq!(read_text_file(&s(&dir), None, None).unwrap_err(), "파일이 아님");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_round_trips_and_a_second_write_replaces_the_whole_file() {
        let dir = test_dir("write");
        let f = dir.join("edit.txt");
        write_text_file(&s(&f), "first\nedit").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "first\nedit");
        // 재저장(⌘S 재호출) → 이전 내용 완전 대체. 짧은 내용으로 덮어 잘림을 잡는다.
        write_text_file(&s(&f), "x").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_preview_carries_the_mime_from_the_extension() {
        let dir = test_dir("b64");
        let f = dir.join("dot.png");
        std::fs::write(&f, [0u8, 1, 2]).unwrap();
        let got = read_file_base64(&s(&f)).unwrap();
        assert_eq!(got.mime, "image/png");
        assert_eq!(got.base64, "AAEC");
        assert_eq!(mime_for("x.unknown"), "application/octet-stream");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn children_are_folders_first_then_case_insensitive_by_name() {
        let dir = test_dir("list");
        std::fs::create_dir_all(dir.join("Zeta")).unwrap();
        std::fs::write(dir.join("apple"), "a").unwrap();
        std::fs::write(dir.join("Banana"), "b").unwrap();
        let got = list_children(Some(&s(&dir)), None, None).unwrap();
        let names: Vec<&str> = got.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Zeta", "apple", "Banana"]);
        assert!(got.children.iter().all(|c| c.modified.is_none()), "기본은 stat 회피");
        let with_meta = list_children(Some(&s(&dir)), Some(true), None).unwrap();
        assert!(with_meta.children.iter().all(|c| c.modified.is_some()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 홈은 인자다 — 같은 입력이 홈에 따라 다른 트리를 낸다. 이것이 이 계약의 요점이다.
    #[test]
    fn the_default_root_and_the_tilde_follow_the_home_they_are_given() {
        let a = test_dir("home-a");
        let b = test_dir("home-b");
        std::fs::write(a.join("only-a"), "x").unwrap();
        std::fs::write(b.join("only-b"), "x").unwrap();

        let from_a = list_children(None, None, Some(&a)).unwrap();
        let from_b = list_children(None, None, Some(&b)).unwrap();
        assert_eq!(from_a.children[0].name, "only-a");
        assert_eq!(from_b.children[0].name, "only-b");

        std::fs::write(a.join("rc"), "in-a").unwrap();
        std::fs::write(b.join("rc"), "in-b").unwrap();
        assert_eq!(read_text_file("~/rc", None, Some(&a)).unwrap().content, "in-a");
        assert_eq!(read_text_file("~/rc", None, Some(&b)).unwrap().content, "in-b");

        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }

    /// 홈이 없으면 홈을 쓰는 호출만 거절한다 — 절대경로는 그대로 답한다.
    #[test]
    fn a_missing_home_refuses_only_the_calls_that_need_it() {
        let dir = test_dir("no-home");
        let f = dir.join("a.txt");
        std::fs::write(&f, "ok").unwrap();

        assert!(read_text_file(&s(&f), None, None).is_ok(), "절대경로는 홈이 필요 없다");
        assert!(list_children(Some(&s(&dir)), None, None).is_ok());
        for err in [
            read_text_file("~/a.txt", None, None).unwrap_err(),
            list_children(None, None, None).unwrap_err(),
            validate_project_root(&s(&dir), None).unwrap_err(),
        ] {
            assert!(err.contains("--user-home"), "무엇을 주면 되는지 말해야 한다: {err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_project_folder_must_be_a_slug_and_lands_under_the_identity_home() {
        let dir = test_dir("project");
        let id = Identity::new(&dir, "com.soksak.dev");
        let made = ensure_project_dir("my-app", &id).unwrap();
        assert_eq!(made, s(&dir.join("projects").join("my-app")));
        assert!(Path::new(&made).is_dir());
        for bad in ["../etc", "My App", "-lead", "", "a/b"] {
            assert!(ensure_project_dir(bad, &id).is_err(), "{bad:?} 를 통과시켰다");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_home_itself_is_not_a_project_root_but_a_folder_under_it_is() {
        let home = test_dir("root-home");
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        assert!(validate_project_root(&s(&home), Some(&home)).is_err());
        let ok = validate_project_root(&s(&work), Some(&home)).unwrap();
        assert_eq!(ok, s(&work.canonicalize().unwrap()));
        // 없는 경로는 디렉터리가 아니다.
        assert!(validate_project_root(&s(&home.join("nope")), Some(&home)).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 심링크는 거부 대상이 아니다 — 이 표면은 사용자가 자기 디스크를 훑는 곳이다.
    /// 설치자 계열의 링크 거부를 여기 옮겨 붙이면 심링크된 작업 폴더가 통째로 안 열린다.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_path_is_read_not_refused() {
        let dir = test_dir("symlink");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("f.txt"), "through").unwrap();
        std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();

        let via_link = dir.join("link").join("f.txt");
        assert_eq!(read_text_file(&s(&via_link), None, None).unwrap().content, "through");
        assert_eq!(list_children(Some(&s(&dir.join("link"))), None, None).unwrap().children.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
