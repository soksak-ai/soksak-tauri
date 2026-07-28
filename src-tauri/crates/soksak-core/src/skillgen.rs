//! 스킬 재생성 방아쇠의 argv — 홈은 **인자로 온다**.
//!
//! 렌더 로직의 단일 진실은 CLI 다. 여기가 소유하는 것은 그 CLI 를 **어떻게 부르는가**뿐이다:
//! 정체성 홈의 `skill-refresh.json`(설치 때 CLI 가 적는다)이 실물을 지목하고, 부르는 모양은
//! `skill refresh` 한 벌이다. 두 프로세스가 각자 이 argv 를 조립하면 언젠가 갈라지고,
//! 갈라진 argv 는 오류가 아니라 **다른 스킬 파일**이다.
//!
//! 스폰은 여기 없다. 프로세스를 띄우는 방식(stdio·수명)은 부르는 쪽의 것이고, 여기 두면
//! 이 크레이트가 "누가 자식을 거두는가"까지 정하게 된다.
//!
//! ## 부재와 고장은 다른 답이다
//!
//! 매니페스트가 없는 홈은 **설치 전**이다 — 재생성할 스킬이 없다는 사실이지 실패가 아니다.
//! 그것을 오류로 답하면 스킬 CLI 를 깔지 않은 홈에서 플러그인을 켤 때마다 실패가 뜬다.
//! 반대로 잘못 적힌 매니페스트를 `None` 으로 접으면 고장이 '설치 전'과 같은 값이 되어,
//! 스킬이 영영 재생성되지 않는데도 아무 데도 남지 않는다. 그래서 셋이 아니라 **셋 다 다른
//! 답**이다: 없음(`None`) · 고장(`Err`) · 부를 것(`Some(argv)`).

use std::path::Path;

/// 매니페스트 파일 이름 — 자리는 홈이 정하고 이름은 여기가 소유한다.
pub const MANIFEST_FILE: &str = "skill-refresh.json";

/// 이 홈의 스킬 재생성 argv `(실행 파일, 인자)`. 매니페스트가 없으면 `None`.
///
/// 매니페스트를 못 읽는 것 전부가 `None` 이다(부재만이 아니다) — 원본의 결정이고, 앱에서든
/// 헬퍼에서든 같은 답이라 프로세스로 갈리지 않는다. 반면 읽히는 매니페스트의 내용이 틀린
/// 것(JSON 이 아니다·`cli` 가 없다)은 사유를 달고 올린다.
pub fn skill_refresh_argv(home: &Path) -> Result<Option<(String, Vec<String>)>, String> {
    let Ok(txt) = std::fs::read_to_string(home.join(MANIFEST_FILE)) else {
        return Ok(None); // 설치 전 — 재생성할 스킬이 없다(오류 아님).
    };
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    let cli = v["cli"].as_str().ok_or("매니페스트에 cli 없음")?;
    // 환경은 바이너리의 정체성(P9) — 매니페스트의 cli 가 이름별 실물이라 환경 전달이 없다.
    Ok(Some((
        cli.to_string(),
        vec!["skill".to_string(), "refresh".to_string()],
    )))
}

#[cfg(test)]
#[path = "skillgen_tests.rs"]
mod skillgen_tests;
