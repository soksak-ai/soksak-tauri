//! ptyd 클라이언트 — 셸을 소유한 데몬에 붙는 **한 벌**.
//!
//! 앱과 헬퍼가 같은 데몬에 붙는다. 붙는 방식이 두 벌이면 같은 세션을 두 프로세스가 다르게
//! 보고, 그 어긋남은 오류가 아니라 "터미널이 이쪽에서만 살아 있다"로 나타난다.
//!
//! **프레임워크 핸들을 받지 않는다.** 받던 것은 셋이었다(볼트 상태·세션 등록부·원장) — 셋 다
//! 계약이 되어(SealKeys·Link·ActivitySink) 이 모듈이 어느 프로세스에서든 선다.
//!
//! 이 모듈이 소유하는 것: control 소켓 요청/응답, stream 부착과 재부착, 무중단 판올림 사전
//! 점검, 화면 체크포인트 봉인/개봉. 배압(워터마크·ack)은 세션의 것이고 여기 없다.


use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use soksak_spec_pty as proto;

use crate::activity_sink::ActivitySink;
use crate::identity::Identity;
// 전달 단위 소유자는 하나 — 인프로세스 백엔드와 같은 모듈을 쓴다(사본 금지).
use crate::pty_delivery::spawn_delivery;
use crate::stream_sink::StreamSink;

/// 화면 복원 제어(배관, 내용 불가지) — 소비자가 화면을 소유하는지, 어느 좌표부터 이어 붙을지.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum ReplayControl {
    Mode(String),
    FromSeq {
        #[serde(rename = "fromSeq")]
        from_seq: u64,
    },
}

/// 봉인-블롭을 개봉한 평문. 바이트를 해석하지 않는다 — 화면 의미는 소비자가 읽는다.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedScreen {
    pub paint_b64: String,
}

// control 연결 1본(요청-응답 직렬) — 명령 빈도가 낮아(입력·리사이즈·ack) 충분하다.
struct Control {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Control {
    fn request(&mut self, req: &proto::Request) -> Result<Value, LinkError> {
        let line = serde_json::to_string(req).map_err(|e| LinkError::Io(e.to_string()))?;
        writeln!(self.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
        let mut reply = String::new();
        self.reader
            .read_line(&mut reply)
            .map_err(|e| LinkError::Io(e.to_string()))?;
        if reply.trim().is_empty() {
            return Err(LinkError::Io("daemon closed the control socket".into()));
        }
        let v: Value =
            serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
        if v["ok"] == true {
            Ok(v.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(LinkError::Remote {
                code: v["code"].as_str().unwrap_or("ERROR").to_string(),
                message: v["message"].as_str().unwrap_or_default().to_string(),
            })
        }
    }
}

enum LinkError {
    // 소켓/프레이밍 — 링크 자체가 죽었다(재연결 대상).
    Io(String),
    // 데몬의 논리 거절(NOT_FOUND 등) — 링크는 산다.
    Remote { code: String, message: String },
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Io(e) => write!(f, "link: {e}"),
            LinkError::Remote { code, message } => write!(f, "{code}: {message}"),
        }
    }
}

pub struct Link {
    // 링크가 붙는 데몬은 홈 하나에 묶인다(control/stream 소켓·토큰이 거기서 나온다).
    // 캐시된 연결이 이미 그 홈의 것이므로 요청마다 홈을 받으면 캐시와 인자가 어긋난다.
    identity: Identity,
    /// 이 프로세스가 아는 ptyd 실행 파일. **부팅 인자다** — 여기서 환경이나 실행 경로를 읽으면
    /// 같은 코드가 앱과 헬퍼에서 다른 바이너리를 스테이징한다.
    source: Option<PathBuf>,
    control: Mutex<Option<Control>>,
    // 폴백 고지 1회 게이트(스폰 폭주 시 도배 방지) — 데몬 스폰 성공이 리셋한다.
    fallback_notified: AtomicBool,
    // 데몬 사망 고지 1회 게이트 — 재확보 성공이 리셋한다.
    lost_notified: AtomicBool,
}

impl Link {
    pub fn new(identity: Identity, source: Option<PathBuf>) -> Self {
        Link {
            identity,
            source,
            control: Mutex::new(None),
            fallback_notified: AtomicBool::new(false),
            lost_notified: AtomicBool::new(false),
        }
    }

