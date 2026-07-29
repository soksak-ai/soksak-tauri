// 앰비언트 의존 게이트(정적) — "이 값은 어디서 오는가"를 등재하게 강제한다.
//
// 프로세스 환경(`env::var`)에서 읽은 값은 **그 프로세스의 것**이다. 코드를 다른 프로세스로
// 옮기면 같은 코드가 다른 답을 낸다 — 그것도 조용히. cored 분리(2단계)에서 가장 비싼
// 오판이 이것이고, 정규식으로 잡히지 않는 이유는 문법이 아니라 **의미**의 문제이기 때문이다.
//
// 그래서 이 게이트는 금지하지 않는다. 등재를 강제한다: env 를 읽는 자리는 전부 아래 표에
// 있어야 하고, 각 항목은 "왜 이 프로세스의 환경이어야 하는가"와 "프로세스가 갈리면 무엇이
// 대신 오는가"를 밝혀야 한다. 새 자리가 생기면 답을 적기 전까지 RED 다.
//
// 적대적 감사(2026-07-27) 근거: `std::env::var("HOME")` 계열이 5개 핸들러의 이식을
// 막았고, `SHELL` 상속이 2개를 더 막았다. 그 자리들이 표에 있는 이유다.

/// env 읽기 한 자리. `why` 는 이 프로세스여야 하는 이유, `after_split` 은 프로세스가
/// 갈렸을 때 그 값이 어디서 오는지.
struct AmbientRead {
    file: &'static str,
    key: &'static str,
    why: &'static str,
    after_split: &'static str,
}

const ALLOWED: &[AmbientRead] = &[
    AmbientRead {
        file: "ai_session.rs",
        key: "HOME",
        why: "AI 에이전트 세션 디렉터리는 사용자 홈 아래에 있다(~/.claude, ~/.codex)",
        after_split: "호출자가 세션 루트를 인자로 넘긴다 — 감사가 이식 차단으로 지목한 자리",
    },
    AmbientRead {
        file: "fs.rs",
        key: "HOME",
        why: "파일 탐색의 시작점(사용자 홈)",
        after_split: "홈을 인자로 받는다",
    },
    AmbientRead {
        file: "fs.rs",
        key: "USERPROFILE",
        why: "윈도우의 HOME 대응",
        after_split: "동일",
    },
    AmbientRead {
        file: "home.rs",
        key: "HOME",
        why: "identity 홈의 부모. 이 값 하나에서 모든 홈 경로가 파생된다",
        after_split: "Identity 계약이 홈을 값으로 나른다(identity.rs)",
    },
    AmbientRead {
        file: "home.rs",
        key: "USERPROFILE",
        why: "윈도우의 HOME 대응",
        after_split: "동일",
    },
    AmbientRead {
        file: "pty.rs",
        key: "COMSPEC",
        why: "윈도우의 SHELL 대응",
        after_split: "동일",
    },
    AmbientRead {
        file: "pty.rs",
        key: "ZDOTDIR",
        why: "zsh 시작 파일 위치 — 셸 초기화를 사용자 설정대로 재현한다",
        after_split: "PTY 세션 env 로 함께 전달된다",
    },
    AmbientRead {
        file: "pty.rs",
        key: "HOME",
        why: "ZDOTDIR 부재 시의 zsh 기본 위치",
        after_split: "동일",
    },
    AmbientRead {
        file: "login_shell.rs",
        key: "SHELL",
        why: "사용자 로그인 셸 — PTY 기본 셸·데몬 spawn·npm prefix 가 모두 이 값을 쓴다. 읽는 자리는 여기 하나이고 아래로는 인자로 흐른다",
        after_split: "부팅 인자로 온다 — $SHELL 은 프로세스 속성이 아니라 사용자 계정 속성이라 --home·--identifier 와 같은 자리다",
    },
    AmbientRead {
        file: "headless.rs",
        key: "SOKSAK_HEADLESS",
        why: "헤드리스 판정 — 이 프로세스가 창을 갖는가의 자기 서술",
        after_split: "프로세스마다 자기 답이 맞다(값이 프로세스를 따라가는 것이 옳은 드문 경우)",
    },
    AmbientRead {
        file: "pty.rs",
        key: "SOKSAK_PTYD_BIN",
        why: "PTY 데몬 바이너리 경로 override — 개발·테스트가 스테이징본을 지목한다",
        after_split: "cored 가 자기 바이너리 경로를 인자로 받는다",
    },
    AmbientRead {
        file: "mod.rs",
        key: "SOKSAK_DATA_DIR",
        why: "블랙박스 e2e 가 실 identity 홈 안에서 DB 만 격리한다(홈은 옮기지 않는다)",
        after_split: "데이터 경로를 Identity 와 함께 인자로 받는다",
    },
    AmbientRead {
        file: "secrets.rs",
        key: "SOKSAK_E2E_KEK",
        why: "e2e 가 키체인 프롬프트 없이 볼트를 열기 위한 주입 KEK",
        after_split: "KekSource 주입 seam 이 이미 있다 — env 는 그 구현 하나일 뿐",
    },
];

