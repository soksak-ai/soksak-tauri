// 스킬 자동 재생성 스폰 — 레지스트리(플러그인 활성 집합)가 변하면 프런트가 이 명령을 부르고,
// 여기서는 identity 홈의 skill-refresh.json(설치 시 CLI 가 기록)대로 그 CLI 를 `skill refresh` 로
// 분리 스폰한다. 렌더 로직의 단일 진실은 CLI — 앱은 방아쇠만 소유한다(P8 쓰기-스루).
//
// 매니페스트를 읽고 argv 를 조립하는 것은 코어가 소유한다. 부재(설치 전)와 고장(잘못 적힌
// 매니페스트)을 가르는 규칙이 두 벌이 되면, 같은 홈에 같은 이름으로 물어도 프로세스마다
// 다른 답이 나온다.
use std::process::{Command, Stdio};

#[tauri::command]
pub fn skill_refresh_spawn() -> Result<bool, String> {
    let home = crate::identity::ambient().home().to_path_buf();
    let Some((cli, argv)) = soksak_core::skillgen::skill_refresh_argv(&home)? else {
        return Ok(false); // 설치 전 — 재생성할 스킬이 없다(오류 아님).
    };
    Command::new(cli)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("스킬 재생성 스폰 실패: {e}"))?;
    Ok(true)
}
