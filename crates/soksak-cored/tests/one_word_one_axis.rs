//! `portable` 은 이 축의 말이 아니다 — 그 뜻의 이름은 **core** 다.
//!
//! 프레임워크에 안 묶였다는 뜻으로 `portable` 을 쓰면 같은 파일 안에서 그 단어가 두 뜻이 된다:
//! 배포 스펙의 `portable any artifact`(타깃 없이 어디서나 도는 아티팩트)와 아카이브의
//! `portable path`(크로스플랫폼 표기)는 **그대로 옳은 말**이라 개명 대상이 아니다.
//!
//! 그래서 이 게이트는 단어를 통째로 막지 않는다. 막는 것은 **이 두 크레이트의 식별자**뿐이다:
//! 여기서 그 단어가 이름에 들어가는 경우는 "프레임워크-무관"이라는 뜻 하나뿐이고, 그 뜻의
//! 이름은 이미 core 로 정해졌다. 개명은 코드에서 끝나지 않는다 — 되돌아오지 않아야 끝이다.

use std::path::Path;

fn identifiers_with(word: &str, dir: &Path) -> Vec<String> {
    let mut hits = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return hits;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            hits.extend(identifiers_with(word, &path));
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        // 이 게이트 자신은 그 단어를 **막기 위해** 쓴다 — 자기를 세면 상시 실패하고, 상시
        // 실패하는 게이트는 곧 꺼진다.
        if path.file_name().and_then(|n| n.to_str()) == Some("one_word_one_axis.rs") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (i, line) in text.lines().enumerate() {
            // 벤더 크레이트 이름은 우리 것이 아니다 — 개명할 수 없고, 개명 대상도 아니다.
            let stripped = line.replace("portable-pty", "").replace("portable_pty", "");
            // 식별자 자리만 본다: 산문·주석의 그 단어는 다른 뜻일 수 있다.
            let is_identifier = stripped.contains(&format!("fn {word}"))
                || stripped.contains(&format!("_{word}"))
                || stripped.contains(&format!("{word}_"));
            if is_identifier {
                hits.push(format!(
                    "{}:{}: {}",
                    path.display(),
                    i + 1,
                    line.trim()
                ));
            }
        }
    }
    hits
}

#[test]
fn no_identifier_calls_the_core_axis_portable() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("워크스페이스 루트");
    let roots = [root.join("crates/soksak-cored/src"), root.join("crates/soksak-cored/tests")];
    // 오라클 생존 — 뿌리를 못 읽으면 아래 단언은 아무것도 안 지킨다("0 의 두 얼굴").
    assert!(
        roots.iter().any(|r| r.is_dir()),
        "스캔 뿌리를 하나도 못 읽었다 — 이 게이트는 판정할 수 없다"
    );
    let mut hits: Vec<String> = roots.iter().flat_map(|r| identifiers_with("portable", r)).collect();
    hits.sort();
    assert_eq!(
        hits,
        Vec::<String>::new(),
        "프레임워크-무관을 뜻하는 이름은 core 다 — portable 로 되돌리지 않는다"
    );
}
