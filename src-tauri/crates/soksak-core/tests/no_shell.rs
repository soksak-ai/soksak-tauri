//! 이 크레이트에는 셸이 없다 — 소스와 의존성 양쪽으로 시행한다.
//!
//! 계약(lib.rs 머리말)을 문서로만 두면 하루 만에 샌다. 여기 있는 검사가 그 계약이다.
//! 새 코드를 이 크레이트에 넣기 전에 이 파일을 읽어라.

use std::path::{Path, PathBuf};

fn sources() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out
}

/// 소스에 있으면 안 되는 심볼. 각 항목은 "왜 이동을 막는가"를 함께 적는다 —
/// 이유 없는 금지는 우회 대상이 된다.
const FORBIDDEN: &[(&str, &str)] = &[
    ("tauri::", "셸 타입은 프로세스를 못 넘는다"),
    ("AppHandle", "앱 프로세스 전제"),
    ("State<", "관리 상태 — 프로세스마다 다른 인스턴스"),
    (".emit(", "창으로 미는 사건 — 창 없는 프로세스에서는 무의미"),
    ("env::var", "프로세스 환경 — 옮기면 같은 코드가 다른 답을 낸다"),
    ("env::current_dir", "현재 디렉터리는 프로세스의 것"),
    ("env::current_exe", "실행 파일 경로는 프로세스의 것"),
    ("env::temp_dir", "임시 경로도 환경 파생 — 인자로 받는다"),
    ("home_dir", "홈은 인자로 온다"),
    ("cfg!(target_os", "자기 서술 — 타깃이 필요하면 인자로 받는다"),
    // target_os 만 막으면 같은 자기 서술이 다른 철자로 그대로 들어온다. cfg!(windows) 는
    // cfg!(target_os = "windows") 와 같은 말이고, unix 는 그보다 넓다.
    ("cfg!(windows", "동일 — 철자만 다른 자기 서술"),
    ("cfg!(unix", "동일 — 더 넓은 자기 서술"),
    ("OnceLock", "앰비언트 전역 — 첫 호출자가 값을 정한다"),
    ("lazy_static", "동일"),
    ("static mut", "동일"),
];

#[test]
fn no_forbidden_symbol_in_sources() {
    let files = sources();
    // 오라클 생존 단언 — 스캔이 죽으면 이 게이트는 아무것도 지키지 않는다("0"의 두 얼굴).
    assert!(files.len() >= 3, "소스를 못 읽었다: {}", files.len());

    let mut hits = Vec::new();
    for f in &files {
        let src = std::fs::read_to_string(f).unwrap_or_default();
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let mut in_test = false;
        let mut depth: i32 = 0;
        for (i, line) in src.lines().enumerate() {
            // 테스트 모듈은 자기 환경을 스스로 만든다 — 세지 않는다.
            if line.contains("#[cfg(test)]") {
                in_test = true;
                depth = 0;
            }
            if in_test {
                depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
                if depth <= 0 && line.contains('}') {
                    in_test = false;
                }
                continue;
            }
            let code = line.split("//").next().unwrap_or("");
            for (sym, why) in FORBIDDEN {
                if code.contains(sym) {
                    hits.push(format!("{name}:{}: {sym} — {why}", i + 1));
                }
            }
        }
    }
    assert_eq!(hits, Vec::<String>::new(), "코어 크레이트에 셸이 섞였다");
}

#[test]
fn the_dependency_tree_carries_no_shell_crate() {
    // 심볼 검사는 직접 참조만 잡는다. 의존성을 타고 들어온 셸은 cargo 만 안다.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent());
    let Some(root) = root else { return };
    let out = std::process::Command::new(env!("CARGO"))
        .args(["tree", "-p", "soksak-core", "-e", "normal", "--prefix", "none"])
        .current_dir(root)
        .output();
    let Ok(out) = out else { return };
    let tree = String::from_utf8_lossy(&out.stdout).to_lowercase();
    assert!(!tree.is_empty(), "의존성 트리를 못 읽었다 — 게이트가 통과로 위장한다");
    // 크레이트 **이름**으로 대조한다. 부분문자열로 보면 block-buffer 가 block2 에,
    // tao 가 여러 이름에 걸린다(첫 판이 그렇게 오탐했다).
    let names: Vec<&str> = tree
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    for banned in [
        "tauri", "wry", "tao", "objc2", "block2", "libloading", "notify", "rusqlite",
        "clipboard-rs", "x11rb", "windows-sys", "tokio", "interprocess",
    ] {
        assert!(
            !names.iter().any(|n| *n == banned || n.starts_with(&format!("{banned}-"))),
            "의존성에 셸/런타임 크레이트가 있다: {banned}"
        );
    }
}
