//! 앰비언트 의존 게이트(정적) — "이 값은 어디서 오는가"를 등재하게 강제한다.
//!
//! 프로세스 환경에서 읽은 값은 **그 프로세스의 것**이다. 코드를 다른 프로세스로 옮기면 같은
//! 코드가 다른 답을 낸다 — 그것도 조용히. cored 분리(2단계)에서 가장 비싼 오판이 이것이고,
//! 정규식으로 잡히지 않는 이유는 문법이 아니라 **의미**의 문제이기 때문이다.
//!
//! 그래서 이 게이트는 금지하지 않는다. 등재를 강제한다: 환경을 읽는 자리는 전부 아래 표에
//! 있어야 하고, 각 항목은 "왜 이 프로세스의 환경이어야 하는가"와 "프로세스가 갈리면 무엇이
//! 대신 오는가"를 밝혀야 한다. 새 자리가 생기면 답을 적기 전까지 RED 다.
//!
//! 적대적 감사(2026-07-27) 근거: `HOME` 계열이 5개 핸들러의 이식을 막았고, `SHELL` 상속이
//! 2개를 더 막았다. 그 자리들이 표에 있는 이유다.
//!
//! ── 왜 코어에 있는가 ─────────────────────────────────────────────────────────
//! 판정이 순수하다(텍스트를 읽고 답한다). 한때 이 규칙은 한 프레임워크 폴더 안에 살았고,
//! 그동안 다른 프레임워크는 같은 규칙을 **받지 못했다** — 규칙이 한쪽 이름 밑에 있으면
//! 다른 쪽은 규칙이 없는 것이 아니라 규칙을 안 받는다. 여기 있으면 뿌리를 넘기는 쪽이
//! 누구든 같은 판정을 받는다.
//!
//! ── 뿌리는 인자로 온다 ──────────────────────────────────────────────────────
//! 스캔 뿌리를 `env!("CARGO_MANIFEST_DIR")` 로 파생하면 그 순간 이 모듈이 "나는 그 크레이트
//! 안에 산다"를 전제한다. 크레이트가 바뀌면 같은 코드가 **다른 트리**를 훑고, 훑을 것이 없는
//! 트리는 위반 0건으로 통과한다(0의 두 얼굴). 그래서 뿌리도 저장소 기준점도 전부 인자다 —
//! `artifact_integrity` 가 경로를 전부 인자로 받는 것과 같은 이유다.

use std::path::{Path, PathBuf};

/// 환경 읽기 한 자리. `path` 는 **저장소 기준점 상대 경로**다(basename 이 아니다).
///
/// basename 키는 사면 하나가 여러 트리를 동시에 덮는다. `pty.rs` 사면 하나가
/// `frameworks/tauri/src/pty.rs` 와 `crates/soksak-cored/src/pty.rs` 를 함께 사면하는데,
/// 둘 다 `SOKSAK_PTYD_BIN` 을 읽으므로 한쪽만 답을 적고도 양쪽이 통과한다.
pub struct AmbientRead {
    pub path: &'static str,
    pub key: &'static str,
    pub why: &'static str,
    pub after_split: &'static str,
}