    /// 이 링크가 스테이징할 ptyd 실행 파일(없을 수 있다).
    pub fn source(&self) -> Option<&Path> {
        self.source.as_deref()
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    // 요청 실행. spawn_if_needed=true 면 미연결 시 스테이징+데몬 스폰까지 시도한다
    // (false 면 살아있는 데몬에 연결만 — pane pid 조회 같은 관찰 경로가 데몬을
    // 부풀리지 않게). Io 에러는 링크를 버리고 1회 재확보 후 재시도한다 — 이
    // "소켓 에러 → 재확보" 가 죽음 감지다(폴링 0).
    pub fn request(
        &self,
        req: &proto::Request,
        spawn_if_needed: bool,
    ) -> Result<Value, String> {
        let home = self.identity.home();
        let mut guard = self.control.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(if spawn_if_needed {
                ensure_daemon(home, self.source.as_deref()).map_err(|e| e.to_string())?
            } else {
                connect(home).map_err(|e| e.to_string())?
            });
        }
        let conn = match guard.as_mut() {
            Some(c) => c,
            // 바로 위에서 Some 을 넣었으므로 도달 불가 — 패닉 대신 명시 에러.
            None => return Err("pty link: control missing after connect".to_string()),
        };
        match conn.request(req) {
            Ok(v) => Ok(v),
            Err(LinkError::Remote { code, message }) => Err(format!("{code}: {message}")),
            Err(LinkError::Io(_)) => {
                // 링크 사망 — 재확보 1회 후 재시도. 실패는 호출자에게(폴백 판단).
                *guard = None;
                let mut fresh = if spawn_if_needed {
                    ensure_daemon(home, self.source.as_deref()).map_err(|e| e.to_string())?
                } else {
                    connect(home).map_err(|e| e.to_string())?
                };
                let out = fresh.request(req).map_err(|e| e.to_string());
                *guard = Some(fresh);
                out
            }
        }
    }
}

pub struct SpawnParams {
    pub pane_id: Option<String>,
    pub window_label: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub shell: String,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    // 화면 복원 제어(배관) — ReplayControl 참조. spawn_via_daemon 이 세 모드로 분기.
    pub replay: Option<ReplayControl>,
}

// ── 봉인 체크포인트 수신 키(restore 사다리 3단, docs/RESTORE.md) ─────────
// 봉인은 공개키만 필요하다 — P 는 평문 캐시(<home>/pty/seal.pub, 공개값),
// S 는 vault 에만(put_data_key). 캐시가 없고 vault 도 잠겨 있으면 None — 데몬은
// 체크포인트를 쓰지 않는다(fail closed: 화면 바이트 평문 저장 경로는 존재하지 않는다).
// 동시 스폰 경쟁은 (a) 프로세스 내 뮤텍스 직렬화 (b) keyId 에 랜덤을 넣고 rename
// 승자의 파일을 재독해 채택 — S/P 짝이 항상 파일이 가리키는 쌍으로 정렬된다.
static CKPT_KEY_GATE: Mutex<()> = Mutex::new(());

pub fn checkpoint_recipient(
    keys: &dyn crate::seal_keys::SealKeys,
    identity: &Identity,
) -> (Option<String>, Option<String>) {
    let path = proto::checkpoint_pubkey_path(identity.home());
    let read = |p: &Path| -> Option<(String, String)> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
        Some((
            v["publicKey"].as_str()?.to_string(),
            v["keyId"].as_str()?.to_string(),
        ))
    };
    let _gate = CKPT_KEY_GATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((pk, key_id)) = read(&path) {
        return (Some(pk), Some(key_id));
    }
    if !keys.unlocked() {
        return (None, None); // 잠김 + 캐시 없음 — 이번 세션은 체크포인트 없이
    }
    let Some((key_id, p)) = keys.new_key() else {
        return (None, None); // 사유는 보관소가 남긴다
    };
    let pk_b64 = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(p)
    };
    let doc = json!({ "keyId": key_id, "publicKey": pk_b64 });
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
        let tmp = dir.join(format!(".ckpt-pub-{}", std::process::id()));
        if std::fs::write(&tmp, doc.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    // rename 승자의 쌍을 채택(교차 프로세스 경쟁 정렬) — 내 쌍이 졌으면 파일 쌍으로.
    match read(&path) {
        Some((pk, key_id)) => (Some(pk), Some(key_id)),
        None => (Some(pk_b64), Some(key_id)),
    }
}

