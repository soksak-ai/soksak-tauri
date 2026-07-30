//! 터미널 서빙 — 셸은 데몬이 소유하고, 이 프로세스는 그 데몬에 붙는다.
//!
//! 붙는 방식은 **코어의 것**이다(`soksak_core::ptyd`). 앱이 쓰는 그 클라이언트를 그대로 쓴다 —
//! 두 벌이면 같은 세션을 두 프로세스가 다르게 보고, 그 어긋남은 오류가 아니라 "터미널이
//! 이쪽에서만 살아 있다"로 나타난다.
//!
//! 여기 있는 것은 셋뿐이다:
//!   ① 이 프로세스의 링크(정체성·ptyd 실행 파일 후보를 부팅 상태에서 받는다),
//!   ② 세션 등록부(호출자가 쓰는 id ↔ 데몬 세션),
//!   ③ 출구를 소켓 토큰에 잇는 껍질.
//!
//! **로컬 폴백은 없다.** 앱은 데몬을 못 잡으면 인프로세스로 떨어지지만, 이 프로세스가 그러면
//! 앱이 재시작을 넘겨 살리려던 셸이 이 프로세스와 함께 죽는다. 못 붙으면 이름을 달고 거절한다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use soksak_core::activity_sink::ActivitySink;
use soksak_core::identity::Identity;
use soksak_core::ptyd::{self, Link};
use soksak_core::seal_keys::NoSealKeys;
use soksak_core::stream_sink::{Delivered, StreamSink};

use crate::ctx::Ctx;

/// 데몬에 붙는 이 프로세스의 링크. 정체성 하나에 하나다 — 링크가 캐시한 연결이 그 홈의
/// 것이므로, 홈이 다른 링크가 둘이면 캐시와 요청이 어긋난다.
static LINK: OnceLock<Arc<Link>> = OnceLock::new();

/// 호출자가 쓰는 세션 id ↔ 데몬 세션. 앱의 PtyManager 와 같은 자리다.
static SESSIONS: OnceLock<Mutex<HashMap<u32, Session>>> = OnceLock::new();
static NEXT_ID: OnceLock<Mutex<u32>> = OnceLock::new();

struct Session {
    daemon: u64,
    pane_id: Option<String>,
}

fn sessions() -> &'static Mutex<HashMap<u32, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 이 프로세스가 아는 ptyd 실행 파일 — **후보를 만들어 코어에 고르게 한다.**
///
/// 지목(SOKSAK_PTYD_BIN) > 자기 실행 파일 형제. 둘 다 이 프로세스만 아는 사실이라 여기서 읽고,
/// 고르는 규칙은 코어가 소유한다(앱과 같은 규칙이라야 같은 바이너리를 스테이징한다).
fn ptyd_source() -> Option<PathBuf> {
    let declared = std::env::var("SOKSAK_PTYD_BIN")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("soksak-ptyd")));
    ptyd::pick_source(declared.as_deref(), sibling.as_deref())
}

fn link(identity: &Identity) -> &'static Arc<Link> {
    LINK.get_or_init(|| Arc::new(Link::new(identity.clone(), ptyd_source())))
}

/// 이 프로세스의 원장 — 앱이 창에 부채질하는 자리에서, 여기는 자기 원장에 적는다.
struct CoredLedger {
    db_path: String,
}

impl ActivitySink for CoredLedger {
    fn publish(&self, kind: &str, source: &str, payload: Value) -> Value {
        match crate::ledger::admit(&self.db_path, kind, source, payload) {
            Ok(v) => v,
            // 원장 실패가 터미널을 막지 않는다 — 다만 삼키지 않는다.
            Err(e) => {
                eprintln!("[cored] activity publish failed: {kind} — {e}");
                Value::Null
            }
        }
    }
}

/// 출구 — 바이트 배치를 소켓 프레임으로 민다.
///
/// 받는 쪽이 사라졌다는 사실을 **값으로** 돌려준다. 조용히 버리면 생산 측이 영원히 읽는다.
pub struct TokenSink {
    token: String,
}

impl TokenSink {
    pub fn new(token: String) -> Self {
        TokenSink { token }
    }
}

/// 종료 출구 — 스트림이 끝났다는 사실 하나(정수). 바이트 계약에 끼우지 않는다:
/// 받는 쪽이 보는 것이 raw 바이트가 아니라 수 하나다.
pub struct ExitTokenSink {
    token: String,
}

