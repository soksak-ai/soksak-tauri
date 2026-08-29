// AI 세션 계보(단계⑤) — 터미널에서 실행된 claude/codex 의 세션 파일을 식별·파싱해 (viewId, sessionId,
// kind) 를 잇는다. 우리는 AI agent 특화 터미널이라, 돌던 세션을 복원 후 '이어가기' 할 수 있어야 한다(R9).
//
// 세션 파일 포맷(실측):
//   claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — 줄마다 "sessionId", "cwd" 는 있는 줄에.
//   codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — 첫 줄 type="session_meta"
//           의 payload.{id, cwd}.
//
// 이 모듈은 순수 파싱만(파일 IO·watch 는 watcher.rs 가 offset tail 로 호출). doc 문자열 조립 금지 —
// sessionId 는 화이트리스트 포맷(UUID)만 통과시켜 위조 history→공격자 resume 을 차단한다(R9, blocker high).

use serde_json::Value;
use tauri::State;
// 순수 파싱·디렉터리 관찰은 soksak-core::session 으로 옮겼다. 여기 남은 것은 프레임워크
// 진입점과 관리 상태(SessionTracker)·앰비언트 홈을 쓰는 부분이다.
pub use soksak_core::session::{
    detect_agent, require_cwd, session_dir_for, SessionInfo,
    // 스냅샷 원장도 코어의 것이다 — 프로세스마다 두면 같은 dir 에 서로 다른 "직전"이 생긴다.
    SessionTracker,
};
// 직전과 비교해 '방금 쓰인 세션' 을 돌려준다. 주기 조회 0 — OS 가 파일 변경을 알릴 때만 깬다.

// ── 입구 ─────────────────────────────────────────────────────────────────────
// 세션 루트(홈)는 **인자**다. 프로세스 환경에서 읽으면 같은 코드가 프로세스마다 다른 홈을
// 가리키고, 그것은 거부가 아니라 다른 홈의 세션을 여는 것으로 끝난다 — 조용한 오답이다.
// 아래 `#[tauri::command]` 는 State 를 벗기고 홈을 해소해 넘기는 번역층이다.

/// 이 프로세스의 사용자 홈 — 앰비언트 경계의 이쪽 끝. 여기서만 환경을 읽고 그 아래로는
/// 값이 흐른다(soksak_core::ambient_gate 등재: frameworks/tauri/src/ai_session.rs · HOME).
fn ambient_user_home() -> Result<String, String> {
    std::env::var("HOME").map_err(|e| e.to_string())
}


// ── 점검 커맨드(R0) ──────────────────────────────────────────────────────────

// cwd → claude 세션 디렉토리 경로(프론트가 watch_dir 대상으로 쓴다).
#[tauri::command]
pub fn ai_session_dir(cwd: String) -> Result<String, String> {
    // 규칙을 홈 해소보다 먼저 — 빈 cwd 의 답은 환경과 무관하다.
    require_cwd(&cwd)?;
    session_dir_for(&ambient_user_home()?, &cwd)
}

// fs-change 이벤트 시 호출 — dir 에서 방금 쓰인 세션(직전 대비 새/갱신). 프론트가 직전 활성과 비교해
// 전이를 기록한다. 폴링 아님(notify 이벤트가 구동). 변화 없으면 null.
#[tauri::command]
pub fn ai_session_active(dir: String, tracker: State<'_, SessionTracker>) -> Option<String> {
    tracker.active(&dir)
}

// watch 종료 — dir 스냅샷 폐기.
#[tauri::command]
pub fn ai_session_untrack(dir: String, tracker: State<'_, SessionTracker>) {
    tracker.forget(&dir);
}

// 세션 계보 조회 — cwd(scope)의 전이 레코드를 시간순(created)으로. 각 레코드 = {viewId, fromSession,
// toSession, kind, time}. 시간순 from→to 가 곧 흐름이고, 같은 fromSession 에서 여러 toSession 이면 분기다.
// 저장은 sessionLineage(watch)가, 조회는 app.data 단일 경로(store::query)로 — 단일진실.
#[tauri::command]
pub fn ai_session_lineage(
    cwd: String,
    view_id: Option<String>,
    state: State<'_, crate::data::DbState>,
) -> Result<Vec<Value>, String> {
    require_cwd(&cwd)?; // DB 를 잠그기 전에 — 빈 cwd 의 답은 DB 상태와 무관하다
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB 미초기화")?;
    soksak_store::session_lineage::ai_session_lineage(conn, &cwd, view_id)
}

// ── 식별 커맨드(R0) ──────────────────────────────────────────────────────────

// cwd 로 claude 세션을 on-demand 조회 — 그 cwd 의 세션 디렉토리에서 가장 최근 세션 파일을 식별한다.
// 프론트가 에이전트 명령 turn.ended 시 1회 호출해 블록에 sessionId 를 채운다(상시 watch 대신 on-demand
// = 부하 최소, 폴링 없음). codex 는 date-dir 라 cwd 로 못 좁혀 후속(전체 스캔). 못 찾으면 None.
#[tauri::command]
pub fn ai_session_find(cwd: String) -> Result<Option<SessionInfo>, String> {
    soksak_core::session::find_newest_session(&ambient_user_home()?, &cwd)
}

// 터미널 명령이 추적 대상 에이전트인가 — "claude"/"codex"/null. 프론트가 command.started 의
// commandLine 으로 호출해 블록의 agentKind 를 채운다(sessionId 는 watch 통합 후속).
#[tauri::command]
pub fn ai_session_detect(command_line: String) -> Option<String> {
    detect_agent(&command_line).map(|k| k.as_str().to_string())
}

// 세션 파일 식별 — 경로(claude/codex 세션만 허용)의 헤더를 읽어 SessionInfo. 임의 파일 읽기는 거부
// (세션 디렉토리 경로 외 차단). 헤더(sessionId/cwd)는 파일 앞에 있어 앞부분만 읽는다(전체 재파싱 금지, R8).
#[tauri::command]
pub fn ai_session_inspect(path: String) -> Result<Option<SessionInfo>, String> {
    soksak_core::session::inspect(std::path::Path::new(&path))
}
