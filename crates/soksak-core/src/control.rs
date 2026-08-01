//! 제어면 — 밖에서 온 한 줄을 "어느 창이 실행하는가"로 바꾼다.
//!
//! **여기가 그 규칙의 유일한 자리다.** Tauri 는 이것을 직접 링크하고, cored 는 링크해서 소켓
//! 뒤에 세우고, Node 프레임워크는 cored 에 물어 배달만 한다. 어느 쪽도 규칙을 다시 쓰지 않는다.
//!
//! 규칙을 두 벌로 쓰면 같은 하니스가 프레임워크마다 다른 창에서 명령을 돌린다. 그 차이는
//! 오류가 아니라 "엉뚱한 창이 반응함"으로 나타난다 — 그리고 그것은 아무 로그도 안 남긴다.

use serde::Deserialize;
use serde_json::Value;

/// 밖에서 온 한 줄 — 봉투는 **계약 크레이트가 소유한다**.
///
/// 여기서 필드를 다시 적으면 그 목록이 두 번째 계약이 된다. serde 는 모르는 키를 버리므로
/// 한쪽에만 있는 필드는 실패가 아니라 **소멸**한다(실측 2026-08-01: `parent` 가 그렇게 사라져
/// cored 를 지나는 요청에는 실리지 않았다). 이 자리가 안 읽는 필드도 없어진 것은 아니다.
pub use soksak_spec_socket::RequestEnvelope as Request;

/// 배달 봉투 — 창 가진 쪽으로 미는 한 줄. **만드는 자리는 이 함수 하나다.**
///
/// 리터럴로 적으면 필드를 빠뜨려도 아무 오류가 안 난다: 받는 쪽 serde 가 없는 키를 그냥 안
/// 채우고, 그 값은 실패가 아니라 **소멸**한다. 실측(2026-08-01) — 배달 봉투가 5키였고 요청
/// 봉투는 10키라, `sok --parent` 로 온 상관 id 가 cored 를 지나는 순간 사라졌다. 창에서 돌던
/// 명령은 성공했고 활동 원장에만 부모가 없었다.
///
/// `window` 는 요청의 것이 아니라 **해소된 타겟**이다 — 생략된 요청도 여기서는 이름을 갖는다.
pub fn deliver_envelope(id: u64, req: &Request, target: &str) -> Value {
    serde_json::json!({
        "deliver": {
            "id": id,
            "method": req.method,
            "params": req.params,
            "pane": req.pane,
            "window": target,
            "parent": req.parent,
            "origin": req.origin,
            "timeoutMs": req.timeout_ms,
            "idempotencyKey": req.idempotency_key,
        }
    })
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

/// 컨트롤 플레인 창의 라벨 — 플랫폼 예약어다(NAMING §1-4b). 라벨에서 역할을 파싱하는 것이
/// 아니라 **예약어와 비교**한다.
pub const CONTROL_PLANE_LABEL: &str = "main";

/// 포커스 장부 — "지금 포커스된 창"과 "마지막으로 포커스된 워크스페이스 창".
///
/// 이 둘은 `resolve_target` 의 입력이고, **어떻게 갱신되는가**도 규칙이다: 컨트롤 플레인
/// 포커스는 워크스페이스 기억을 지우지 않는다(자연어 콘솔에서 명령을 칠 때 활성 창은 main
/// 이지만 사용자가 일하던 무대는 그 워크스페이스다). 이 갱신 규칙이 프로세스마다 따로 쓰이면
/// 같은 조작에 대해 앱과 헬퍼가 다른 창을 고르고, 그 어긋남은 오류가 아니라 **오답**이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FocusLedger {
    focused: String,
    last_workspace: Option<String>,
}

impl Default for FocusLedger {
    fn default() -> Self {
        FocusLedger { focused: CONTROL_PLANE_LABEL.to_string(), last_workspace: None }
    }
}

