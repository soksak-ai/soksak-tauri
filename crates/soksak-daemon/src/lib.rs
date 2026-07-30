//! 상주 자식 데몬 — 스폰·출력 링·크래시 재시작(backoff)·종료 사다리.
//!
//! 데몬은 OS 프로세스다. 이 몸이 프레임워크에서 쓰던 것은 **사건 발행 한 자리**뿐이라, 그 자리를
//! 주입으로 받으면 어느 프로세스 밑에서도 같은 답을 낸다.
//!
//! 상태 변화는 발행으로 알린다 — 폴링 없음. 자식 종료 감시만 유한 폴링인데, waitpid 블로킹은
//! 출력 링 수집과 양립하지 않아서다(상한 있고, 초과하면 죽인다).

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

// 자르는 규칙·argv 조립·회수 대조는 코어가 소유한다. 두 벌이면 같은 실행이 프로세스마다
// 다른 줄 수를 답하고, 그 차이는 오류가 아니라 사라진 로그로 나타난다.
use soksak_core::shellq::{ps_command_argv, reap_matches, ring_push, run_once_argv, RING_CAP};

/// on-crash 재시작 상한 — 이 횟수를 넘으면 crashed 로 멈춘다(무한 재시작 금지).
const RESTART_CAP: u32 = 5;
/// 종료 유예(초) — SIGTERM 후 이 시간 안에 종료되지 않으면 그룹 SIGKILL.
pub const STOP_GRACE_SECS: u64 = 5;

pub fn key(root: &str, name: &str) -> String {
    format!("{root}\u{0}{name}")
}

/// on-crash 백오프(초) — 지수(1,2,4,8,16), 상한 도달 여부는 호출자가 RESTART_CAP 으로 판정.
fn backoff_secs(restarts: u32) -> u64 {
    1u64 << restarts.min(4)
}

#[derive(Clone, Serialize)]
pub struct DaemonStatus {
    pub root: String,
    pub name: String,
    pub pid: u32,
    pub running: bool,
    /// 종료했다면 그 코드(신호 종료는 None 유지 + running=false).
    pub exit_code: Option<i32>,
    pub uptime_ms: u128,
    pub restarts: u32,
}

pub struct DaemonEntry {
    pub root: String,
    pub name: String,
    // 스폰 명령 — postmortem/점검용 보존. 리핑은 살아있는 프로세스의 실제 command 로 대조(reap_matches).
    #[allow(dead_code)]
    pub cmd: String,
    /// 이 데몬을 소유한 창 라벨(P6: 창=프로젝트) — 창 파괴 시 함께 정리한다.
    pub window: String,
    pub child: Arc<Mutex<Child>>,
    pub ring: Arc<Mutex<VecDeque<String>>>,
    pub started: Instant,
    pub restarts: u32,
    pub running: Arc<Mutex<(bool, Option<i32>)>>,
    /// stop 이 명시된 데몬은 wait 스레드가 on-crash 재시작을 하지 않는다.
    pub stopping: Arc<Mutex<bool>>,
}

#[derive(Default)]
pub struct DaemonManager {
    pub inner: Arc<Mutex<HashMap<String, DaemonEntry>>>,
}

impl DaemonManager {
    /// 앱 종료 시 전 데몬의 프로세스 그룹을 종료한다(잔존 방지) — ExitRequested 에서 호출.
    pub fn kill_all(&self) {
        let map = self.inner.lock().unwrap();
        for e in map.values() {
            *e.stopping.lock().unwrap() = true;
            kill_group(&e.child, true);
        }
    }

    /// 창 파괴 시 그 창이 소유한 데몬을 전부 종료한다 — 프로젝트 닫힘 = 데몬 수명 종료.
    pub fn kill_by_window(&self, label: &str) {
        let map = self.inner.lock().unwrap();
        for e in map.values() {
            if e.window == label {
                *e.stopping.lock().unwrap() = true;
                kill_group(&e.child, true);
            }
        }
    }
}

/// 프로세스 그룹에 신호 — graceful=false 면 즉시 SIGKILL. 직계 kill 폴백 포함(멱등).
pub fn kill_group(child: &Arc<Mutex<Child>>, force: bool) {
    if let Ok(mut c) = child.lock() {
        #[cfg(unix)]
        unsafe {
            let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
            libc::killpg(c.id() as i32, sig);
        }
        if force {
            let _ = c.kill();
        }
        #[cfg(not(unix))]
        {
            // 윈도우: 트리 종료는 taskkill /T — Job Object 도입 전의 표준 경로.
            let _ = Command::new("taskkill")
                .args([
                    "/PID",
                    &c.id().to_string(),
                    "/T",
                    if force { "/F" } else { "" },
                ])
                .output();
        }
    }
}

