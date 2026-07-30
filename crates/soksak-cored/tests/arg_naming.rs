//! 인자 이름은 **부른 쪽이 쓰는 그대로** 읽혀야 한다.
//!
//! 표는 `onEvent` 라 선언하고 구조체는 `on_event` 로 받으면, 그 인자는 조용히 기본값이 된다.
//! 컴파일도 되고 검사도 통과한다 — 그 이름을 실제로 실어 보내는 순간에만 드러난다
//! (실측 2026-07-31: sidecar_open 의 onEvent 가 그렇게 사라져 "사건이 갈 곳이 없다"로 거절됐다).
//!
//! 형태 게이트는 표의 이름과 앱 명령의 인자 이름을 대조한다. 그 둘이 같아도 이 결함은 남는다:
//! serde 가 무엇을 읽는지는 표에 안 적히기 때문이다. 그래서 소스를 직접 본다.

use std::path::Path;

/// dispatch 로 인자를 받는 구조체는 snake_case 필드를 가지면 **반드시** camelCase 로 읽어야 한다.
/// 방법은 둘이다: `rename_all = "camelCase"` 또는 필드마다 명시 `rename`.
#[test]
fn every_argument_struct_reads_camel_case() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources: Vec<(String, String)> = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("src 를 읽는다") {
        let path = entry.expect("항목").path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.starts_with("registry") || !name.ends_with(".rs") {
            continue;
        }
        sources.push((name, std::fs::read_to_string(&path).expect("소스")));
    }
    // 오라클 생존 — 소스를 못 읽으면 아래 루프는 아무것도 안 지킨다("0 의 두 얼굴").
    assert!(!sources.is_empty(), "registry 소스를 하나도 못 읽었다");

    let mut bad = Vec::new();
    for (file, text) in &sources {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.starts_with("struct ") || !line.ends_with(" {") {
                continue;
            }
            // 이 구조체가 Deserialize 인가 — 위쪽 attribute 를 본다.
            let mut j = i;
            let mut attrs = String::new();
            while j > 0 && (lines[j - 1].starts_with("#[") || lines[j - 1].starts_with("///")) {
                j -= 1;
                attrs.push_str(lines[j]);
            }
            if !attrs.contains("Deserialize") {
                continue;
            }
            let camel = attrs.contains("camelCase");
            // 필드를 훑는다 — snake_case 인데 camel 규칙도 명시 rename 도 없으면 위반.
            let mut k = i + 1;
            let mut pending_rename = false;
            while k < lines.len() && lines[k] != "}" {
                let t = lines[k].trim();
                if t.starts_with("//") {
                    k += 1;
                    continue;
                }
                if t.starts_with("#[") {
                    pending_rename = t.contains("rename =");
                    k += 1;
                    continue;
                }
                let field = t.split(':').next().unwrap_or("").trim();
                if field.contains('_') && !camel && !pending_rename {
                    bad.push(format!(
                        "{file} :: {} — 필드 `{field}` 가 snake_case 인데 camelCase 로 읽지 않는다",
                        line.trim_start_matches("struct ").trim_end_matches(" {")
                    ));
                }
                pending_rename = false;
                k += 1;
            }
        }
    }
    assert_eq!(bad, Vec::<String>::new(), "{bad:#?}");
}
