// 세션 규칙의 검사 — 재는 것이 전부 이 크레이트의 함수라 여기 산다.
//
// 껍데기에 두면 몸을 밖으로 뺄 때마다 그 파일의 재수출이 검사와 함께 흔들리고, 껍데기가
// 안 쓰는 이름을 검사 때문에 계속 들여야 한다.

use super::*;
use std::path::Path;

// 검사가 부르는 모양 — 커맨드 층이 String 을 받아 Path 로 넘기는 그 자리다.
fn inspect_path(p: String) -> Result<Option<SessionInfo>, String> {
inspect(std::path::Path::new(&p))
}

// 세션 루트는 인자다. 프로세스 환경에서 읽으면 같은 코드가 프로세스마다 다른 홈을
// 가리키고, 그건 거부가 아니라 **다른 사용자의 세션을 여는 것**으로 끝난다.
#[test]
fn 세션_경로는_받은_홈에서_나온다() {
    assert_eq!(
        session_dir_for("/given/home", "/workspace/proj").unwrap(),
        "/given/home/.claude/projects/-workspace-proj",
        "환경의 HOME 이 아니라 받은 홈이어야 한다"
    );
    assert!(session_dir_for("/given/home", "").is_err(), "빈 cwd 는 거부");
}

// 탐색도 같은 축이다 — 없는 홈에서는 조용히 None(그 홈에 세션이 없다는 사실 그대로).
#[test]
fn 세션_탐색도_받은_홈만_본다() {
    let d = std::env::temp_dir().join(format!("aisess-find-{}", uuid::Uuid::new_v4()));
    let dir = claude_session_dir(&d.to_string_lossy(), "/w");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("accd937f-5c22-48c6-b83d-70a2e0f2e4aa.jsonl"),
        "{\"sessionId\":\"accd937f-5c22-48c6-b83d-70a2e0f2e4aa\",\"cwd\":\"/w\"}\n",
    )
    .unwrap();
    let found = find_newest_session(&d.to_string_lossy(), "/w").unwrap().unwrap();
    assert_eq!(found.session_id, "accd937f-5c22-48c6-b83d-70a2e0f2e4aa");
    // 다른 홈에는 그 세션이 없다 — 홈이 답을 가른다는 증거.
    assert!(find_newest_session("/no/such/home", "/w").unwrap().is_none());
    let _ = std::fs::remove_dir_all(&d);
}