/// 등재표. 키는 저장소 기준점 상대 경로 + 환경 키.
pub const ALLOWED: &[AmbientRead] = &[
    AmbientRead {
        path: "frameworks/tauri/src/cored_host.rs",
        key: "HOME",
        why: "cored 를 띄우며 넘길 OS 사용자 홈 — 띄운 쪽이 상속한 값이다",
        after_split: "cored 가 자기 환경에서 읽으면 자기를 띄운 쪽의 환경을 사용자의 것인 양 \
                     답한다. 그래서 이 값은 **넘겨주는 쪽**이 읽어 인자로 준다(--user-home).",
    },
    AmbientRead {
        path: "frameworks/tauri/tests/attaches_to_cored.rs",
        key: "HOME",
        why: "검사가 격리 홈을 세우는 자리 — 실 홈을 안 건드리려면 그 값을 알아야 한다",
        after_split: "검사 픽스처의 뿌리다. 프로세스가 갈려도 검사는 자기 홈을 스스로 세우므로 \
                     이 읽기는 따라가지 않는다.",
    },
    AmbientRead {
        path: "frameworks/tauri/src/ai_session.rs",
        key: "HOME",
        why: "AI 에이전트 세션 디렉터리는 사용자 홈 아래에 있다(~/.claude, ~/.codex)",
        after_split: "호출자가 세션 루트를 인자로 넘긴다 — 감사가 이식 차단으로 지목한 자리",
    },
    AmbientRead {
        path: "frameworks/tauri/src/fs.rs",
        key: "HOME",
        why: "파일 탐색의 시작점(사용자 홈)",
        after_split: "홈을 인자로 받는다",
    },
    AmbientRead {
        path: "frameworks/tauri/src/fs.rs",
        key: "USERPROFILE",
        why: "윈도우의 HOME 대응",
        after_split: "동일",
    },
    AmbientRead {
        path: "frameworks/tauri/src/home.rs",
        key: "HOME",
        why: "identity 홈의 부모. 이 값 하나에서 모든 홈 경로가 파생된다",
        after_split: "Identity 계약이 홈을 값으로 나른다(identity.rs)",
    },
    AmbientRead {
        path: "frameworks/tauri/src/home.rs",
        key: "USERPROFILE",
        why: "윈도우의 HOME 대응",
        after_split: "동일",
    },
    AmbientRead {
        path: "frameworks/tauri/src/pty.rs",
        key: "COMSPEC",
        why: "윈도우의 SHELL 대응",
        after_split: "동일",
    },
    AmbientRead {
        path: "frameworks/tauri/src/pty.rs",
        key: "ZDOTDIR",
        why: "zsh 시작 파일 위치 — 셸 초기화를 사용자 설정대로 재현한다",
        after_split: "PTY 세션 env 로 함께 전달된다",
    },
    AmbientRead {
        path: "frameworks/tauri/src/pty.rs",
        key: "HOME",
        why: "ZDOTDIR 부재 시의 zsh 기본 위치",
        after_split: "동일",
    },
    AmbientRead {
        path: "frameworks/tauri/src/login_shell.rs",
        key: "SHELL",
        why: "사용자 로그인 셸 — PTY 기본 셸·데몬 spawn·npm prefix 가 모두 이 값을 쓴다. 읽는 자리는 여기 하나이고 아래로는 인자로 흐른다",
        after_split: "부팅 인자로 온다 — $SHELL 은 프로세스 속성이 아니라 사용자 계정 속성이라 --home·--identifier 와 같은 자리다",
    },
    AmbientRead {
        path: "frameworks/tauri/src/headless.rs",
        key: "SOKSAK_HEADLESS",
        why: "헤드리스 판정 — 이 프로세스가 창을 갖는가의 자기 서술",
        after_split: "프로세스마다 자기 답이 맞다(값이 프로세스를 따라가는 것이 옳은 드문 경우)",
    },
    AmbientRead {
        path: "frameworks/tauri/src/pty.rs",
        key: "SOKSAK_PTYD_BIN",
        why: "PTY 데몬 바이너리 경로 override — 개발·테스트가 스테이징본을 지목한다",
        after_split: "cored 가 자기 바이너리 경로를 인자로 받는다",
    },
    AmbientRead {
        path: "frameworks/tauri/src/data/mod.rs",
        key: "SOKSAK_DATA_DIR",
        why: "블랙박스 e2e 가 실 identity 홈 안에서 DB 만 격리한다(홈은 옮기지 않는다)",
        after_split: "데이터 경로를 Identity 와 함께 인자로 받는다",
    },
    // `frameworks/tauri/src/secrets.rs`/`SOKSAK_E2E_KEK` 는 여기 있었다. 그 읽기는
    // `crates/soksak-vault` 로 나갔고 프레임워크에는 0건이 남았다 — 등재만 남아 있으면
    // 그 파일에 새로 생기는 같은 키의 읽기가 답 없이 통과한다.
    AmbientRead {
        path: "frameworks/electron/cored.cjs",
        key: "SHELL",
        why: "사용자 로그인 셸 — 이 프레임워크가 cored 를 세울 때 부팅 인자로 실어 보낸다. cored 가 자기 환경에서 읽으면 자기를 띄운 쪽의 환경을 사용자의 것인 양 답한다",
        after_split: "이미 인자다(--login-shell) — 읽는 쪽이 창 가진 프로세스라는 것이 답이다",
    },
    AmbientRead {
        path: "frameworks/electron/main.cjs",
        key: "SOKSAK_ELECTRON_URL",
        why: "개발 서버 주소 override — 프레임워크가 자기 웹뷰에 무엇을 띄울지의 값이라 창을 가진 프로세스의 것이다",
        after_split: "창이 없는 프로세스는 띄울 것이 없다 — 갈려도 이쪽에 남는다",
    },
    AmbientRead {
        path: "frameworks/electron/main.cjs",
        key: "SOKSAK_START_INACTIVE",
        why: "비전면 시각 검증이 새 창의 첫 표시 방법을 고른다 — 실제 BrowserWindow를 가진 프로세스만 적용할 수 있다",
        after_split: "창 없는 코어로 옮기면 표시할 대상이 없고, 창 호스트에 전달하지 않으면 검증 창이 포커스를 빼앗는다. 이 값은 Electron 창 호스트에 남는다",
    },
    AmbientRead {
        path: "frameworks/electron/displayGeometry.cjs",
        key: "XDG_SESSION_TYPE",
        why: "Linux 에서 표시면 기하가 세션 종류로 갈린다(Wayland 는 전역 화면 좌표를 주지 않는다) — \
              그 값은 창 서버에 붙은 프로세스가 상속한 것이다",
        after_split: "창 없는 코어는 창 서버에 붙지 않아 이 값을 상속하지 않는다. 갈리면 세션 종류를 \
                      창 호스트가 읽어 기하와 함께 넘긴다 — 이 읽기는 창 호스트에 남는다",
    },
];