impl ExitTokenSink {
    pub fn new(token: String) -> Self {
        ExitTokenSink { token }
    }
}

impl soksak_core::stream_sink::ExitSink for ExitTokenSink {
    fn deliver(&self, code: i32) -> Delivered {
        if crate::streams::push(&self.token, json!({ "code": code })) {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

impl StreamSink for TokenSink {
    fn deliver(&self, bytes: Vec<u8>) -> Delivered {
        // 바이트는 base64 로 건넌다 — JSON 한 줄에 raw 바이트를 실을 수 없다. 받는 쪽(프리로드)이
        // ArrayBuffer 로 되돌린다.
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        if crate::streams::push(&self.token, json!({ "b64": b64 })) {
            Delivered::Ok
        } else {
            Delivered::Gone
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub window_label: Option<String>,
    #[serde(default)]
    pub replay: Option<ptyd::ReplayControl>,
}

/// 셸 하나를 데몬에 띄우고 그 출력을 토큰으로 흘린다.
///
/// 토큰이 없으면 거절한다 — 출력이 갈 곳 없는 터미널은 "떴는데 아무것도 안 나온다"가 되고,
/// 그 증상은 오류로 보이지 않는다.
pub fn spawn(ctx: &Ctx, params: &Value, args: SpawnArgs) -> Result<Value, String> {
    let tokens = soksak_core::stream::tokens(params);
    let (_, token) = tokens
        .into_iter()
        .next()
        .ok_or("출력을 받을 스트림 토큰이 없습니다 — onOutput 을 함께 보내세요")?;

    let shell = args
        .shell
        .or_else(|| ctx.login_shell().map(|s| s.to_string()))
        .ok_or("셸을 모릅니다 — shell 인자나 부팅 인자(--login-shell)가 필요합니다")?;

    let ledger: Arc<dyn ActivitySink> = Arc::new(CoredLedger {
        db_path: ctx.db_path().to_string_lossy().to_string(),
    });
    // 셸 env 규칙은 코어가 소유한다 — 화이트리스트가 두 벌이면 시크릿 유출이 프로세스마다
    // 다르다. 이 프로세스의 사실(부모 env·자기 소켓)만 넘긴다. AI 세션 키를 끊는 것도 같다:
    // 헬퍼가 안 끊으면 이쪽으로 띄운 터미널의 claude 가 자기를 중첩 자식으로 오인한다.
    let (env, env_remove) = soksak_core::shell_env::session_env(
        &shell,
        &args.pane_id,
        &args.window_label,
        std::env::vars(),
        ctx.socket_path(),
        soksak_core::shell_env::AI_SESSION_ENV,
        &std::env::temp_dir(),
        &std::env::var("ZDOTDIR")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_default(),
    );

    let daemon = ptyd::spawn_via_daemon(
        ledger,
        // 이 프로세스에는 볼트가 없다 — **선언한다**. 있는 척하면 봉인 안 된 화면이 봉인된
        // 것으로 기록되고, 다음 실행이 그것을 열려다 실패한다.
        &NoSealKeys,
        link(ctx.identity()),
        ptyd::SpawnParams {
            pane_id: args.pane_id.clone(),
            window_label: args.window_label,
            cols: args.cols,
            rows: args.rows,
            cwd: args.cwd,
            shell,
            env,
            env_remove,
            replay: args.replay,
        },
        TokenSink::new(token),
    )?;

    let mut n = NEXT_ID.get_or_init(|| Mutex::new(0)).lock().unwrap_or_else(|e| e.into_inner());
    *n += 1;
    let id = *n;
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Session { daemon, pane_id: args.pane_id });
    Ok(json!({ "id": id }))
}

/// 이 id 의 데몬 세션. 없으면 이름을 달고 실패한다 — 없는 세션에 쓰고 성공을 답하면
/// 부르는 쪽은 "입력이 삼켜진다"만 본다.
fn daemon_session(id: u32) -> Result<u64, String> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .map(|s| s.daemon)
        .ok_or_else(|| format!("세션 없음: {id}"))
}

fn ask(ctx: &Ctx, req: &soksak_spec_pty::Request) -> Result<(), String> {
    link(ctx.identity())
        .request(req, false)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn write(ctx: &Ctx, id: u32, data: &str) -> Result<(), String> {
    use base64::Engine as _;
    let session = daemon_session(id)?;
    ask(
        ctx,
        &soksak_spec_pty::Request::Write {
            session,
            data_b64: base64::engine::general_purpose::STANDARD.encode(data),
        },
    )
}

pub fn resize(ctx: &Ctx, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = daemon_session(id)?;
    ask(ctx, &soksak_spec_pty::Request::Resize { session, cols, rows })
}

pub fn ack(ctx: &Ctx, id: u32, bytes: u64) -> Result<(), String> {
    let session = daemon_session(id)?;
    ask(ctx, &soksak_spec_pty::Request::Ack { session, bytes })
}

pub fn close(ctx: &Ctx, id: u32) -> Result<(), String> {
    let session = daemon_session(id)?;
    let r = ask(ctx, &soksak_spec_pty::Request::Kill { session });
    // 등록부에서는 어느 쪽이든 뺀다 — 데몬이 이미 놓은 세션을 계속 쥐면 그 id 로 오는 다음
    // 요청이 죽은 세션에 간다.
    sessions().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    r
}

/// 이 pane 의 셸이 살아 있는가. **모르면 거짓이 아니라 사실을 답한다** — 데몬에 못 물으면
/// 그것은 "죽었다"가 아니고, 죽었다고 답하면 화면이 복원되지 않는다.
pub fn pane_alive(ctx: &Ctx, pane_id: &str) -> Result<bool, String> {
    let known: Vec<u64> = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter(|s| s.pane_id.as_deref() == Some(pane_id))
        .map(|s| s.daemon)
        .collect();
    if known.is_empty() {
        return Ok(false);
    }
    let v = link(ctx.identity())
        .request(&soksak_spec_pty::Request::ListSessions, true)
        .map_err(|e| e.to_string())?;
    let alive = v["sessions"]
        .as_array()
        .map(|a| {
            a.iter()
                .any(|s| s["session"].as_u64().is_some_and(|d| known.contains(&d)))
        })
        .unwrap_or(false);
    Ok(alive)
}

/// 이 pane 의 봉인된 화면. **없으면 없다고, 있는데 못 열면 이름을 달고** 답한다.
///
/// 이 프로세스에는 볼트가 없다(NoSealKeys). 그래서 체크포인트가 아예 없으면 정직하게 null 이고,
/// 있는데 열 수 없으면 그 사실이 답이다 — null 로 뭉개면 "복원할 것이 없었다"가 되어 사용자가
/// 화면을 잃은 것을 아무도 모른다.
pub fn read_sealed_screen(
    ctx: &Ctx,
    window_label: Option<&str>,
    pane_id: &str,
    legacy_pane_id: Option<&str>,
) -> Result<Value, String> {
    let window = window_label.unwrap_or_default();
    let sealed = match legacy_pane_id {
        Some(legacy) => ptyd::read_sealed_screen_adopting(
            &NoSealKeys,
            ctx.identity(),
            window,
            legacy,
            pane_id,
        )?,
        None => ptyd::read_sealed_screen(&NoSealKeys, ctx.identity(), window, pane_id)?,
    };
    Ok(match sealed {
        Some(s) => json!({ "paintB64": s.paint_b64 }),
        None => Value::Null,
    })
}

#[cfg(test)]
#[path = "pty_tests.rs"]
mod tests;

/// 이 pane 의 전경 프로세스 pid — 없으면 None.
///
/// **모르는 것과 없는 것을 가른다.** 이 이름의 None 은 "전경 프로세스가 없다"는 뜻이라, 남의
/// 세션이어서 못 본 것을 같은 None 으로 답하면 부른 쪽은 전경이 없다고 읽는다. 이 원장에 없는
/// pane 은 None 이 아니라 **이름을 달고** 거절한다.
pub fn pane_pid(ctx: &Ctx, pane_id: &str) -> Result<Option<u32>, String> {
    let known = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .any(|s| s.pane_id.as_deref() == Some(pane_id));
    if !known {
        return Err(format!(
            "이 프로세스의 원장에 없는 pane 이다: {pane_id} — None 으로 답하면 전경이 없는 것으로 읽힌다"
        ));
    }
    let v = link(ctx.identity())
        .request(
            &soksak_spec_pty::Request::PanePid {
                pane_id: pane_id.to_string(),
            },
            true,
        )
        .map_err(|e| e.to_string())?;
    Ok(v["pid"].as_u64().map(|p| p as u32))
}
