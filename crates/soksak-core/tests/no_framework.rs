//! 이 크레이트에는 프레임워크가 없다 — 소스와 의존성 양쪽으로 시행한다.
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
    ("tauri::", "프레임워크 타입은 프로세스를 못 넘는다"),
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

/// 금지 심볼을 **부르지 않고 이름으로만** 든 자리의 사면 — (파일명, 심볼, 사유).
///
/// 규칙 중에는 금지 심볼 자체가 대상인 것이 있다. 앰비언트 등재 게이트(`ambient_gate.rs`)는
/// 환경을 읽는 자리를 찾는 것이 그 일이라 그 문자열을 **바늘로** 들고 있어야 한다.
///
/// 문자열을 쪼개 숨기는 길(`concat!`)도 있지만 그것은 스캐너만 통과시킨다: 소스에서 바늘이
/// 사라지므로 읽는 사람은 이 코드가 무엇을 찾는지 알 수 없고, `grep` 으로 그 규칙을 찾아오는
/// 다음 사람도 못 찾는다. 숨긴 결합은 게이트만 속이는 것이 아니라 사람도 속인다.
///
/// 그래서 사면은 문장이 아니라 **판정**이다: 사면된 파일에서 그 심볼은 문자열 리터럴 안에만
/// 있어야 한다(아래 `names_without_calling`). 리터럴 밖에 한 번이라도 나오면 그것은 호출이고
/// 사면되지 않는다. 그리고 매칭 0건인 사면은 실패다 — 죽은 예외는 다음 위반의 문이 된다.
const NAMED_NOT_CALLED: &[(&str, &str, &str)] = &[(
    "ambient_gate.rs",
    "env::var",
    "앰비언트 등재 게이트의 바늘 — 환경을 읽는 자리를 찾는 것이 이 파일의 일이다. \
     이 파일 자신은 읽지 않는다(뿌리도 등재표도 인자로 온다).",
)];

/// 이 줄의 심볼이 전부 문자열 리터럴 안에 있는가 — 즉 이름으로만 들었는가.
///
/// 이스케이프(`\"`)를 따옴표로 세면 `format!("… env::var(\"{key}\") …")` 같은 줄에서 리터럴이
/// 중간에 끊긴 것으로 보이고, 그러면 이름으로 든 것을 호출로 오판한다. raw 문자열(`r#"…"#`)은
/// 다루지 않는다 — 지금 사면된 자리에 없고, 생기면 여기가 오판하는 쪽(거짓 위반)으로 틀린다.
fn names_without_calling(code: &str, sym: &str) -> bool {
    let bytes = code.as_bytes();
    let mut inside = vec![false; bytes.len()];
    let mut in_str = false;
    let mut escaped = false;
    for (i, b) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            inside[i] = in_str;
            continue;
        }
        match b {
            b'\\' if in_str => {
                escaped = true;
                inside[i] = true;
            }
            b'"' => {
                inside[i] = in_str;
                in_str = !in_str;
            }
            _ => inside[i] = in_str,
        }
    }
    let mut start = 0;
    while let Some(rel) = code[start..].find(sym) {
        let at = start + rel;
        if !inside[at] {
            return false;
        }
        start = at + 1;
    }
    true
}

/// 이 파일이 **검사 밖 테스트 모듈**인가 — `<모듈>_tests.rs` 는 다른 파일에서
/// `#[cfg(test)] #[path = "..."] mod` 로만 들어온다(비공개 항목에 닿기 위한 분리).
///
/// 인라인 `#[cfg(test)] mod tests` 를 세지 않는 것과 같은 규칙이다: 테스트 모듈은 자기 환경을
/// 스스로 만든다. 다만 이름만 보고 넘기면 이름이 곧 우회로가 되므로, 그 파일이 실제로
/// `#[cfg(test)]` 아래 선언됐는지 확인하고서만 넘긴다 — 선언이 없으면 그것은 실행 경로다.
fn declared_under_cfg_test(name: &str, files: &[PathBuf]) -> bool {
    if !name.ends_with("_tests.rs") {
        return false;
    }
    let needle = format!("#[path = \"{name}\"]");
    files.iter().any(|f| {
        let Ok(src) = std::fs::read_to_string(f) else {
            return false;
        };
        let lines: Vec<&str> = src.lines().collect();
        lines.iter().enumerate().any(|(i, l)| {
            l.trim() == needle
                // 바로 위 두 줄 안에 cfg(test) 가 있어야 한다(어트리뷰트 순서는 자유롭다).
                && lines[i.saturating_sub(2)..i]
                    .iter()
                    .any(|p| p.trim() == "#[cfg(test)]")
        })
    })
}