/// 이 파일은 **검사**인가 — 규칙이 아니라 그 증명이다.
///
/// 형제 검사 파일에는 `#[cfg(test)]` 가 없다(그 표시는 부르는 쪽에 있다). 그래서 파일 안을
/// 줄 단위로 보면 픽스처의 키 리터럴이 실행 경로로 보인다. 검사를 코드와 분리하는 것이 배치의
/// 법이므로(REPO-LAYOUT 법 4) 이 모양은 늘어난다. JS 쪽 `*.test.mjs` 도 같은 자격이다.
pub fn is_test_file(name: &str) -> bool {
    name.ends_with("_tests.rs")
        || name.ends_with("_test.rs")
        || name.ends_with(".test.mjs")
        || name.ends_with(".test.cjs")
        || name.ends_with(".test.js")
        || name.ends_with(".test.ts")
        || name.ends_with(".test.tsx")
}

/// 훑지 않는 디렉터리 — 산출물과 외부물. 여기까지 훑으면 빌드본이 소스인 척한다.
const SKIP_DIRS: &[&str] = &["target", "gen", "node_modules", "dist", ".git"];
const SOURCE_EXT: &[&str] = &["rs", "cjs", "mjs", "js", "ts", "tsx"];

/// 실행 경로 줄만 남긴다 — 테스트 모듈은 뺀다. 반환은 (원본 줄 번호 0-base, 줄).
///
/// **모듈 모양이 둘이다.** 블록(`mod tests { … }`)과 선언(`mod tests;` — 몸이 형제 파일에 있다).
/// 선언을 블록으로 착각해 중괄호를 찾아 나서면 **다음에 나오는 아무 블록이나** 삼키고, 그 안의
/// 실행 경로가 스캔 밖으로 나간다. 위반 0건은 그때도 나오므로 통과를 위장한다
/// (실측 2026-07-29: 같은 결함이 core-decoupling-scan 에서 50줄을 삼켰다).
///
/// **같은 판정이 두 벌 있다.** JS 쪽 짝은 `scripts/gates/core-decoupling-scan.mjs` 의
/// `stripRustTestModule` 이다. 한 벌로 못 만드는 이유는 언어다 — 그 게이트는 node 로 돌고
/// 이 게이트는 cargo 로 돈다. 한쪽을 고치면 다른 쪽도 같이 고쳐라. 동기 확인 방법: 두 벌 다
/// 같은 세 경우를 픽스처로 갖는다(선언 한 줄 / 속성이 낀 선언 / 블록 통째). 세 경우 중 하나가
/// 한쪽에만 있으면 그 순간부터 두 게이트의 답이 갈린다.
pub fn production_lines(src: &str) -> Vec<(usize, &str)> {
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

/// 환경 키의 모양 — 이것이 아니면 읽기로 세지 않는다.
///
/// 모양을 안 보면 문법 파편이 키가 된다(`env::var(` 가 문자열 안에 있는 줄에서 `")` 를 키로
/// 뽑는 식). 그런 유령 키는 등재할 방법이 없어서 고칠 수 없는 위반이 된다.
fn looks_like_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 한 줄에서 환경 읽기의 키를 뽑는다. 언어 둘을 같은 판정으로 본다.
///
/// Rust `env::var("X")` / JS `process.env.X` · `process.env["X"]` 가 대상이다.
/// **키가 리터럴이 아닌 형태는 대상이 아니다**: `env::var(k)` 도 `{ env = process.env }` 도
/// 키(또는 환경 전체)를 호출자에게서 받는 주입 seam 이라, 그 자리의 답은 프로세스가 아니라
/// 호출자가 정한다. 이 게이트가 묻는 것은 "이 프로세스의 환경을 여기서 캐는가"다.
///
/// 한계를 정직하게: 주입된 `env` 객체에서 뒤늦게 키를 꺼내는 자리(`env.FOO`)는 낱말만으로
/// 프로세스 환경과 구분되지 않아 세지 않는다. 그 자리는 이미 인자를 지나왔다.
fn keys_in_line(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    for rest in code.split("env::var(").skip(1) {
        if let Some(key) = rest.strip_prefix('"').and_then(|r| r.split('"').next()) {
            if looks_like_env_key(key) {
                out.push(key.to_string());
            }
        }
    }
    for rest in code.split("process.env").skip(1) {
        let key = if let Some(r) = rest.strip_prefix('.') {
            r.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .next()
                .unwrap_or("")
        } else if let Some(r) = rest.strip_prefix("[\"").or_else(|| rest.strip_prefix("['")) {
            r.split(['"', '\'']).next().unwrap_or("")
        } else {
            ""
        };
        if looks_like_env_key(key) {
            out.push(key.to_string());
        }
    }
    out
}

/// 한 파일의 환경 읽기 전부 — (원본 줄 번호 0-base, 키).
pub fn ambient_reads(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (i, line) in production_lines(src) {
        // 주석은 실행 경로가 아니다 — 규칙을 설명하는 문장이 위반으로 세어지면 설명을 지우게 된다.
        let code = line.split("//").next().unwrap_or("");
        for key in keys_in_line(code) {
            out.push((i, key));
        }
    }
    out
}

/// 뿌리 아래 소스 전부. `base` 기준 상대 경로와 본문을 함께 돌려준다.
///
/// `base` 는 등재표의 키가 사는 기준점이다(저장소 뿌리). 뿌리를 여럿 받는 이유는
/// 프레임워크가 여럿이기 때문이고, 그 목록을 여기서 파생하지 않는 이유는 그것이 곧
/// "이 저장소는 이렇게 생겼다"를 규칙 안에 박는 일이기 때문이다.
pub fn scan(base: &Path, roots: &[PathBuf]) -> Vec<(String, String)> {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        collect_sources(root, &mut files);
    }
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_test_file(&name) {
            // 형제 검사 파일은 규칙이 아니라 그 증명이다 — 픽스처의 키를 실행 경로로 세면
            // 고칠 수 없는 위반이 된다.
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .unwrap_or(path.as_path())
            .to_string_lossy()
            .replace('\\', "/");
        let src = std::fs::read_to_string(&path).unwrap_or_default();
        out.push((rel, src));
    }
    out
}