/// 이 파일은 **검사**인가 — 규칙이 아니라 그 증명이다.
///
/// 형제 검사 파일에는 `#[cfg(test)]` 가 없다(그 표시는 부르는 쪽에 있다). 그래서 파일 안을
/// 줄 단위로 보면 픽스처의 키 리터럴이 실행 경로로 보인다. 검사를 코드와 분리하는 것이 배치의
/// 법이므로(REPO-LAYOUT 법 4) 이 모양은 늘어난다.
fn is_test_file(name: &str) -> bool {
    name.ends_with("_tests.rs") || name.ends_with("_test.rs")
}

/// 실행 경로 줄만 남긴다 — 테스트 모듈은 뺀다. 반환은 (원본 줄 번호 0-base, 줄).
///
/// **모듈 모양이 둘이다.** 블록(`mod tests { … }`)과 선언(`mod tests;` — 몸이 형제 파일에 있다).
/// 선언을 블록으로 착각해 중괄호를 찾아 나서면 **다음에 나오는 아무 블록이나** 삼키고, 그 안의
/// 실행 경로가 스캔 밖으로 나간다. 위반 0건은 그때도 나오므로 통과를 위장한다
/// (실측 2026-07-29: 같은 결함이 core-decoupling-scan 에서 50줄을 삼켰다).
fn production_lines(src: &str) -> Vec<(usize, &str)> {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].contains("#[cfg(test)]") {
            // 속성·빈 줄은 선언과 mod 사이에 낄 수 있다(`#[path = "…"]`).
            let mut j = i + 1;
            while j < lines.len()
                && (lines[j].trim().is_empty() || lines[j].trim_start().starts_with("#["))
            {
                j += 1;
            }
            let is_mod = j < lines.len() && {
                let t = lines[j].trim_start();
                t.starts_with("mod ") || t.starts_with("pub mod ")
            };
            if is_mod && lines[j].trim_end().ends_with(';') {
                i = j + 1; // 선언 한 줄로 끝난다.
                continue;
            }
            // 블록이다 — 중괄호 깊이로 건너뛴다.
            let mut depth: i32 = 0;
            let mut seen = false;
            let mut k = j;
            while k < lines.len() {
                depth += lines[k].matches('{').count() as i32;
                if lines[k].contains('{') {
                    seen = true;
                }
                depth -= lines[k].matches('}').count() as i32;
                k += 1;
                if seen && depth <= 0 {
                    break;
                }
            }
            i = if seen { k } else { j + 1 };
            continue;
        }
        out.push((i, lines[i]));
        i += 1;
    }
    out
}

/// 등재 없이 env 를 읽는 자리를 찾는다.
fn unregistered() -> Vec<String> {
    let base = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs(std::path::Path::new(&base), &mut files);
    for path in files {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "ambient_gate.rs" || is_test_file(&name) {
            // 등재표 자신은 키 리터럴을 담는 것이 그 일이고, 형제 검사 파일은 규칙이 아니라
            // 그 증명이다 — 픽스처의 키를 실행 경로로 세면 고칠 수 없는 위반이 된다.
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap_or_default();
        // 테스트 모듈 안은 세지 않는다 — 테스트는 자기 환경을 스스로 만든다.
        for (i, line) in production_lines(&src) {
            let code = line.split("//").next().unwrap_or("");
            if !code.contains("env::var(") {
                continue;
            }
            // 키를 뽑는다: env::var("X") 또는 env::var(k) — 후자는 주입형이라 통과.
            let Some(rest) = code.split("env::var(").nth(1) else {
                continue;
            };
            let Some(key) = rest.strip_prefix('"').and_then(|r| r.split('"').next()) else {
                continue; // 리터럴이 아니면 호출자가 키를 준다 = 주입형
            };
            let known = ALLOWED
                .iter()
                .any(|a| a.file == name && a.key == key);
            if !known {
                out.push(format!("{name}:{}: env::var(\"{key}\") 미등재", i + 1));
            }
        }
    }
    out
}


/// 로그인 셸(`SHELL`)을 읽는 자리를 파일:줄로 모은다.
///
/// 등재표는 "왜 읽는가"를 묻지 "몇 곳이 읽는가"를 묻지 않는다. 그래서 셋이 각자 읽고 폴백이
/// 갈려도 표는 통과한다 — 그 상태가 실제로 있었다(pty.rs `/bin/bash`, daemon.rs·runtime_dep.rs
/// `/bin/sh`). 같은 프로세스가 같은 질문에 두 답을 갖는 것은 그 자체로 결함이다.
fn login_shell_readers() -> Vec<String> {
    let base = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs(std::path::Path::new(&base), &mut files);
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "ambient_gate.rs" || is_test_file(&name) {
            continue; // 등재표 자신, 그리고 규칙이 아니라 그 증명인 형제 검사 파일
        }
        let src = std::fs::read_to_string(&path).unwrap_or_default();
        for (i, line) in production_lines(&src) {
            if line.contains("env::var(\"SHELL\")") {
                out.push(format!("{name}:{}", i + 1));
            }
        }
    }
    out
}

fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_rs(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[cfg(test)]
#[path = "ambient_gate_tests.rs"]
mod tests;