impl FocusLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn focused(&self) -> &str {
        &self.focused
    }

    pub fn last_workspace(&self) -> Option<&str> {
        self.last_workspace.as_deref()
    }

    /// 이 창이 포커스를 받았다.
    pub fn note_focus(&mut self, label: &str) {
        self.focused = label.to_string();
        if label != CONTROL_PLANE_LABEL {
            self.last_workspace = Some(label.to_string());
        }
    }

    /// 이 창이 사라졌다. 기록은 창을 소유하지 않는다 — 죽은 라벨을 계속 쥐면 창을 생략한
    /// 다음 명령이 그리로 가고 WINDOW_NOT_FOUND 로 끝난다.
    pub fn note_closed(&mut self, label: &str) {
        if self.focused == label {
            self.focused = CONTROL_PLANE_LABEL.to_string();
        }
        if self.last_workspace.as_deref() == Some(label) {
            self.last_workspace = None;
        }
    }

    /// 살아 있는 창 목록과 맞춘다 — 사건을 못 본 프로세스(창을 남이 소유한 쪽)를 위한 자리.
    /// 사건을 하나 놓쳐도 다음 보고에서 낫는다: 지우는 일이 **멱등**이라야 그렇다.
    pub fn reconcile(&mut self, live: &[String]) {
        if !live.iter().any(|l| l == &self.focused) {
            self.focused = CONTROL_PLANE_LABEL.to_string();
        }
        if let Some(w) = self.last_workspace.clone() {
            if !live.iter().any(|l| l == &w) {
                self.last_workspace = None;
            }
        }
    }
}

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

#[cfg(test)]
mod focus_ledger_tests {
    use super::*;

    /// 컨트롤 플레인 포커스가 워크스페이스 기억을 지우면, 자연어 콘솔에서 친 plugin 명령이
    /// 갈 곳을 잃는다 — 사용자는 그 워크스페이스를 보고 있는데.
    #[test]
    fn focusing_the_control_plane_keeps_the_workspace_memory() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.note_focus(CONTROL_PLANE_LABEL);
        assert_eq!(l.focused(), "main");
        assert_eq!(l.last_workspace(), Some("w-1"));
    }

    #[test]
    fn a_closed_window_is_released_by_both_records() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.note_closed("w-1");
        assert_eq!(l.focused(), "main");
        assert_eq!(l.last_workspace(), None);
    }

    #[test]
    fn closing_someone_else_changes_nothing() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.note_closed("w-2");
        assert_eq!(l.focused(), "w-1");
        assert_eq!(l.last_workspace(), Some("w-1"));
    }

    /// 사건을 못 본 프로세스도 목록 하나로 낫는다 — 그리고 두 번 맞춰도 같다(멱등).
    #[test]
    fn reconciling_with_the_live_list_releases_dead_labels() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.reconcile(&["main".to_string()]);
        assert_eq!(l.focused(), "main");
        assert_eq!(l.last_workspace(), None);
        let once = l.clone();
        l.reconcile(&["main".to_string()]);
        assert_eq!(l, once, "맞추는 일은 멱등이다");
    }

    #[test]
    fn a_live_label_survives_reconciling() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.reconcile(&["main".to_string(), "w-1".to_string()]);
        assert_eq!(l.focused(), "w-1");
        assert_eq!(l.last_workspace(), Some("w-1"));
    }

    /// 장부가 그대로 규칙의 입력이다 — 두 조각을 따로 쥐면 짝이 어긋난 채로 고른다.
    #[test]
    fn the_ledger_feeds_the_rule() {
        let mut l = FocusLedger::new();
        l.note_focus("w-1");
        l.note_focus(CONTROL_PLANE_LABEL);
        let live = vec!["main".to_string(), "w-1".to_string()];
        assert_eq!(resolve_target("plugin.x", l.focused(), l.last_workspace(), &live).unwrap(), "w-1");
        assert_eq!(resolve_target("state.tree", l.focused(), l.last_workspace(), &live).unwrap(), "main");
    }
}