fn collect_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_sources(&p, out);
        } else if p
            .extension()
            .is_some_and(|x| SOURCE_EXT.contains(&x.to_string_lossy().as_ref()))
        {
            out.push(p);
        }
    }
}

/// 한 파일의 미등재 읽기. 대조는 **뿌리-상대 경로**로 한다 — 여기가 그 판정의 자리다.
///
/// 표가 경로로 적혀 있어도 대조하는 쪽이 basename 으로 되돌아가면 표는 그대로인 채 사면
/// 하나가 두 트리를 함께 덮는다. `pty.rs` 는 지금 두 자리에 있고(프레임워크의 것 · cored 의 것)
/// 둘 다 `SOKSAK_PTYD_BIN` 을 읽는다 — 한쪽에만 답을 적고 양쪽이 통과하면, 답 없는 쪽은
/// 아무 신호 없이 이식 불가로 남는다. 그래서 파일을 읽는 일(`scan`)과 대조하는 일을 갈라
/// 대조만 따로 잴 수 있게 둔다.
pub fn unregistered_in(rel: &str, src: &str, allowed: &[AmbientRead]) -> Vec<String> {
    ambient_reads(src)
        .into_iter()
        .filter(|(_, key)| !allowed.iter().any(|a| a.path == rel && a.key == key))
        .map(|(i, key)| format!("{rel}:{}: 환경 키 \"{key}\" 미등재", i + 1))
        .collect()
}

