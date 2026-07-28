//! AI 에이전트 세션 파일의 식별·파싱.
//!
//! 세션 파일 포맷(실측):
//!   claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — 줄마다 "sessionId", "cwd" 는 있는 줄에.
//!   codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — 첫 줄 type="session_meta"
//!           의 payload.{id, cwd}.
//!
//! 순수 파싱과 디렉터리 관찰만 한다. 홈은 **인자로 온다**(claude_session_dir(home, cwd)) —
//! 여기서 env 를 읽으면 프로세스가 갈릴 때 조용히 다른 답을 낸다.
//!
//! sessionId 는 화이트리스트 포맷(UUID)만 통과시킨다 — 위조 history 로 공격자가 세션을
//! resume 시키는 것을 차단한다.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionInfo {
    pub kind: AgentKind,
    pub session_id: String,
    pub cwd: String,
}

// sessionId 화이트리스트 — UUID 포맷(36자, 하이픈 8-13-18-23, 나머지 hex). v4/v7 모두 충족.
// 임의 문자열을 sessionId 로 받아 doc 에 조립하면 위조 history 로 공격자 resume 이 가능해진다(R9) →
// 엄격 포맷만 통과. 이 검사를 통과 못 한 값은 추적·resume 양쪽에서 거부한다.
pub fn is_valid_session_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != b'-' {
                    return false;
                }
            }
            _ => {
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

// 터미널 명령이 추적 대상 에이전트인가 — commandLine 첫 토큰의 basename 이 claude/codex.
// 경로 실행("/usr/local/bin/claude")·인자 동반("codex --model …")도 잡는다. 그 외는 None.
pub fn detect_agent(command_line: &str) -> Option<AgentKind> {
    let first = command_line.split_whitespace().next()?;
    let bin = first.rsplit('/').next().unwrap_or(first);
    match bin {
        "claude" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        _ => None,
    }
}

// claude 세션 jsonl 내용 → SessionInfo. sessionId(유효 포맷)와 cwd 를 각각 처음 나오는 줄에서 취한다.
// 깨진 줄(tail 중간 truncation 등)은 건너뛴다. 둘 다 못 찾으면 None.
pub fn parse_claude(content: &str) -> Option<SessionInfo> {
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if session_id.is_none() {
            if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                if is_valid_session_id(s) {
                    session_id = Some(s.to_string());
                }
            }
        }
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if session_id.is_some() && cwd.is_some() {
            break;
        }
    }
    Some(SessionInfo {
        kind: AgentKind::Claude,
        session_id: session_id?,
        cwd: cwd?,
    })
}

// codex 세션 jsonl 내용 → SessionInfo. 첫 type="session_meta" 줄의 payload.{id, cwd}.
pub fn parse_codex(content: &str) -> Option<SessionInfo> {
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            continue;
        }
        let p = v.get("payload")?;
        let id = p
            .get("id")
            .and_then(|x| x.as_str())
            .filter(|s| is_valid_session_id(s))?;
        let cwd = p
            .get("cwd")
            .and_then(|x| x.as_str())
            .filter(|c| !c.is_empty())?;
        return Some(SessionInfo {
            kind: AgentKind::Codex,
            session_id: id.to_string(),
            cwd: cwd.to_string(),
        });
    }
    None
}

// kind 에 맞는 파서 디스패치(watcher.rs 가 파일 경로의 디렉토리로 kind 판정 후 호출).
pub fn parse(kind: AgentKind, content: &str) -> Option<SessionInfo> {
    match kind {
        AgentKind::Claude => parse_claude(content),
        AgentKind::Codex => parse_codex(content),
    }
}

// claude 세션 디렉토리 — cwd 의 각 '/'·'.' 를 '-' 로 치환한다(예: /workspace/project →
// -workspace-project, /workspace/soksak/.cache → -workspace-soksak--cache, / → -). 이 디렉토리
// 아래 <sessionId>.jsonl 이 생긴다. 터미널이 이 cwd 에서 claude 를 돌리면 여기 새 파일이 나타난다.
pub fn claude_session_dir(home: &str, cwd: &str) -> PathBuf {
    let enc: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Path::new(home).join(".claude").join("projects").join(enc)
}

// ── 세션 전이 추적(R8 watch — claude 가 분기를 파일에 안 남기므로 우리가 관찰) ──────────
// claude 는 /clear·/resume 분기를 파일 간 링크로 안 남긴다(실측: 49세션 분기링크 0). compact 만 같은
// 파일 compactMetadata. 그래서 viewId 가 claude 실행 중 그 cwd 세션 디렉토리를 watch 하고, 디렉토리
// 스냅샷(sessionId→mtime) 변화로 '지금 쓰이는 세션' 을 잡아 (prev→new) 전이를 우리가 구성한다.

