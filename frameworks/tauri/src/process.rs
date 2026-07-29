// 자식 프로세스의 **이 프레임워크 진입점** — 규칙은 코어가 소유한다(soksak_core::proc).
// 여기 있는 것은 벤더 채널을 계약 껍질로 감싸는 일과 커맨드 표면뿐이다.

use std::collections::HashMap;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

pub(crate) use soksak_core::proc::{
    resolve_sidecar_cmd, spawn_child, ProcessInfo, ProcessManager, SpawnRequest, AI_SESSION_ENV,
};

use crate::secrets::{self, SecretsState};
use crate::stream_sink::{ChannelSink, ExitChannelSink};

/// 이 앱의 볼트 — 시크릿 계약을 채우는 얇은 껍질. 평문은 이 경계를 지나 자식 env 로만 간다.
pub(crate) struct VaultSecrets<'a>(pub &'a SecretsState);

impl soksak_core::secret_env::SecretSource for VaultSecrets<'_> {
    fn resolve(&self, ns: &str, key: &str) -> Result<String, String> {
        secrets::resolve(self.0, ns, key)
    }
}

/// 웹뷰 입구 — State·Window·Channel 을 벗겨 값으로 옮기는 번역층. 인자 이름은 JS 계약이라
/// 그대로 둔다(여기가 바뀌면 호출자가 보는 답이 달라진다).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn process_spawn(
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    env_remove: Option<Vec<String>>,
    scrub_ai_env: Option<bool>,
    group: Option<bool>,
    detached: Option<bool>,
    ns: Option<String>,
    secret_env: Option<HashMap<String, String>>,
    on_stdout: Channel<InvokeResponseBody>,
    on_stderr: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
    window: tauri::Window,
    manager: State<'_, ProcessManager>,
    secrets_state: State<'_, SecretsState>,
) -> Result<u32, String> {
    spawn_child(
        // 앰비언트 전역은 여기서 한 번 값으로 꺼낸다 — 경계의 이쪽 끝(identity.rs).
        &crate::identity::ambient(),
        // 상속될 env 의 키 목록도 이 프로세스의 사실이다. 값은 넘기지 않는다 — 지울 이름만
        // 필요하고, 값까지 나르면 시크릿이 경계를 한 번 더 지난다.
        &std::env::vars().map(|(k, _)| k).collect::<Vec<_>>(),
        SpawnRequest {
            cmd,
            args,
            cwd,
            env,
            env_remove,
            scrub_ai_env: scrub_ai_env.unwrap_or(false),
            group: group.unwrap_or(false),
            detached: detached.unwrap_or(false),
            ns,
            secret_env,
            window: window.label().to_string(),
        },
        manager.inner(),
        &VaultSecrets(secrets_state.inner()),
        ChannelSink(on_stdout),
        ChannelSink(on_stderr),
        ExitChannelSink(on_exit),
    )
}

#[tauri::command]
pub fn process_write(
    id: u32,
    data: String,
    manager: State<'_, ProcessManager>,
) -> Result<(), String> {
    manager.write_stdin(id, data.as_bytes())
}

#[tauri::command]
pub fn process_stdin_close(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // stdin 만 닫는다(자식은 계속) — take → drop → 파이프 닫힘 → 자식이 EOF 수신. stdin 을 read_to_end
    // 하는 자식(파이프 입력 CLI)은 이 호출 없이는 영원히 블록한다. 이미 닫혔으면 no-op(멱등).
    manager.close_stdin(id)
}

/// 이 창의 앞선 플러그인 런타임이 남긴 자식을 거둔다. 창 파괴 회수(kill_by_window)와 같은
/// 규칙·같은 예외(detached 사이드카는 살린다)를 쓰되, 트리거가 다르다: 창은 살아 있고 그 안의
/// 런타임만 새로 선 경우(웹뷰 리로드·HMR·크래시 복구)를 위한 자리다. 새 런타임은 아직 아무것도
/// 스폰하지 않았으므로 이 시점에 이 창 앞으로 남은 것은 전부 앞선 런타임의 고아다.
#[tauri::command]
pub fn process_reclaim_window(window: tauri::Window, manager: State<'_, ProcessManager>) -> u32 {
    manager.reclaim_window(window.label())
}


/// 앱이 낳은 자식 프로세스 한 줄.

/// 앱이 낳은 자식 프로세스 전부. 코어는 플러그인 대신 프로세스를 쥐고 있으면서 그 목록을
/// 내놓지 않았다 — 그래서 회수에 실패한 자식(고아)이 밖에서는 보이지 않았다. 읽기 전용.
#[tauri::command]
pub fn process_list(manager: State<'_, ProcessManager>) -> Vec<ProcessInfo> {
    manager.list()
}