// 데몬 경유 스폰: createOrAttach → stream 부착 → reader 스레드(라이브 → Channel). 반환 =
// 데몬 세션 id. 화면 복원은 코어를 떠났다(방출) — 소비자(플러그인)가 사이드카 복원 요청/
// 봉인-블롭으로 스스로 그린다. 코어는 소비자의 replay 제어 두 갈래만 존중한다:
//   plugin_owns("none" | 부재): 소비자가 화면을 그렸다 — 신선 세션 프롬프트만 개행으로
//     아래에 다시 그린다(코어 재생 없음). 부재(undefined)는 방어적으로 "none" 동치다
//     (legacy 코어-소유 재생은 방출됨 — 소비자가 항상 명시한다).
//   from_seq({fromSeq}): warm 핸드오프 — raw 링을 그 seq 부터 부착한다(소비자가 uptoSeq
//     까지 이미 그렸고, 그 뒤 꼬리가 라이브 연속분이다).
/// 데몬 레그의 진입점 — **프레임워크 핸들을 받지 않는다.**
///
/// 받던 것은 셋이었다: 볼트 상태·세션 등록부·원장. 셋 다 계약이 되어(SealKeys·Link·
/// ActivitySink) 이 함수와 그것이 띄우는 스트림 스레드가 앱 프로세스를 떠날 수 있다.
pub fn spawn_via_daemon<S: StreamSink>(
    ledger: std::sync::Arc<dyn ActivitySink>,
    keys: &dyn crate::seal_keys::SealKeys,
    link: &std::sync::Arc<Link>,
    p: SpawnParams,
    on_output: S,
) -> Result<u64, String> {
    // pane 없는 세션은 재부착 키가 없다 — 데몬에 실을 이유가 없어 로컬로 보낸다.
    let pane_id = p.pane_id.clone().ok_or("no pane id: local session")?;
    // 정체성은 링크가 쥔 것을 그대로 쓴다 — 스폰이 붙는 데몬과 경로가 갈리면 안 된다.
    let identity = link.identity();
    let home = identity.home().to_path_buf();
    let window = p.window_label.clone().unwrap_or_default();
    let replay = p.replay.clone();
    // 소비자 소유("none" | 부재): 코어는 화면을 복원하지 않는다. from_seq: warm 핸드오프 좌표.
    let plugin_owns = match &replay {
        None => true,
        Some(ReplayControl::Mode(m)) => m == "none",
        Some(ReplayControl::FromSeq { .. }) => false,
    };
    let from_seq = match &replay {
        Some(ReplayControl::FromSeq { from_seq }) => Some(*from_seq),
        _ => None,
    };
    // 봉인-블롭 수신 키를 세션에 실어 StoreBlob 이 봉인할 수 있게 한다(사이드카 체크포인트).
    let (checkpoint_pk, checkpoint_key_id) = checkpoint_recipient(keys, identity);
    let data = link.request(
        &proto::Request::CreateOrAttach {
            pane_id: pane_id.clone(),
            cols: p.cols,
            rows: p.rows,
            cwd: p.cwd,
            shell: p.shell,
            env: p.env,
            env_remove: p.env_remove,
            window_label: p.window_label,
            checkpoint_pk,
            checkpoint_key_id,
        },
        true,
    )?;
    let session = data["session"]
        .as_u64()
        .ok_or("daemon reply missing session id")?;

    // 부착: from_seq 있으면 raw 링을 그 seq 부터 재생(warm 핸드오프), 없으면 재생 없이 라이브.
    let (mut stream, gap, attach_seq) = attach_stream(&home, session, from_seq)?;
    if let Some((from, to)) = gap {
        // warm 핸드오프에서 evict 로 seq 구간 [from,to) 가 사라졌다 — 무음 유실 금지(loud 고지).
        ledger.publish(
            "pty.warm.gap",
            "core",
            json!({
                "window": window,
                "pane": pane_id,
                "fromSeq": from,
                "toSeq": to,
                "note": "the raw ring evicted this range before the warm handoff attached; restore fidelity degraded",
            }),
        );
    }
    // 소비자가 화면을 그린 경우(plugin_owns) 신선 세션 프롬프트를 개행 하나로 페인트 아래에
    // 다시 그린다. from_seq(warm)는 재생 꼬리가 곧 라이브 연속분이라 손대지 않는다.
    if plugin_owns {
        use base64::Engine as _;
        let _ = link.request(
            &proto::Request::Write {
                session,
                data_b64: base64::engine::general_purpose::STANDARD.encode("\n"),
            },
            false,
        );
    }

    // 세션 stream reader — 소켓 EOF/에러가 곧 이벤트다: 셸 종료(데몬이 닫음)거나
    // 데몬 사망. control ping 한 번으로 갈라 후자만 고지+재확보한다.
    {
        // 스레드가 지고 갈 것은 **링크와 원장**뿐이다. 프레임워크 핸들을 지고 가면 이
        // 스레드가 앱 프로세스에 묶이고, 같은 코드가 헬퍼에서 돌 수 없다.
        let link_for_stream = link.clone();
        let ledger_for_stream = ledger.clone();
        let home_for_stream = home.clone();
        let mut cursor = attach_seq;
        std::thread::spawn(move || {
            // 데몬 레그도 같은 크로싱으로 끝난다 — 전달 단위 소유자는 하나다.
            let (deliver, delivery) = spawn_delivery(on_output);
            let mut buf = vec![0u8; 8192];
            'attached: loop {
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Some(c) = cursor.as_mut() {
                                *c += n as u64;
                            }
                            if deliver.send(buf[..n].to_vec()).is_err() {
                                break 'attached; // 프론트 사라짐(창 리로드 등) — 데몬은 계속 산다
                            }
                        }
                    }
                }
                // 부착 스트림의 끝은 생명주기 사건이다 — 원장에 올린다. 관측면이 없으면
                // "왜 화면이 멈췄는가"를 밖에서 알 길이 없다(실측: 판올림 뒤 화면이 얼었는데
                // 어떤 채널에도 흔적이 없어 원인을 소스 추론으로만 좁혀야 했다).
                ledger_for_stream.publish(
                    "pty.stream.ended",
                    "core",
                    json!({ "session": session, "cursor": cursor }),
                );
                // 스트림의 끝은 "이 스트림이 끝났다"일 뿐 셸의 끝이 아니다. 무중단 판올림은
                // 정확히 이 모양이다: 물러나는 데몬이 모든 부착을 EOF 로 놓는다. 셸의 생사는
                // 데몬에게 묻고, 살아 있으면 마지막 좌표에서 이어 붙는다.
                match reattach_live_session(
                        ledger_for_stream.as_ref(),
                        &link_for_stream,
                        &home_for_stream,
                        session,
                        cursor,
                    ) {
                    Some((s, c)) => {
                        stream = s;
                        cursor = c;
                        continue 'attached;
                    }
                    None => break 'attached,
                }
            }
            // 스트림 종료를 고지하기 전에 마지막 배치를 내보낸다 — 순서가 뒤집히면 꼬리가 잘린다.
            drop(deliver);
            let _ = delivery.join();
            on_stream_end(ledger_for_stream.as_ref(), &link_for_stream);
        });
    }

    // 데몬 경로 성공 — 이후 폴백이 다시 일어나면 새 사건으로 고지한다.
    link.fallback_notified.store(false, Ordering::SeqCst);
    Ok(session)
}

