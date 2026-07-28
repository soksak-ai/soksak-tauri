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
        file: "daemon.rs",
        key: "SHELL",
        why: "사용자 로그인 셸로 데몬 명령을 띄운다 — 사용자의 PATH 가 필요하다",
        after_split: "셸 경로를 인자로 받는다(자식 env 상속은 프로세스가 갈리면 달라진다)",
    },
    AmbientRead {
        file: "pty.rs",
        key: "SHELL",
        why: "PTY 세션의 기본 셸",
        after_split: "이미 spawn 인자로 셸을 받는다 — 이 읽기는 폴백 기본값",
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
    AmbientRead {
        file: "runtime_dep.rs",
        key: "SHELL",
        why: "npm prefix 를 로그인 셸로 물어 사용자 PATH 를 보존한다",
        after_split: "감사가 이식 차단으로 지목 — 셸 경로를 인자로 받아야 한다",
    },
];

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
        if name == "ambient_gate.rs" {
            continue; // 등재표 자신 — 키 리터럴을 담는 것이 그 일이다
        }
        let src = std::fs::read_to_string(&path).unwrap_or_default();
        let mut in_test = false;
        let mut depth: i32 = 0;
        for (i, line) in src.lines().enumerate() {
            // 테스트 모듈 안은 세지 않는다 — 테스트는 자기 환경을 스스로 만든다.
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
mod tests {
    use super::*;

    #[test]
    fn every_ambient_read_is_registered() {
        let missing = unregistered();
        assert_eq!(
            missing,
            Vec::<String>::new(),
            "env 를 읽는 새 자리가 생겼다 — ambient_gate.rs 의 ALLOWED 에 \
             '왜 이 프로세스여야 하는가'와 '프로세스가 갈리면 무엇이 오는가'를 적어라"
        );
    }

    #[test]
    fn every_entry_answers_both_questions() {
        // 이유 없는 등재는 등재가 아니다 — 표를 통과 도구로 쓰는 것을 막는다.
        let empty: Vec<String> = ALLOWED
            .iter()
            .filter(|a| a.why.trim().is_empty() || a.after_split.trim().is_empty())
            .map(|a| format!("{}:{}", a.file, a.key))
            .collect();
        assert_eq!(empty, Vec::<String>::new(), "이유·대체 경로가 빈 등재");
    }

    #[test]
    fn the_scan_actually_reads_the_source() {
        // 오라클 생존 단언 — 스캔이 죽으면 이 게이트는 아무것도 지키지 않는다("0"의 두 얼굴).
        let base = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        collect_rs(std::path::Path::new(&base), &mut files);
        assert!(files.len() > 20, "소스를 못 읽었다: {}", files.len());
        assert!(
            ALLOWED.len() >= 10,
            "등재표가 비었다 — 스캔이 통과로 위장한다"
        );
    }
}