#[tauri::command]
pub fn process_kill(id: u32, manager: State<'_, ProcessManager>) -> Result<(), String> {
    // 세션 제거 + 자식 kill(group 스폰이면 트리 전체). stdin 드롭 → stdin 닫힘. kill → stdout
    // EOF → reader 가 on_exit 발신.
    manager.kill(id);
    Ok(())
}

// ── 볼트가 필요한 검사 ────────────────────────────────────────────────────────
// 스폰 규칙 자체는 코어가 잰다(soksak_core::proc). 여기 남는 것은 **이 앱의 볼트**가 있어야
// 성립하는 것들뿐이다 — 해소된 평문이 자식 env 로만 가고 값으로는 돌아오지 않는지.
#[cfg(test)]
mod vault_tests {
    use super::*;
    use crate::secrets::test_state_with_secret;
    use std::collections::HashMap;
    use std::process::Command;

    fn tmp_vault_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "soksak-proc-secret-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("secrets.vault")
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// 이 앱의 볼트로 해소한다 — 계약 껍질을 지나는 그 길 그대로.
    fn resolve_secret_env(
        state: &SecretsState,
        ns: Option<&str>,
        secret_env: &Option<HashMap<String, String>>,
    ) -> Result<Vec<(String, String)>, String> {
        soksak_core::secret_env::resolve_secret_env(&VaultSecrets(state), ns, secret_env)
    }


    // resolve_secret_env + 실제 spawn — secret_env{SOKSAK_SECRET_0:apiKey} 를 자식 env 로 주입하고
    // /bin/sh -c 'printf %s "$SOKSAK_SECRET_0"' 의 stdout 을 캡처해 평문 일치 확인(자식 env 실주입).
    #[test]
    fn secret_env_injected_into_child() {
        let path = tmp_vault_path("inject");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "sk-real-9z");

        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        let resolved = resolve_secret_env(&state, Some("plugin-a"), &secret_env).unwrap();

        // process_spawn 과 동일하게 Command env 로만 주입(평문은 여기서만).
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "printf %s \"$SOKSAK_SECRET_0\""]);
        for (k, v) in &resolved {
            c.env(k, v);
        }
        let out = c.output().expect("spawn sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "sk-real-9z");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 빈/None secret_env → 빈 벡터(주입 없음), ns 불요.
    // 빈/None secret_env → 빈 벡터(주입 없음), ns 불요.
    #[test]
    fn no_secret_env_is_empty() {
        let state = SecretsState::default();
        assert!(resolve_secret_env(&state, None, &None).unwrap().is_empty());
        assert!(resolve_secret_env(&state, None, &Some(HashMap::new()))
            .unwrap()
            .is_empty());
    }

    // secret_env 있는데 ns 없음 → Err(주입 0).
    // secret_env 있는데 ns 없음 → Err(주입 0).
    #[test]
    fn secret_env_without_ns_rejected() {
        let path = tmp_vault_path("no-ns");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let secret_env = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&state, None, &secret_env).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // 데드락 회귀 — 스스로 끝나지 않고 stdout 을 계속 쏟는 자식(OSR sidecar 와 동형)을 reader 가 drain
    // 하는 동안(= Channel 죽음 이후 경로) 다른 스레드에서 child mutex 를 잠그고 kill 이 즉시 되는지.
    // 과거 버그: reader 가 child mutex 를 잡은 채 wait() 로 영구 블록 → process_kill 이 같은 mutex 에서
    // 영구 대기 → 좀비(32GB swap). drain 은 mutex 미보유이므로 kill 이 즉시 되어야 한다.
    // 잠긴 볼트 → Err(spawn 0). 미존재 key → Err.
    #[test]
    fn locked_or_missing_rejected() {
        // 잠김 — unlock 안 한 기본 상태.
        let locked = SecretsState::default();
        let se = Some(map(&[("SOKSAK_SECRET_0", "apiKey")]));
        assert!(resolve_secret_env(&locked, Some("plugin-a"), &se).is_err());

        // 미존재 key.
        let path = tmp_vault_path("missing");
        let state = test_state_with_secret(path.clone(), "pw", "plugin-a", "apiKey", "v");
        let bad = Some(map(&[("SOKSAK_SECRET_0", "nope")]));
        assert!(resolve_secret_env(&state, Some("plugin-a"), &bad).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // detached danger 게이트 — detach 는 "sidecar:" 대상에만. 임의 프로그램 detach 거부.
}