/// 등재 없이 환경을 읽는 자리.
pub fn unregistered(base: &Path, roots: &[PathBuf], allowed: &[AmbientRead]) -> Vec<String> {
    let mut out = Vec::new();
    for (rel, src) in scan(base, roots) {
        out.extend(unregistered_in(&rel, &src, allowed));
    }
    out
}

/// 매칭 0건인 등재 — 죽은 사면.
///
/// 사면은 지금 있는 것을 설명하는 문장이지 미래를 위한 예약이 아니다. 읽기가 다른 크레이트로
/// 나간 뒤에도 항목이 남으면(실측: `secrets.rs`/`SOKSAK_E2E_KEK` 는 볼트 크레이트로 나갔다)
/// 그 파일에 **새로 생긴** 같은 키의 읽기가 답 없이 통과한다. 죽은 예외가 다음 위반의 문이 된다.
pub fn stale_entries(base: &Path, roots: &[PathBuf], allowed: &[AmbientRead]) -> Vec<String> {
    let scanned = scan(base, roots);
    let mut out = Vec::new();
    for entry in allowed {
        let hit = scanned.iter().any(|(rel, src)| {
            rel == entry.path && ambient_reads(src).iter().any(|(_, k)| k == entry.key)
        });
        if !hit {
            out.push(format!("{}:{}", entry.path, entry.key));
        }
    }
    out
}

/// 로그인 셸(`SHELL`)을 읽는 자리를 뿌리 하나 안에서 모은다.
///
/// 등재표는 "왜 읽는가"를 묻지 "몇 곳이 읽는가"를 묻지 않는다. 그래서 셋이 각자 읽고 폴백이
/// 갈려도 표는 통과한다 — 그 상태가 실제로 있었다(pty.rs `/bin/bash`, daemon.rs·runtime_dep.rs
/// `/bin/sh`). 같은 프로세스가 같은 질문에 두 답을 갖는 것은 그 자체로 결함이다.
///
/// 뿌리 하나씩 세는 이유: 프레임워크가 둘이면 프로세스도 둘이고, 각자 자기 몫으로 한 자리씩
/// 읽는 것이 옳다. 전부 합쳐 세면 정상 상태가 위반으로 보인다.
pub fn login_shell_readers(base: &Path, root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for (rel, src) in scan(base, std::slice::from_ref(&root.to_path_buf())) {
        for (i, key) in ambient_reads(&src) {
            if key == "SHELL" {
                out.push(format!("{rel}:{}", i + 1));
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "ambient_gate_tests.rs"]
mod tests;