#[test]
fn no_forbidden_symbol_in_sources() {
    let files = sources();
    // 오라클 생존 단언 — 스캔이 죽으면 이 게이트는 아무것도 지키지 않는다("0"의 두 얼굴).
    assert!(files.len() >= 3, "소스를 못 읽었다: {}", files.len());

    let mut hits = Vec::new();
    let mut amnesty_used = vec![false; NAMED_NOT_CALLED.len()];
    for f in &files {
        let src = std::fs::read_to_string(f).unwrap_or_default();
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        if declared_under_cfg_test(&name, &files) {
            continue;
        }
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
                } else if depth == 0 && line.trim_end().ends_with(';') {
                    // 중괄호 없는 항목(`mod x;`)은 그 줄에서 끝난다. 닫는 중괄호만 기다리면
                    // 파일 나머지가 통째로 검사 밖이 되고, 그 구멍은 통과로 위장한다.
                    in_test = false;
                }
                continue;
            }
            let code = line.split("//").next().unwrap_or("");
            for (sym, why) in FORBIDDEN {
                if !code.contains(sym) {
                    continue;
                }
                let amnesty = NAMED_NOT_CALLED
                    .iter()
                    .position(|(file, s, _)| *file == name && s == sym);
                if let Some(idx) = amnesty {
                    if names_without_calling(code, sym) {
                        amnesty_used[idx] = true;
                        continue;
                    }
                }
                hits.push(format!("{name}:{}: {sym} — {why}", i + 1));
            }
        }
    }
    assert_eq!(hits, Vec::<String>::new(), "코어 크레이트에 프레임워크가 섞였다");

    // 죽은 사면 — 사면은 지금 있는 것을 설명하는 문장이지 미래를 위한 예약이 아니다.
    let dead: Vec<String> = NAMED_NOT_CALLED
        .iter()
        .zip(&amnesty_used)
        .filter(|(_, used)| !**used)
        .map(|((file, sym, why), _)| format!("{file}/{sym} ({why})"))
        .collect();
    assert_eq!(
        dead,
        Vec::<String>::new(),
        "사면이 가리키는 자리가 없다 — 지워라. 남겨두면 그 파일에 새로 생긴 같은 심볼이 답 없이 통과한다"
    );
}

/// 사면 판정 자체의 자격 — 이름으로 든 것과 부른 것을 실제로 가르는가.
///
/// 못 가르면 사면은 파일 통째 면제가 된다. 그 상태에서도 위반 0건은 나온다.
#[test]
fn an_amnesty_covers_naming_but_never_calling() {
    let sym = "env::var";
    assert!(names_without_calling("if !code.contains(\"env::var(\") { }", sym));
    // 이스케이프된 따옴표가 리터럴을 끊는 것으로 보이면 이름으로 든 줄이 호출로 오판된다.
    assert!(names_without_calling("out.push(format!(\"env::var(\\\"{key}\\\") 미등재\"));", sym));
    // 호출은 사면되지 않는다 — 리터럴 밖에 한 번이라도 나오면 그것으로 끝이다.
    assert!(!names_without_calling("let v = std::env::var(\"HOME\");", sym));
    assert!(!names_without_calling("let v = std::env::var(k); // \"env::var\"", sym));
}

/// 면제 판정 자체의 자격 — 이름만으로 넘기면 이름이 곧 우회로가 된다.
#[test]
fn only_a_declared_test_module_is_exempt() {
    let files = sources();
    assert!(
        declared_under_cfg_test("plugin_data_tests.rs", &files),
        "선언된 테스트 모듈을 못 알아봤다 — 게이트가 거짓 RED 를 낸다"
    );
    // 선언이 없으면 이름이 같아도 실행 경로다.
    assert!(!declared_under_cfg_test("smuggled_tests.rs", &files));
    // 접미가 아니면 대상 자체가 아니다.
    assert!(!declared_under_cfg_test("plugin_data.rs", &files));
}

#[test]
fn the_dependency_tree_carries_no_framework_crate() {
    // 심볼 검사는 직접 참조만 잡는다. 의존성을 타고 들어온 프레임워크는 cargo 만 안다.
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
            "의존성에 프레임워크/런타임 크레이트가 있다: {banned}"
        );
    }
}