// 추적기는 상태만 있으면 선다 — State 를 벗기는 것은 커맨드 층의 일이다.
#[test]
fn 추적_전이는_state_없이_선다() {
    let dir = std::env::temp_dir().join(format!("aisess-track-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();
    let t = SessionTracker::default();
    std::fs::write(
        dir.join("accd937f-5c22-48c6-b83d-70a2e0f2e4aa.jsonl"),
        "{}",
    )
    .unwrap();
    assert_eq!(
        t.active(&path).as_deref(),
        Some("accd937f-5c22-48c6-b83d-70a2e0f2e4aa"),
        "새 세션 등장 = 전이"
    );
    assert_eq!(t.active(&path), None, "변화 없으면 전이 아님");
    t.forget(&path);
    assert!(
        t.active(&path).is_some(),
        "스냅샷을 폐기했으니 다시 '새 세션'으로 보인다"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// 경로 가드가 부분문자열이면 그 문자열을 **어디에** 넣어도 통과한다. 지금은 앞단의
// 플러그인 API 게이트가 가려 주지만, 이 핸들러가 프로세스를 나가는 순간 이것이 유일한
// 게이트가 된다 — 그때는 임의 파일 읽기 프리미티브다.
#[test]
fn a_decoy_segment_does_not_open_arbitrary_files() {
    let d = std::env::temp_dir().join(format!("aisess-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    let secret = d.join("secret.txt");
    std::fs::write(&secret, "TOP-SECRET").unwrap();

    // ① 세션 디렉터리 이름을 파일명에 심었다 — 부분문자열은 통과, 앵커는 거부.
    let decoy = d.join("x .claude/projects/ y.jsonl".replace('/', "_"));
    std::fs::write(&decoy, "TOP-SECRET").unwrap();
    let r = inspect_path(decoy.to_string_lossy().into());
    assert!(r.is_err(), "미끼 파일명이 통과했다: {r:?}");

    // ② 세션 디렉터리를 지난 뒤 '..' 로 빠져나간다.
    let deep = d.join(".claude").join("projects");
    let _ = std::fs::create_dir_all(&deep);
    let escape = deep.join("..").join("..").join("secret.txt");
    let r = inspect_path(escape.to_string_lossy().into());
    assert!(r.is_err(), "'..' 탈출이 통과했다: {r:?}");

    let _ = std::fs::remove_dir_all(&d);
}

// 진짜 세션 파일은 계속 읽혀야 한다 — 가드가 기능을 죽이면 그것도 결함이다.
#[test]
fn a_real_session_path_still_reads() {
    let d = std::env::temp_dir()
        .join(format!("aisess-ok-{}", std::process::id()))
        .join(".claude")
        .join("projects");
    let _ = std::fs::create_dir_all(&d);
    let f = d.join("s.jsonl");
    std::fs::write(&f, "{\"sessionId\":\"accd937f-5c22-48c6-b83d-70a2e0f2e4aa\",\"cwd\":\"/tmp\"}\n").unwrap();
    let r = inspect_path(f.to_string_lossy().into());
    assert!(r.is_ok(), "정상 세션 경로가 거부됐다: {r:?}");
    let _ = std::fs::remove_dir_all(d.parent().unwrap().parent().unwrap());
}

// sessionId 화이트리스트 — 실측 UUID 통과, 위조/잘못된 포맷 거부.
#[test]
fn session_id_whitelist() {
    assert!(is_valid_session_id("accd937f-5c22-48c6-b83d-70a2e0f2e4aa")); // claude v4
    assert!(is_valid_session_id("019d09a1-6bc4-7691-9458-088bde7fca3d")); // codex v7
    assert!(!is_valid_session_id("not-a-uuid"));
    assert!(!is_valid_session_id("'; DROP TABLE records;--"));
    assert!(!is_valid_session_id("accd937f5c2248c68b3d70a2e0f2e4aa")); // 하이픈 없음
    assert!(!is_valid_session_id("accd937f-5c22-48c6-b83d-70a2e0f2e4a")); // 35자
    assert!(!is_valid_session_id("zzzz937f-5c22-48c6-b83d-70a2e0f2e4aa")); // 비-hex
    assert!(!is_valid_session_id(""));
}

// 에이전트 탐지 — 경로·인자 동반 명령에서 basename 으로 판정.
#[test]
fn agent_detection() {
    assert_eq!(detect_agent("claude"), Some(AgentKind::Claude));
    assert_eq!(detect_agent("claude --resume"), Some(AgentKind::Claude));
    assert_eq!(
        detect_agent("/usr/local/bin/codex --model gpt"),
        Some(AgentKind::Codex)
    );
    assert_eq!(detect_agent("codex"), Some(AgentKind::Codex));
    assert_eq!(detect_agent("vim file.txt"), None);
    assert_eq!(detect_agent("npm run claude"), None); // 첫 토큰만(npm) — false positive 방지
    assert_eq!(detect_agent(""), None);
}

// claude 파싱 — 실측 포맷(첫 줄 cwd 없음, 다른 줄에 cwd). sessionId/cwd 각각 첫 등장 줄에서.
#[test]
fn parse_claude_real_shape() {
    let content = r#"{"leafUuid":"x","sessionId":"accd937f-5c22-48c6-b83d-70a2e0f2e4aa","type":"summary"}
{"type":"attachment","cwd":"/workspace/project","sessionId":"accd937f-5c22-48c6-b83d-70a2e0f2e4aa"}"#;
    let info = parse_claude(content).unwrap();
    assert_eq!(info.kind, AgentKind::Claude);
    assert_eq!(info.session_id, "accd937f-5c22-48c6-b83d-70a2e0f2e4aa");
    assert_eq!(info.cwd, "/workspace/project");
}

// codex 파싱 — session_meta 줄의 payload.{id, cwd}. 이후 response_item 줄은 무시.
#[test]
fn parse_codex_real_shape() {
    let content = r#"{"payload":{"id":"019d09a1-6bc4-7691-9458-088bde7fca3d","cwd":"/workspace/proj","cli_version":"x"},"timestamp":"t","type":"session_meta"}
{"payload":{"content":[],"role":"user","type":"message"},"timestamp":"t","type":"response_item"}"#;
    let info = parse_codex(content).unwrap();
    assert_eq!(info.kind, AgentKind::Codex);
    assert_eq!(info.session_id, "019d09a1-6bc4-7691-9458-088bde7fca3d");
    assert_eq!(info.cwd, "/workspace/proj");
}

// 세션 전이 감지 — 두 스냅샷 비교로 '지금 쓰이는 세션'(새/갱신 중 최신). 전이 시퀀스의 코어.
#[test]
fn active_session_transition() {
    use std::collections::BTreeMap;
    let a = "accd937f-5c22-48c6-b83d-70a2e0f2e4aa".to_string();
    let b = "019d09a1-6bc4-7691-9458-088bde7fca3d".to_string();
    // 시작: A 만 존재 → A 활성.
    let s0: BTreeMap<String, i64> = BTreeMap::new();
    let s1 = BTreeMap::from([(a.clone(), 1000)]);
    assert_eq!(
        active_session(&s0, &s1),
        Some(a.clone()),
        "새 세션 A 등장 → 활성"
    );
    // 변화 없음 → None(전이 아님).
    assert_eq!(active_session(&s1, &s1), None, "변화 없으면 전이 아님");
    // /clear: 새 파일 B 생성(A 그대로) → B 활성 = A→B 전이.
    let s2 = BTreeMap::from([(a.clone(), 1000), (b.clone(), 2000)]);
    assert_eq!(
        active_session(&s1, &s2),
        Some(b.clone()),
        "새 세션 B → 전이"
    );
    // /resume A: 기존 A 파일 갱신(mtime↑) → A 활성 = B→A 전이.
    let s3 = BTreeMap::from([(a.clone(), 3000), (b.clone(), 2000)]);
    assert_eq!(
        active_session(&s2, &s3),
        Some(a.clone()),
        "기존 A 갱신 → 재활성 전이"
    );
}

// 스냅샷 — sessionId(UUID) 파일명만, 위조/잡파일 배제.
#[test]
fn snapshot_filters_non_session() {
    let dir = std::env::temp_dir().join(format!("soksak-aisess-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("accd937f-5c22-48c6-b83d-70a2e0f2e4aa.jsonl"), "{}").unwrap();
    std::fs::write(dir.join("not-a-session.jsonl"), "{}").unwrap(); // UUID 아님 → 배제
    std::fs::write(dir.join("readme.txt"), "x").unwrap(); // .jsonl 아님 → 배제
    let snap = snapshot_dir(&dir);
    assert_eq!(snap.len(), 1, "sessionId UUID .jsonl 만");
    assert!(snap.contains_key("accd937f-5c22-48c6-b83d-70a2e0f2e4aa"));
    let _ = std::fs::remove_dir_all(&dir);
}

// claude 세션 디렉토리 인코딩 — 실측 규칙('/'·'.' → '-'). watch/find 대상 경로.
#[test]
fn claude_dir_encoding() {
    assert_eq!(
        claude_session_dir("/home/u", "/workspace/project"),
        Path::new("/home/u/.claude/projects/-workspace-project")
    );
    // '/.' → '--' (실측: soksak/.cache → soksak--cache).
    assert_eq!(
        claude_session_dir("/h", "/workspace/soksak/.cache"),
        Path::new("/h/.claude/projects/-workspace-soksak--cache")
    );
    // 루트 cwd → "-".
    assert_eq!(
        claude_session_dir("/h", "/"),
        Path::new("/h/.claude/projects/-")
    );
}

// 깨진 줄(truncated tail)·위조 sessionId 는 건너뛰고 유효 줄에서 sessionId+cwd 를 취한다.
#[test]
fn skips_broken_and_forged() {
    // 1줄 깨진 JSON(skip), 2줄 위조 sessionId(거부) + cwd 없음, 3줄 유효.
    let content = "broken {not json\n{\"sessionId\":\"forged-not-uuid\",\"type\":\"x\"}\n{\"sessionId\":\"accd937f-5c22-48c6-b83d-70a2e0f2e4aa\",\"cwd\":\"/real\",\"type\":\"attachment\"}";
    let info = parse_claude(content).unwrap();
    assert_eq!(info.session_id, "accd937f-5c22-48c6-b83d-70a2e0f2e4aa");
    assert_eq!(info.cwd, "/real");
    // 유효 sessionId 가 한 줄도 없으면 None(위조만 있는 파일).
    assert!(parse_claude("{\"sessionId\":\"forged\",\"cwd\":\"/x\"}").is_none());
    // session_meta 없는 codex 내용 → None.
    assert!(parse_codex("{\"type\":\"response_item\",\"payload\":{}}").is_none());
}
