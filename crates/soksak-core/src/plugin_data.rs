//! 플러그인 전용 저장소 — 베이스 디렉터리는 **인자로 온다**.
//!
//! 배치는 `<base>/<id>/<key>.json` 평면 하나다. 값은 JSON 문자열이지만 여기서 해석하지
//! 않는다: 파싱하고 다시 찍으면 저장한 것과 돌려받는 것이 달라지고(키 순서·수 표기),
//! 그 차이는 저장소를 쓰는 플러그인에게만 보인다. 원문을 나른다.
//!
//! 자기 디렉터리 밖 접근은 `id`·`key` 검증이 막는다. 그 검증이 두 벌이면 한쪽에서만 홈
//! 밖이 열리므로, 문자셋은 여기와 [`crate::plugin_dir::sanitize_id`] 한 벌씩만 있다.
//!
//! **읽기는 디스크를 만들지 않는다.** 앱은 자기 홈 배치를 미리 만들어 두지만 cored 는 남의
//! 홈을 읽을 뿐이라 그 부작용을 지지 않는다 — 그리고 만들어 봐야 세 명령의 답이 하나도
//! 달라지지 않는다: 읽기는 `NotFound` 를 "값 없음"으로 가르고, 목록은 `<base>/<id>` 를 보고,
//! 쓰기는 자기가 상위까지 만든다.

use std::path::Path;

use crate::plugin_dir::sanitize_id;

/// 저장소 key = `^[A-Za-z0-9._-]+$`.
///
/// `.` 은 허용 문자지만 `.`·`..` 단독은 경로 의미라 거부한다. `/` 는 문자셋에 없어서
/// 파일명이 디렉터리로 새지 않는다.
pub fn sanitize_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key == "." || key == ".." {
        return Err(format!("잘못된 저장소 key: {key:?}"));
    }
    if key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err(format!("잘못된 저장소 key: {key:?}"))
    }
}

/// 저장된 원문. 없으면 `None` — 미존재는 실패가 아니라 **값 없음**이다(호출자가 기본값으로
/// 갈린다). 다른 읽기 실패는 사유를 달고 올린다: 없는 것과 못 읽은 것이 같은 값이 되면
/// 권한 문제가 "저장한 적 없음"으로 보인다.
pub fn read(base: &Path, id: &str, key: &str) -> Result<Option<String>, String> {
    sanitize_id(id)?;
    sanitize_key(key)?;
    match std::fs::read_to_string(base.join(id).join(format!("{key}.json"))) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 원문을 그대로 쓴다. 상위 디렉터리는 여기서 만든다 — 첫 쓰기가 부팅이 만들어 둔 배치에
/// 기대면, 그 배치를 안 만드는 프로세스에서 같은 명령이 실패한다.
pub fn write(base: &Path, id: &str, key: &str, value: &str) -> Result<(), String> {
    sanitize_id(id)?;
    sanitize_key(key)?;
    let dir = base.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{key}.json")), value).map_err(|e| e.to_string())
}

/// 이 플러그인이 저장한 key 이름들, 사전순. 확장자(`.json`)는 뗀다 — 돌려준 이름이 그대로
/// [`read`] 의 인자라야 목록과 읽기가 같은 것을 가리킨다.
///
/// 디렉터리가 없으면 빈 목록이다. 한 번도 저장한 적 없는 상태이지 실패가 아니다.
pub fn list(base: &Path, id: &str) -> Result<Vec<String>, String> {
    sanitize_id(id)?;
    let dir = base.join(id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
#[path = "plugin_data_tests.rs"]
mod plugin_data_tests;