// 세션 디렉토리 스냅샷 — 디렉토리의 <sessionId>.jsonl 들을 sessionId→mtime(ms) 로. watch 콜백이 매
// fs-change 마다 다시 찍어 직전 스냅샷과 비교한다.
pub fn snapshot_dir(dir: &Path) -> std::collections::BTreeMap<String, i64> {
    let mut snap = std::collections::BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return snap;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_session_id(stem) {
            continue; // 파일명이 UUID(sessionId)인 것만 — 위조/잡파일 배제(R9)
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        snap.insert(stem.to_string(), mtime);
    }
    snap
}

// prev→cur 스냅샷에서 '지금 쓰이는 세션' = 새로 생기거나 mtime 이 증가한 것 중 가장 최근(claude 가 방금
// 쓴 세션). 변화 없으면 None. 이게 viewId 의 현재 세션이고, 직전 현재 세션과 다르면 전이다.
pub fn active_session(
    prev: &std::collections::BTreeMap<String, i64>,
    cur: &std::collections::BTreeMap<String, i64>,
) -> Option<String> {
    let mut best: Option<(i64, String)> = None;
    for (sid, &m) in cur {
        let changed = prev.get(sid).is_none_or(|&pm| m > pm);
        if changed && best.as_ref().is_none_or(|(bm, _)| m > *bm) {
            best = Some((m, sid.clone()));
        }
    }
    best.map(|(_, s)| s)
}

// 디렉토리에서 가장 최근(mtime) .jsonl 경로. 없으면 None.
pub fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(m) = entry.metadata().and_then(|md| md.modified()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(t, _)| m > *t) {
            newest = Some((m, path));
        }
    }
    newest.map(|(_, p)| p)
}

// ── 전이 추적 상태(watch 구동 — 폴링 아님, notify fs-change 이벤트가 호출) ─────────────
// dir(세션 디렉토리)별 직전 스냅샷을 들고, 프론트가 fs-change 이벤트를 받을 때마다 active(dir) 를 호출하면

/// 주어진 홈·cwd 의 claude 세션 디렉터리에서 가장 최근 세션을 읽는다.
///
/// 홈은 **인자로 온다**. 여기서 env 를 읽으면 프로세스가 갈릴 때 같은 cwd 가 다른 세션을
/// 가리키고, 그 오답은 조용하다(없는 세션을 "없음"으로 답할 뿐 오류가 아니다).
pub fn find_newest_session(home: &str, cwd: &str) -> Result<Option<SessionInfo>, String> {
    if cwd.is_empty() {
        return Ok(None);
    }
    let dir = claude_session_dir(home, cwd);
    if !dir.is_dir() {
        return Ok(None);
    }
    let Some(path) = newest_jsonl(&dir) else {
        return Ok(None);
    };
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let head: String = content.chars().take(HEAD_CHARS).collect();
    Ok(parse(AgentKind::Claude, &head))
}

/// 헤더로 읽을 만큼 — sessionId·cwd 는 파일 앞에 있다(전체 재파싱 금지).
const HEAD_CHARS: usize = 65536;

/// 세션 파일 하나를 식별한다 — 경로가 세션 디렉터리 안일 때만 읽는다.
///
/// 판정은 부분문자열이 아니라 **경로 컴포넌트**로 한다. 문자열 포함은 그 문자열을 어디에
/// 넣어도 통과하고("x .claude_projects_ y"), 세션 디렉터리를 지난 뒤 ".." 로 빠져나가는
/// 것도 막지 못한다. 이 판정이 없으면 이 함수는 임의 파일 읽기 프리미티브다.
pub fn inspect(path: &Path) -> Result<Option<SessionInfo>, String> {
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("경로에 '..'를 사용할 수 없습니다 — 세션 경로 밖 읽기 거부".to_string());
    }
    let parts: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(x) => Some(x.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let has_pair = |a: &str, b: &str| parts.windows(2).any(|w| w[0] == a && w[1] == b);
    let is_codex = has_pair(".codex", "sessions");
    let is_claude = has_pair(".claude", "projects");
    if !is_codex && !is_claude {
        return Err("claude/codex 세션 경로가 아님 — 임의 파일 읽기 거부".to_string());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let head: String = content.chars().take(HEAD_CHARS).collect();
    let kind = if is_codex {
        AgentKind::Codex
    } else {
        AgentKind::Claude
    };
    Ok(parse(kind, &head))
}

#[cfg(test)]
mod find_tests {
    use super::*;

    #[test]
    fn an_empty_cwd_finds_nothing() {
        assert_eq!(find_newest_session("/u/max", "").unwrap(), None);
    }

    #[test]
    fn a_missing_session_dir_finds_nothing() {
        assert_eq!(
            find_newest_session("/nonexistent-home-xyz", "/tmp/whatever").unwrap(),
            None
        );
    }

    #[test]
    fn the_answer_follows_the_home_it_is_given() {
        // 홈이 인자라는 것의 요점 — 두 홈이면 두 디렉터리를 본다.
        assert_ne!(
            claude_session_dir("/home/a", "/w/x"),
            claude_session_dir("/home/b", "/w/x")
        );
    }
}