/// 로그인 셸 — 호스트가 부팅에서 확정한 값을 준다. 여기서 환경을 다시 읽으면 재시작이 조용히
/// 다른 셸로 갈아탄다(입구가 준 값을 그대로 나르는 것이 이 모듈의 규칙이다).
/// 주어진 셸로 스폰 — GUI PATH 함정 대응(로그인 셸 래핑, npm_global_dirs 와 동일 기법).
pub fn spawn_shell(
    shell: &str,
    root: &str,
    cmd: &str,
    env: Option<&HashMap<String, String>>,
) -> Result<Child, String> {
    // 플래그 분기(`-lc` / `/C`)는 코어가 소유한다 — 조립이 두 벌이면 앱과 cored 가 같은
    // 명령을 다른 셸 호출로 돌린다. 플랫폼은 인자로 넘긴다(코어는 자기 서술을 하지 않는다).
    let (prog, argv) = run_once_argv(shell, cmd, !cfg!(unix));
    let mut c = Command::new(prog);
    c.args(argv);
    c.current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Caller-supplied env (e.g. GH_TOKEN for the publish gh child). Injected into the child's
    // environment — not this process's — so a token never lands in the parent or its trace.
    if let Some(vars) = env {
        c.envs(vars);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // pgid = 자식 pid — 그룹 신호가 트리 전체를 겨눈다.
    }
    c.spawn().map_err(|e| format!("데몬 스폰 실패: {e}"))
}

/// 상태 변화가 가는 곳 — 호스트가 준다. 그 통로는 그 프로세스의 것이라 프로세스를 못 건넌다.
pub trait DaemonEvents: Send + Sync + 'static {
    fn emit(&self, payload: serde_json::Value);
}

fn emit_daemon(ev: &dyn DaemonEvents, root: &str, name: &str, event: &str, code: Option<i32>) {
    ev.emit(serde_json::json!({ "root": root, "name": name, "event": event, "code": code }));
}

pub fn pump_lines<R: std::io::Read + Send + 'static>(src: R, ring: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(src);
        for line in reader.lines() {
            match line {
                Ok(l) => ring_push(&mut ring.lock().unwrap(), l, RING_CAP),
                Err(_) => break,
            }
        }
    });
}

/// 데몬 하나를 실제로 띄우고 관찰 스레드를 붙인다 — start 와 on-crash 재시작이 공유하는 단일 경로.
/// 셸 경로는 입구가 준 값을 그대로 나른다 — 재시작도 같은 셸이어야 한다(환경을 다시 읽으면
/// 재시작이 조용히 다른 셸로 갈아탄다).
#[allow(clippy::too_many_arguments)]
pub fn launch(
    ev: std::sync::Arc<dyn DaemonEvents>,
    mgr: Arc<Mutex<HashMap<String, DaemonEntry>>>,
    shell: String,
    root: String,
    name: String,
    cmd: String,
    window: String,
    restart_on_crash: bool,
    restarts: u32,
) -> Result<u32, String> {
    let mut child = spawn_shell(&shell, &root, &cmd, None)?;
    let pid = child.id();
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(out) = child.stdout.take() {
        pump_lines(out, ring.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, ring.clone());
    }
    let child = Arc::new(Mutex::new(child));
    let running = Arc::new(Mutex::new((true, None::<i32>)));
    let stopping = Arc::new(Mutex::new(false));
    let entry = DaemonEntry {
        root: root.clone(),
        name: name.clone(),
        cmd: cmd.clone(),
        window: window.clone(),
        child: child.clone(),
        ring,
        started: Instant::now(),
        restarts,
        running: running.clone(),
        stopping: stopping.clone(),
    };
    mgr.lock().unwrap().insert(key(&root, &name), entry);
    emit_daemon(ev.as_ref(), &root, &name, "started", None);

    // 관찰 스레드 — wait 로 종료를 감지(폴링 없음), 필요 시 백오프 재시작.
    std::thread::spawn(move || {
        let code = loop {
            // wait 는 child mutex 를 잡지 않는 try_wait 루프가 아니라, 짧은 sleep 병행의 try_wait 다.
            // 이유: kill 경로(kill_group)가 같은 mutex 를 즉시 잡을 수 있어야 한다(process.rs 데드락 회피).
            {
                let mut c = child.lock().unwrap();
                match c.try_wait() {
                    Ok(Some(st)) => break st.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        *running.lock().unwrap() = (false, code);
        emit_daemon(ev.as_ref(), &root, &name, "exited", code);
        let was_stopping = *stopping.lock().unwrap();
        let crashed = !was_stopping && code != Some(0);
        if restart_on_crash && crashed {
            if restarts + 1 > RESTART_CAP {
                emit_daemon(ev.as_ref(), &root, &name, "crashed", code);
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(backoff_secs(restarts)));
            // 재시작 사이에 stop 이 왔으면 접는다.
            if *stopping.lock().unwrap() {
                return;
            }
            let _ = launch(std::sync::Arc::clone(&ev), mgr, shell, root, name, cmd, window, true, restarts + 1);
        }
    });
    Ok(pid)
}

// ── 명령의 몸 ────────────────────────────────────────────────────────────────

/// 데몬 하나를 띄운다. 이미 도는 이름은 이름을 달고 거절한다 — 조용히 두 번 띄우면 같은
/// 이름에 프로세스가 둘 생기고, 그 둘은 서로를 모른다.
pub fn start(
    mgr: &DaemonManager,
    ev: std::sync::Arc<dyn DaemonEvents>,
    shell: String,
    root: String,
    name: String,
    cmd: String,
    window: String,
    restart_on_crash: bool,
) -> Result<u32, String> {
    let k = key(&root, &name);
    {
        let map = mgr.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = map.get(&k) {
            if e.running.lock().unwrap_or_else(|e| e.into_inner()).0 {
                return Err(format!("이미 실행 중: {name}"));
            }
        }
    }
    launch(
        ev,
        mgr.inner.clone(),
        // 셸 경로는 입구에서 한 번 읽어 아래로 흘린다 — 재시작도 같은 셸이어야 한다.
        shell,
        root,
        name,
        cmd,
        window,
        restart_on_crash,
        0,
    )
}

/// 데몬 장부에 올리지 않으며, 상한 시간 안에 끝나지 않으면 트리를 종료하고 오류를 알린다.
pub fn run_once(
    shell: String,
    root: String,
    cmd: String,
    timeout_secs: Option<u64>,
    env: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let mut child = spawn_shell(&shell, &root, &cmd, env.as_ref())?;
    let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(out) = child.stdout.take() {
        pump_lines(out, ring.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump_lines(err, ring.clone());
    }
    let limit = std::time::Duration::from_secs(timeout_secs.unwrap_or(60));
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) => {}
            Err(e) => return Err(format!("대기 실패: {e}")),
        }
        if started.elapsed() > limit {
            let shared = Arc::new(Mutex::new(child));
            kill_group(&shared, true);
            return Err(format!("시간 초과({}초): {cmd}", limit.as_secs()));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let lines: Vec<String> = ring.lock().unwrap().iter().cloned().collect();
    Ok(serde_json::json!({ "code": code, "lines": lines }))
}

/// ExitRequested 정리 훅 — lib.rs 가 부른다.

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

/// 멈춤 — 그룹에 신호를 보내고, 유예 뒤 강제한다.
///
/// 에스컬레이션은 관찰 스레드가 종료를 먼저 잡아도 무해하다(멱등). 유예를 안 두면 셸이 자식을
/// 정리할 틈 없이 죽어 손자 프로세스가 남는다.
pub fn stop(state: &DaemonManager, root: String, name: Option<String>) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let mut stopped = Vec::new();
    for e in map.values() {
        if e.root != root {
            continue;
        }
        if name.as_deref().is_some_and(|n| e.name != n) {
            continue;
        }
        if !e.running.lock().unwrap().0 {
            continue;
        }
        *e.stopping.lock().unwrap() = true;
        kill_group(&e.child, false);
        stopped.push(e.name.clone());
        let child = e.child.clone();
        let running = e.running.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(STOP_GRACE_SECS));
            if running.lock().unwrap().0 {
                kill_group(&child, true);
            }
        });
    }
    Ok(stopped)
}