/// 스트림이 끝났는데 세션은 살아 있는가 — 살아 있으면 마지막 좌표에서 다시 붙는다.
///
/// ping 만으로는 "셸이 끝났다"와 "데몬이 물러났다"를 가를 수 없다(둘 다 데몬은 응답한다).
/// 가르는 것은 세션의 존재다 — 권위에게 묻는다. 옛 판은 ping 성공을 곧 셸 종료로 읽어
/// 아무것도 하지 않았고, 그래서 판올림 뒤 셸은 살아 입력도 받는데 화면만 영영 멈췄다
/// (실측 2026-07-27, scripts/e2e/pty-handoff.mjs).
///
/// 재시도는 폴링이 아니라 **경계 하나를 넘는 대기**다: 물러난 데몬이 소켓을 놓고 새 데몬이
/// 그 자리를 잡는 그 전이 구간만 기다린다. 상한 20회·150ms(총 3초)이며, 그 안에 세션이
/// 확인되지 않으면 포기하고 기존 경로(on_stream_end)로 넘긴다.
fn reattach_live_session(
    ledger: &dyn ActivitySink,
    link: &Link,
    home: &Path,
    session: u64,
    cursor: Option<u64>,
) -> Option<(UnixStream, Option<u64>)> {
    for attempt in 0..20 {
        match link.request(&proto::Request::ListSessions, true) {
            Ok(v) => {
                // SessionInfo 의 식별자 필드는 `session` 이다(`id` 가 아니다) — 이름을
                // 잘못 짚으면 언제나 "없음"으로 읽혀 재부착이 조용히 사라진다(실측).
                let alive = v["sessions"]
                    .as_array()
                    .map(|a| a.iter().any(|s| s["session"].as_u64() == Some(session)))
                    .unwrap_or(false);
                if !alive {
                    // 셸이 정말 끝났다 — 기존 경로가 처리한다. 조용히 지나가지 않는다:
                    // "재부착 안 함"도 판정이고, 판정은 원장에 남아야 뒤에서 읽을 수 있다.
                    ledger.publish(
                        "pty.session.gone",
                        "core",
                        json!({
                            "session": session,
                            "note": "the attach stream ended and the daemon no longer lists this session — the shell exited",
                        }),
                    );
                    return None;
                }
                match attach_stream(home, session, cursor) {
                    Ok((s, gap, seq)) => {
                        ledger.publish(
                            "pty.stream.reattached",
                            "core",
                            json!({
                                "session": session,
                                "fromSeq": cursor,
                                "cursorKnown": cursor.is_some(),
                                "gap": gap.map(|(f, t)| json!({ "fromSeq": f, "toSeq": t })),
                                "attempts": attempt + 1,
                                "note": "the attach stream ended while the session lived (daemon handoff) — reattached at the last coordinate",
                            }),
                        );
                        return Some((s, seq));
                    }
                    Err(e) => {
                        // 새 데몬이 아직 스트림 소켓을 잡기 전일 수 있다 — 같은 전이 구간.
                        if attempt == 19 {
                            ledger.publish(
                                "pty.stream.reattach.failed",
                                "core",
                                json!({ "session": session, "error": e }),
                            );
                            return None;
                        }
                    }
                }
            }
            Err(_) => {
                // 링크 자체가 전이 중 — 아래에서 잠깐 기다렸다 다시 묻는다.
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    None
}

// stream 종료의 원인 판별: control ping 이 살아 있으면 셸의 정상 종료다(프론트는
// Channel 종료로 이미 안다). ping 까지 죽었으면 데몬 사망 — 고지하고 재확보를
// 시도한다(성공 시 다음 스폰부터 데몬 경로 복귀. 죽은 데몬의 세션은 소실 —
// 골격의 한계로 고지에 싣는다).
fn on_stream_end(ledger: &dyn ActivitySink, link: &Link) {
    if link.request(&proto::Request::Ping, false).is_ok() {
        return; // 셸 정상 종료
    }
    // 재확보 대상은 이 링크가 겨누던 그 데몬이다 — 홈은 링크가 쥔 정체성에서 온다.
    let respawned = ensure_daemon(link.identity().home(), link.source()).is_ok();
    if respawned {
        link.lost_notified.store(false, Ordering::SeqCst);
    }
    if !link.lost_notified.swap(true, Ordering::SeqCst) || respawned {
        ledger.publish(
            "pty.daemon.lost",
            "core",
            json!({
                "respawned": respawned,
                "note": "live daemon sessions are lost; new terminals reattach to the respawned daemon",
            }),
        );
    }
}

// 폴백 고지(무음 금지) — 스폰 폭주 도배 방지로 1회 게이트.
// 이 함수가 app 을 쓰던 곳은 발행 한 줄뿐이었다 — 계약만 받는다(ipc.rs record_route_outcome 선례).
pub fn notify_fallback(
    ledger: &dyn ActivitySink,
    link: &Link,
    error: &str,
) {
    if link.fallback_notified.swap(true, Ordering::SeqCst) {
        return;
    }
    eprintln!("[pty] daemon unavailable, in-process fallback: {error}");
    ledger.publish(
        "pty.daemon.fallback",
        "core",
        json!({
            "error": error,
            "note": "terminals run in-process and will not survive an app restart",
        }),
    );
}

// ── 확보: 연결 → (실패 시) 스테이징 + 스폰 + 재연결 ─────────────────────

fn connect(home: &Path) -> Result<Control, LinkError> {
    let token = std::fs::read_to_string(proto::token_path(home))
        .map_err(|e| LinkError::Io(format!("token: {e}")))?
        .trim()
        .to_string();
    let conn = UnixStream::connect(proto::control_socket_path(home))
        .map_err(|e| LinkError::Io(format!("connect: {e}")))?;
    let reader = BufReader::new(conn.try_clone().map_err(|e| LinkError::Io(e.to_string()))?);
    let mut c = Control {
        reader,
        writer: conn,
    };
    let hello = proto::Hello {
        version: Some(proto::PTYD_PROTOCOL_VERSION),
        token,
        client_id: format!("app-{}", std::process::id()),
        session: None,
        from_seq: None,
        subscribe: false,
    };
    let line = serde_json::to_string(&hello).map_err(|e| LinkError::Io(e.to_string()))?;
    writeln!(c.writer, "{line}").map_err(|e| LinkError::Io(e.to_string()))?;
    let mut reply = String::new();
    c.reader
        .read_line(&mut reply)
        .map_err(|e| LinkError::Io(e.to_string()))?;
    let v: Value =
        serde_json::from_str(reply.trim()).map_err(|e| LinkError::Io(e.to_string()))?;
    if v["ok"] != true {
        return Err(LinkError::Remote {
            code: v["code"].as_str().unwrap_or("ERROR").to_string(),
            message: v["message"].as_str().unwrap_or_default().to_string(),
        });
    }
    Ok(c)
}

fn ensure_daemon(home: &Path, source: Option<&Path>) -> Result<Control, LinkError> {
    if let Ok(c) = connect(home) {
        return Ok(c);
    }
    let staged = stage_binary(home, source).map_err(LinkError::Io)?;
    // run/ 은 데몬도 부트에 만들지만, 로그 파일은 스폰 전에 앱이 먼저 연다 — 앱이 보장한다.
    std::fs::create_dir_all(proto::run_dir(home))
        .map_err(|e| LinkError::Io(format!("run dir: {e}")))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(proto::log_path(home))
        .map_err(|e| LinkError::Io(format!("log: {e}")))?;
    let log2 = log.try_clone().map_err(|e| LinkError::Io(e.to_string()))?;
    let mut cmd = std::process::Command::new(&staged);
    cmd.env("SOKSAK_HOME", home)
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(log2);
    // detach: 새 세션 리더로 — 앱이 죽어도 데몬과 그 셸들이 살아남는다.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()
        .map_err(|e| LinkError::Io(format!("spawn ptyd: {e}")))?;
    // 부트스트랩 핸드셰이크 대기 한정의 유한 재시도(성공/2s 상한 종료) — 상시
    // 감시가 아니다(감시는 소켓 에러 이벤트가 담당).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match connect(home) {
            Ok(c) => return Ok(c),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(e);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

// 홈 bin/ 설치 계약: 데몬 실행물은 앱 번들 밖 identity 홈 bin/ 에 프로토콜-키
// 이름으로 놓인다 — 번들은 업데이터의 원자 교체 단위라 번들 내 장수 프로세스는
// 세션 수명을 번들 수명에 강결합시킨다(R7). 배치는 staging → rename 원자
// (실행 중 mach-o in-place 덮어쓰기는 서명 무효화로 SIGKILL — stage.sh 선례).
/// 판올림 전 판정 — 나가는 데몬이 안전 인계 계약을 구현하는가.
///
/// 인계 계획(대상 fd 배치·링 좌표 승계)은 물러나는 쪽이 세운다. 그래서 새 바이너리를
/// 스테이징해도, 그 인계를 실행하는 것은 **지금 도는 옛 데몬**이다. 계약 이전 판에
/// 인계를 시키면 셸이 죽거나 화면이 조용히 멎는다 — 못 하는 일을 시도하지 않는다.
/// 조치는 하나뿐이라 문구에 박아 둔다(선택지를 주지 않는다).
pub fn handoff_precheck(ping: &serde_json::Value) -> Result<(), String> {
    let need = soksak_spec_pty::PTYD_HANDOFF_CONTRACT;
    match ping["handoffContract"].as_u64() {
        Some(v) if v >= need as u64 => Ok(()),
        Some(v) => Err(format!(
            "the running daemon implements handoff contract {v}, this build needs {need} — \
             run pty.daemon.restart once to adopt the new generation"
        )),
        None => Err(format!(
            "the running daemon predates the safe-handoff contract (needs {need}); a live \
             upgrade from it can lose a shell or silently freeze output — run \
             pty.daemon.restart once to adopt the new generation"
        )),
    }
}

#[cfg(test)]
mod handoff_precheck_tests {
    use super::handoff_precheck;
    use serde_json::json;

    #[test]
    fn current_contract_passes() {
        let need = soksak_spec_pty::PTYD_HANDOFF_CONTRACT;
        assert!(handoff_precheck(&json!({ "handoffContract": need })).is_ok());
        assert!(handoff_precheck(&json!({ "handoffContract": need + 1 })).is_ok());
    }

    #[test]
    fn a_daemon_without_the_field_is_refused_with_the_remedy() {
        let e = handoff_precheck(&json!({ "pid": 1, "sessions": 2 })).unwrap_err();
        assert!(e.contains("pty.daemon.restart"), "조치가 없는 거절은 거절이 아니다: {e}");
        assert!(e.contains("predates"), "{e}");
    }

    #[test]
    fn an_older_contract_is_refused() {
        let e = handoff_precheck(&json!({ "handoffContract": 1 })).unwrap_err();
        assert!(e.contains("pty.daemon.restart"), "{e}");
    }
}

pub fn stage_binary(home: &Path, source: Option<&Path>) -> Result<PathBuf, String> {
    let staged = proto::staged_bin_path(home);
    let source = source.map(|p| p.to_path_buf());
    let Some(source) = source else {
        if staged.exists() {
            return Ok(staged); // 소스 부재 — 이전에 스테이징된 판으로 계속
        }
        return Err(
            "ptyd binary not found (SOKSAK_PTYD_BIN or a soksak-ptyd next to the app binary)"
                .into(),
        );
    };
    if staged.exists() && same_content(&source, &staged) {
        return Ok(staged);
    }
    let bin_dir = staged.parent().ok_or("staged path has no parent")?;
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let tmp = bin_dir.join(format!(".ptyd-staging-{}", std::process::id()));
    std::fs::copy(&source, &tmp).map_err(|e| format!("stage copy: {e}"))?;
    #[allow(clippy::permissions_set_readonly_false)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, &staged).map_err(|e| format!("stage rename: {e}"))?;
    Ok(staged)
}

/// 소스 해석 — **후보를 받아 고른다.**
///
/// "이 실행물이 어디 있는가"와 "환경변수에 무엇이 있는가"는 프로세스의 사실이다. 여기서
/// 읽으면 같은 코드가 앱과 헬퍼에서 다른 답을 낸다(no_framework 게이트가 그 철자를 막는다).
/// 그래서 후보는 띄운 쪽이 만들고, 고르는 규칙만 여기 있다: **지목이 이기고, 없으면 형제.**
pub fn pick_source(declared: Option<&Path>, sibling: Option<&Path>) -> Option<PathBuf> {
    // 지목한 것이 없으면 없는 것이다 — 발견 규칙으로 흘러내리면 지목과 다른 것을 실행한다.
    if let Some(p) = declared {
        return p.exists().then(|| p.to_path_buf());
    }
    sibling.filter(|p| p.exists()).map(|p| p.to_path_buf())
}

fn same_content(a: &Path, b: &Path) -> bool {
    use sha2::{Digest, Sha256};
    let hash = |p: &Path| -> Option<[u8; 32]> {
        let mut f = std::fs::File::open(p).ok()?;
        let mut h = Sha256::new();
        std::io::copy(&mut f, &mut h).ok()?;
        Some(h.finalize().into())
    };
    matches!((hash(a), hash(b)), (Some(x), Some(y)) if x == y)
}

// 디스크의 봉인-블롭 헤더 — cold restore 의 입력(개봉 전 메타). 봉투는 내용 불가지라
// 터미널 메타(대체 화면 여부 등)를 담지 않는다 — 화면 의미는 개봉된 바이트 안에 있고 소비자가 푼다.
pub struct ColdCheckpoint {
    // 봉인 블롭의 디스크 출처 경로 — provenance 로 보존(cold restore 판정은 개봉 바이트만 쓴다).
    pub path: PathBuf,
    pub key_id: String,
    pub sealed: soksak_seal::SealedBox,
}

fn read_checkpoint(home: &Path, window: &str, pane: &str) -> Option<ColdCheckpoint> {
    let path = proto::checkpoint_path(home, window, pane);
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    if doc["v"] != 1 {
        return None; // 미래 판 — 이 세대는 열지 않는다(손대지 않고 남긴다)
    }
    Some(ColdCheckpoint {
        path,
        key_id: doc["keyId"].as_str()?.to_string(),
        sealed: serde_json::from_value(doc["sealed"].clone()).ok()?,
    })
}

// 개봉 — unlock 된 vault 의 개인키 + 정합 AAD 만 연다. 실패 사유는 고지에 실린다.
fn open_cold_checkpoint(
    keys: &dyn crate::seal_keys::SealKeys,
    ck: &ColdCheckpoint,
    window: &str,
    pane: &str,
) -> Result<Vec<u8>, String> {
    if !keys.unlocked() {
        return Err("vault locked".into());
    }
    let sk = keys
        .secret(&ck.key_id)?
        .ok_or_else(|| format!("seal key {} not in vault", ck.key_id))?;
    let sk: [u8; 32] = sk
        .as_slice()
        .try_into()
        .map_err(|_| format!("seal key {} 의 길이가 32바이트가 아닙니다", ck.key_id))?;
    let aad = proto::checkpoint_aad(window, pane, &ck.key_id);
    soksak_seal::open_sealed(&sk, &ck.sealed, &aad)
}

// stream 부착: hello 1줄 교환 후 raw 전환. hello 응답 줄만 바이트 단위로 소비해
// 뒤따르는 재생/라이브 바이트를 잃지 않는다. from_seq 있으면 raw 링을 그 seq 부터
// 재생하라고 데몬에 요청한다(warm 핸드오프), 없으면 재생 없이 라이브(미러 방출됨). 반환 =
// (소켓, evict gap [from,to) — from_seq 재생에서 링이 잘렸을 때만).
/// 부착 스트림 + evict gap + **부착 좌표**. 좌표는 "이 응답을 다 소비하면 당신이 서 있는
/// 자리"다 — 스트림이 끊겼을 때 재부착에 쓸 절대 커서의 출발점이다. 구 데몬은 이 필드를
/// 싣지 않으므로 None 이 올 수 있고, 그때는 재부착이 재생 없이 붙는다(유실은 고지한다).
fn attach_stream(
    home: &Path,
    session: u64,
    from_seq: Option<u64>,
) -> Result<(UnixStream, Option<(u64, u64)>, Option<u64>), String> {
    let token = std::fs::read_to_string(proto::token_path(home))
        .map_err(|e| format!("token: {e}"))?
        .trim()
        .to_string();
    let conn = UnixStream::connect(proto::stream_socket_path(home))
        .map_err(|e| format!("stream connect: {e}"))?;
    let mut w = conn.try_clone().map_err(|e| e.to_string())?;
    let hello = proto::Hello {
        version: Some(proto::PTYD_PROTOCOL_VERSION),
        token,
        client_id: format!("app-{}", std::process::id()),
        session: Some(session),
        from_seq,
        subscribe: false,
    };
    let line = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
    writeln!(w, "{line}").map_err(|e| e.to_string())?;
    let mut r = conn.try_clone().map_err(|e| e.to_string())?;
    let mut reply = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        r.read_exact(&mut byte)
            .map_err(|e| format!("stream hello: {e}"))?;
        if byte[0] == b'\n' {
            break;
        }
        reply.push(byte[0]);
        if reply.len() > 64 * 1024 {
            return Err("stream hello reply too long".into());
        }
    }
    let v: Value = serde_json::from_slice(&reply).map_err(|e| e.to_string())?;
    if v["ok"] != true {
        return Err(format!(
            "{}: {}",
            v["code"].as_str().unwrap_or("ERROR"),
            v["message"].as_str().unwrap_or_default()
        ));
    }
    // from_seq 재생에서 링이 그 seq 이전을 evict 했으면 gap 을 실어 준다(무음 유실 금지).
    let gap = match (
        v["data"]["gap"]["fromSeq"].as_u64(),
        v["data"]["gap"]["toSeq"].as_u64(),
    ) {
        (Some(f), Some(t)) => Some((f, t)),
        _ => None,
    };
    let seq = v["data"]["seq"].as_u64();
    Ok((conn, gap, seq))
}

// ── 서비스 사이드카 릴레이(생존 미러 사이드카 — SIDECARS.md) ──────────────────
// 웹뷰 JS 는 UDS 를 못 연다. 코어가 사이드카 서비스 소켓에 NDJSON 요청/응답 1왕복을
// 대신 연결해 준다(데몬 바이트 다리 pty.rs 와 같은 층위). 코어는 요청/응답 JSON 을
// 해석하지 않는다(내용 불가지 다리). 소켓은 데몬과 같은 run 디렉토리에 있고 identity-home
// 토큰을 공유한다(사이드카가 데몬과 피어링하는 계약). 연결 실패는 명시 에러(사이드카 사망 loud).
pub fn sidecar_service_relay(
    identity: &Identity,
    request: &Value,
) -> Result<Value, String> {
    let home = identity.home();
    let path = proto::run_dir(home).join(format!(
        "soksak-sidecar-terminal-p{}.sock",
        proto::PTYD_PROTOCOL_VERSION
    ));
    let token = std::fs::read_to_string(proto::token_path(home))
        .map_err(|e| format!("token: {e}"))?
        .trim()
        .to_string();
    let conn = UnixStream::connect(&path)
        .map_err(|e| format!("no terminal sidecar at {}: {e}", path.display()))?;
    let mut w = conn.try_clone().map_err(|e| e.to_string())?;
    let mut r = BufReader::new(conn);
    // hello{version, token} 1줄 → ok 1줄. 계약(SPEC §4)은 데몬 hello 와 동형이다.
    let hello = json!({ "version": proto::PTYD_PROTOCOL_VERSION, "token": token });
    writeln!(w, "{hello}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    if r.read_line(&mut line)
        .map_err(|e| format!("hello reply: {e}"))?
        == 0
    {
        return Err("terminal sidecar closed before hello ack".into());
    }
    let ack: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if ack["ok"] != true {
        return Err(format!(
            "{}: {}",
            ack["code"].as_str().unwrap_or("ERROR"),
            ack["message"].as_str().unwrap_or_default()
        ));
    }
    // 요청 릴레이 — 내용 불가지로 그대로 통과. 응답 1줄 파싱해 그대로 돌려준다.
    let mut req_line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    req_line.push(b'\n');
    w.write_all(&req_line).map_err(|e| e.to_string())?;
    line.clear();
    if r.read_line(&mut line).map_err(|e| format!("reply: {e}"))? == 0 {
        return Err("terminal sidecar closed before reply".into());
    }
    serde_json::from_str(line.trim()).map_err(|e| format!("reply parse: {e}"))
}

// ── 봉인-블롭 읽기 관통(cold 소비 경로 — restore 사다리 3단) ──────────────────
// 이 pane 의 봉인-블롭을 앱 볼트로 개봉해 평문 페인트(base64)를 돌려준다. 잠금이면 명시
// 에러(fail-closed — 평문 우회 없음), 블롭 없으면 None. 소비자가 바이트를 그려 죽은 세션
// 화면을 다시 그린다(사이드카 불요 경로). 코어는 바이트를 해석하지 않는다(봉인만 열고 넘긴다).
pub fn read_sealed_screen(
    keys: &dyn crate::seal_keys::SealKeys,
    identity: &Identity,
    window: &str,
    pane: &str,
) -> Result<Option<SealedScreen>, String> {
    let ck = match read_checkpoint(identity.home(), window, pane) {
        Some(c) => c,
        None => return Ok(None),
    };
    let paint = open_cold_checkpoint(keys, &ck, window, pane)?;
    use base64::Engine as _;
    Ok(Some(SealedScreen {
        paint_b64: base64::engine::general_purpose::STANDARD.encode(&paint),
    }))
}

/// 옛 블롭의 승계 — 규칙은 세 갈래고 어느 갈래도 반쯤 상태를 남기지 않는다:
///   신 키 파일이 이미 있다 → 최신이 이긴다. 옛 파일만 걷는다.
///   재봉인 성공(새 AAD·tmp→rename 원자) → 신 키 파일 생성 후 옛 파일 제거.
///   재봉인 실패 → 옛 파일 보존. 다음 부팅이 다시 폴백으로 연다(손실 0 유지).
/// rename 만으로는 안 된다 — 봉인 AAD 가 옛 키에 묶여 있어 신 키 개봉이 복호 실패한다.
pub fn adopt_checkpoint(
    ck: &ColdCheckpoint,
    paint: &[u8],
    window: &str,
    pane: &str,
    new_path: &Path,
    pk_b64: Option<&str>,
) {
    if new_path.exists() {
        let _ = std::fs::remove_file(&ck.path);
        return;
    }
    use base64::Engine as _;
    let resealed = pk_b64
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .and_then(|pk| pk.try_into().ok())
        .and_then(|pk: [u8; 32]| {
            let aad = proto::checkpoint_aad(window, pane, &ck.key_id);
            soksak_seal::seal_to(&pk, paint, &aad).ok()
        })
        .and_then(|sealed| {
            let doc = serde_json::json!({
                "v": 1,
                "keyId": ck.key_id,
                "window": window,
                "pane": pane,
                "sealed": sealed,
            });
            let tmp = new_path.with_extension("json.tmp");
            std::fs::write(&tmp, doc.to_string()).ok()?;
            std::fs::rename(&tmp, new_path).ok()
        });
    if resealed.is_some() {
        let _ = std::fs::remove_file(&ck.path);
    }
}

/// 옛 키(legacy)의 블롭을 열어 신 키(pane)로 승계한다 — 엔티티 id 이행의 손실 0 실행부.
pub fn read_sealed_screen_adopting(
    keys: &dyn crate::seal_keys::SealKeys,
    identity: &Identity,
    window: &str,
    legacy: &str,
    pane: &str,
) -> Result<Option<SealedScreen>, String> {
    let home = identity.home();
    let ck = match read_checkpoint(home, window, legacy) {
        Some(c) => c,
        None => return Ok(None),
    };
    let paint = open_cold_checkpoint(keys, &ck, window, legacy)?;
    let pk = std::fs::read_to_string(identity.path("pty/seal.pub"))
        .ok()
        .map(|s| s.trim().to_string());
    adopt_checkpoint(&ck, &paint, window, pane, &proto::checkpoint_path(home, window, pane), pk.as_deref());
    use base64::Engine as _;
    Ok(Some(SealedScreen {
        paint_b64: base64::engine::general_purpose::STANDARD.encode(&paint),
    }))
}

/// 데몬의 지금 상태 — 도는가, 몇 세션인가, 어떤 계약을 선언하는가.
///
/// 판정은 여기 하나다. 프로세스마다 쓰면 같은 데몬을 두 모양으로 답하고, 그 차이는 "판올림할
/// 수 있는가"를 밖에서 읽는 값이라 곧 잘못된 결정으로 이어진다.
///
/// 도는 데몬이 선언한 인계 계약 수준(없음 = 계약 이전 판)이 함께 실린다 — 판올림 가능 여부가
/// 이 값 하나로 밖에서 읽힌다. 시도해 보고 아는 것이 아니다.
pub fn daemon_status(link: &Link) -> serde_json::Value {
    use serde_json::json;
    let staged = soksak_spec_pty::staged_bin_path(link.identity().home());
    let (running, pid, sessions, contract) =
        match link.request(&soksak_spec_pty::Request::Ping, false) {
            Ok(v) => (
                true,
                v["pid"].as_u64(),
                v["sessions"].as_u64(),
                v["handoffContract"].as_u64(),
            ),
            Err(_) => (false, None, None, None),
        };
    json!({
        "running": running,
        "pid": pid,
        "sessions": sessions,
        "protocol": soksak_spec_pty::PTYD_PROTOCOL_VERSION,
        "handoffContract": contract,
        "handoffContractRequired": soksak_spec_pty::PTYD_HANDOFF_CONTRACT,
        "staged": staged.exists(),
        "stagedPath": staged.to_string_lossy(),
    })
}
