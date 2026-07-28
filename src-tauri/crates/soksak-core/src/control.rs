//! 제어면 — 밖에서 온 한 줄을 "어느 창이 실행하는가"로 바꾼다.
//!
//! **여기가 그 규칙의 유일한 자리다.** Tauri 는 이것을 직접 링크하고, cored 는 링크해서 소켓
//! 뒤에 세우고, Node 프레임워크는 cored 에 물어 배달만 한다. 어느 쪽도 규칙을 다시 쓰지 않는다.
//!
//! 규칙을 두 벌로 쓰면 같은 하니스가 프레임워크마다 다른 창에서 명령을 돌린다. 그 차이는
//! 오류가 아니라 "엉뚱한 창이 반응함"으로 나타난다 — 그리고 그것은 아무 로그도 안 남긴다.

use serde::Deserialize;
use serde_json::Value;

/// 밖에서 온 한 줄. 필드 이름은 하니스가 보내는 그대로다.
#[derive(Debug, Deserialize, Default)]
pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub pane: Option<String>,
    /// 타겟 창 label. 생략하면 아래 규칙이 고른다.
    pub window: Option<String>,
    /// 회신 대기 상한(ms). 생략은 호출자가 기본을 쓴다는 뜻이다.
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

/// 타겟을 못 고른 이유 — 셋은 서로 다른 사실이다.
#[derive(Debug, PartialEq, Eq)]
pub enum NoTarget {
    /// 창이 하나도 없다.
    NoWindow,
    /// 워크스페이스 창이 없다(컨트롤 플레인만 있다). plugin.* 이 여기서 막힌다.
    NoWorkspace,
    /// 워크스페이스가 둘 이상이고 고를 근거가 없다. 아무 창에나 보내면 남의 창에서 명령이
    /// 돌고 성공을 답한다 — 그 오답은 오류로 보이지 않는다.
    Ambiguous(Vec<String>),
}

impl NoTarget {
    pub fn code(&self) -> &'static str {
        match self {
            NoTarget::NoWindow => "NO_WINDOW",
            NoTarget::NoWorkspace => "NO_WORKSPACE",
            NoTarget::Ambiguous(_) => "AMBIGUOUS_WINDOW",
        }
    }
}

/// 워크스페이스 창의 접두사 — 컨트롤 플레인("main")과 가르는 유일한 표식이다.
pub const WORKSPACE_PREFIX: &str = "w-";

/// 어느 창이 이 명령을 실행하는가.
///
/// `plugin.` 접두는 워크스페이스 창의 것이다 — 컨트롤 플레인에는 플러그인 호스트가 없어
/// 거기로 보내면 상한까지 기다리고, 그 침묵은 "명령이 없다"와 구분되지 않는다.
pub fn resolve_target(
    method: &str,
    focused: &str,
    last_workspace: Option<&str>,
    live: &[String],
) -> Result<String, NoTarget> {
    let mut workspaces: Vec<&String> =
        live.iter().filter(|l| l.starts_with(WORKSPACE_PREFIX)).collect();
    // 정렬은 결정성을 위해서다 — 모호 목록이 호출마다 뒤바뀌면 같은 상황에 다른 메시지가 나간다.
    workspaces.sort();
    let sole = if workspaces.len() == 1 { Some(workspaces[0].clone()) } else { None };
    let ambiguous = || NoTarget::Ambiguous(workspaces.iter().map(|w| (*w).clone()).collect());

    if !method.starts_with("plugin.") {
        if live.iter().any(|l| l == focused) {
            return Ok(focused.to_string());
        }
        if live.iter().any(|l| l == "main") {
            return Ok("main".to_string());
        }
        return match sole {
            Some(w) => Ok(w),
            None if workspaces.is_empty() => Err(NoTarget::NoWindow),
            None => Err(ambiguous()),
        };
    }

    if let Some(w) = last_workspace {
        if workspaces.iter().any(|l| l.as_str() == w) {
            return Ok(w.to_string());
        }
    }
    match sole {
        Some(w) => Ok(w),
        None if workspaces.is_empty() => Err(NoTarget::NoWorkspace),
        None => Err(ambiguous()),
    }
}

/// 한 줄을 요청으로 읽는다. 깨진 줄은 연결을 끊지 않고 사유를 답한다 — 끊으면 부른 쪽이
/// "앱이 죽었다"로 읽는다.
pub fn parse(line: &str) -> Result<Request, String> {
    let req: Request =
        serde_json::from_str(line).map_err(|e| format!("JSON 파싱 실패: {e}"))?;
    if req.method.is_empty() {
        return Err("method 가 필요하다".to_string());
    }
    Ok(req)
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