/// 지금 상태 — root 를 주면 그 뿌리만.
pub fn status(state: &DaemonManager, root: Option<String>) -> Vec<DaemonStatus> {
    let map = state.inner.lock().unwrap();
    map.values()
        .filter(|e| root.as_deref().is_none_or(|r| e.root == r))
        .map(|e| {
            let (running, exit_code) = *e.running.lock().unwrap();
            DaemonStatus {
                root: e.root.clone(),
                name: e.name.clone(),
                pid: e.child.lock().unwrap().id(),
                running,
                exit_code,
                uptime_ms: e.started.elapsed().as_millis(),
                restarts: e.restarts,
            }
        })
        .collect()
}

/// 출력 링의 끝에서 n 줄.
pub fn logs(
    state: &DaemonManager,
    root: String,
    name: String,
    lines: Option<usize>,
) -> Result<Vec<String>, String> {
    let map = state.inner.lock().unwrap();
    let e = map
        .get(&key(&root, &name))
        .ok_or_else(|| format!("데몬 없음: {name}"))?;
    let ring = e.ring.lock().unwrap();
    let n = lines.unwrap_or(100).min(RING_CAP);
    Ok(ring.iter().rev().take(n).rev().cloned().collect())
}

/// 비정상 종료 뒤 잔존 회수 — 부른 쪽이 기록해 둔 (pid, cmd) 목록을 넘긴다.
///
/// pid 는 재사용된다. 명령줄이 선언 cmd 와 대조될 때만 그룹을 종료한다 — 대조 없이 pid 로만
/// 죽이면 그 자리에 들어온 남의 프로세스를 죽인다.
pub fn reap(entries: Vec<(u32, String)>) -> Vec<u32> {
    let mut reaped = Vec::new();
    for (pid, cmd) in entries {
        #[cfg(unix)]
        {
            let (prog, argv) = ps_command_argv(pid);
            let out = Command::new(prog).args(argv).output();
            let alive_cmd = out
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            if !alive_cmd.is_empty() && reap_matches(&alive_cmd, &cmd) {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                reaped.push(pid);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = cmd;
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
            reaped.push(pid);
        }
    }
    reaped
}
