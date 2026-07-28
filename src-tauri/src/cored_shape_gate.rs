// cored 서빙 모양 게이트(정적) — "cored 가 서빙하는 명령은 앱 명령과 **같은 모양**인가".
//
// UI 는 자기가 누구와 말하는지 모른다. `invoke("app_environment")` 는 앱이 답하든 cored 가
// 답하든 같은 호출이고, 그래서 cored 의 인자 모양은 앱 명령의 인자 모양과 **같아야 한다**.
// 다르면 프레임워크가 번역을 해야 하는데, 그 번역은 곧 두 번째 진실이 된다.
//
// 이 게이트가 생긴 이유(2026-07-28 실측): cored 가 서빙한다고 믿었던 5개(app_environment·
// data_kv_get·themes_scan·plugin_scan·app_is_release)가 라이브 부팅에서 전부
// INVALID_PARAMS 로 거절됐다. cored 는 `identifier`·`home`·`dbPath`·`dir`·`base` 를 요구했는데
// 앱의 같은 명령들은 **인자를 하나도 받지 않는다** — 그 값들은 프로세스가 부팅 때 갖는
// 상태이지 호출자가 매번 실어 보내는 것이 아니기 때문이다.
//
// 그 오판의 뿌리는 "cored 는 정체성을 추측하지 않는다"를 "매 호출마다 정체성을 요구한다"로
// 읽은 것이다. 받는 것과 추측하는 것은 다르다: 앱도 자기 정체성을 추측하지 않고 부팅 때
// 프레임워크에서 받는다(home::init). cored 도 띄운 쪽에서 부팅 때 받으면 된다(--home/--identifier).
//
// 그래서 이 게이트는 이름이 겹치는 명령마다 인자 이름 **집합**을 대조한다. 프레임워크가 주입하는
// 인자(State·AppHandle·Window·Channel)는 호출자가 보내는 값이 아니므로 앱 쪽에서 뺀다.
// cored 에만 있는 이름(`cored.commands` 같은 자기 서술)은 앱 명령이 아니므로 대조 대상이
// 아니다 — 다만 **이름이 겹치는데 모양이 다른 것**은 전부 결함이다.

use std::collections::BTreeSet;

/// 프레임워크가 주입하는 인자 타입 — 호출자가 보내는 값이 아니다. Tauri 는 이것들을 시그니처에서
/// 보고 스스로 채우므로 JS 쪽 인자 목록에 나타나지 않는다.
const FRAMEWORK_INJECTED: &[&str] = &[
    "State",
    "AppHandle",
    "Window",
    "WebviewWindow",
    "Webview",
    "Channel",
    "Request",
    "Response",
];

/// 앱 명령 하나의 호출자 인자 이름들(snake_case, 선언 순서 무관).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppCommand {
    pub name: String,
    pub args: BTreeSet<String>,
    /// 이 명령이 프레임워크에서 주입받는 타입들(State·AppHandle·Window·Channel …).
    /// 호출자 인자가 아니라 **이 명령이 앱 프로세스에 묶인 이유**라, 분류가 이것을 본다.
    pub injected: BTreeSet<String>,
    /// 선언된 파일 — 어느 영역의 명령인지 읽는 축.
    pub file: String,
}

/// 이름 대조용 정규형 — Tauri 는 rust 의 snake_case 를 JS 의 camelCase 로 바꿔 넘긴다.
/// 두 표기를 같은 것으로 보려면 구분자와 대소문자를 지운다.
fn canon(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 앱 소스에서 `#[tauri::command]` 로 노출된 명령의 인자 모양을 읽는다.
pub(crate) fn app_commands() -> Vec<AppCommand> {
    let base = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    collect_rs(std::path::Path::new(&base), &mut files);
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.extend(parse_commands(&src, &name));
    }
    out
}

/// 한 파일에서 `#[tauri::command]` 다음에 오는 fn 시그니처를 읽는다.
fn parse_commands(src: &str, file: &str) -> Vec<AppCommand> {
    let mut out = Vec::new();
    let lines: Vec<&str> = src.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        // 어트리뷰트와 fn 사이에 다른 어트리뷰트(cfg 등)가 낄 수 있다.
        let Some(start) = (i + 1..lines.len().min(i + 6))
            .find(|j| lines[*j].contains("fn "))
        else {
            continue;
        };
        // 시그니처는 여러 줄이다 — 괄호 균형이 맞을 때까지 모은다.
        let mut sig = String::new();
        let mut depth: i32 = 0;
        let mut started = false;
        for l in &lines[start..] {
            sig.push_str(l);
            sig.push(' ');
            depth += l.matches('(').count() as i32 - l.matches(')').count() as i32;
            if l.contains('(') {
                started = true;
            }
            if started && depth <= 0 {
                break;
            }
        }
        let Some(name) = sig
            .split("fn ")
            .nth(1)
            .and_then(|r| r.split(['(', '<', ' ']).next())
        else {
            continue;
        };
        let Some(params) = sig.split_once('(').map(|(_, r)| r) else {
            continue;
        };
        let params = params.rsplit_once(')').map(|(l, _)| l).unwrap_or(params);
        let (args, injected) = split_params(params);
        out.push(AppCommand {
            name: name.trim().to_string(),
            args,
            injected,
            file: file.to_string(),
        });
    }
    out
}

/// 파라미터 목록에서 **호출자가 보내는** 인자 이름만 남긴다.
fn caller_args(params: &str) -> BTreeSet<String> {
    split_params(params).0
}

/// 파라미터를 둘로 가른다: (호출자 인자 이름, 프레임워크 주입 타입 이름).
///
/// 주입 타입은 버리지 않고 돌려준다 — 그것이 이 명령을 앱 프로세스에 묶는 이유이고,
/// 이식 분류가 보는 축이다(cored_ledger).
fn split_params(params: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut out = BTreeSet::new();
    let mut injected = BTreeSet::new();
    let mut depth: i32 = 0;
    let mut cur = String::new();
    let mut parts = Vec::new();
    for c in params.chars() {
        match c {
            '<' | '(' | '[' => {
                depth += 1;
                cur.push(c);
            }
            '>' | ')' | ']' => {
                depth -= 1;
                cur.push(c);
            }
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    for p in parts {
        let p = p.trim();
        if p.is_empty() || p.starts_with('&') || p == "self" {
            continue;
        }
        let Some((name, ty)) = p.split_once(':') else {
            continue;
        };
        let ty = ty.trim();
        // 프레임워크 주입 타입은 호출자의 인자가 아니다. 타입 경로 어디에 있든 잡는다
        // (`State<'_, DbState>` · `tauri::AppHandle` · `ipc::Channel<..>`).
        let hit: Vec<&str> = FRAMEWORK_INJECTED
            .iter()
            .copied()
            .filter(|s| ty.split(['<', ' ', ':']).any(|seg| seg == *s))
            .collect();
        if !hit.is_empty() {
            injected.extend(hit.into_iter().map(str::to_string));
            continue;
        }
        out.insert(name.trim().trim_start_matches("mut ").trim().to_string());
    }
    (out, injected)
}

/// 이름이 겹치는 명령마다 인자 이름 집합을 대조한다. 앱에 없는 이름은 cored 자기 서술이라
/// 대조 대상이 아니다 — 있는 이름이 다른 모양인 것만 결함이다.
///
/// 표를 인자로 받는다: 실제 표로도, 합성한 표로도 같은 판정을 내려야 게이트가 산 것이다.
fn mismatches<'a>(
    app: &[AppCommand],
    served: impl IntoIterator<Item = (&'a str, Vec<&'a str>)>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (name, args) in served {
        let Some(mine) = app.iter().find(|c| c.name == name) else {
            continue;
        };
        let declared: BTreeSet<String> = args.iter().map(|a| canon(a)).collect();
        let expected: BTreeSet<String> = mine.args.iter().map(|a| canon(a)).collect();
        if declared != expected {
            out.push(format!(
                "{name}: cored {args:?} != 앱 {:?}",
                mine.args.iter().collect::<Vec<_>>()
            ));
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

    /// cored 가 서빙하는 이름이 앱에도 있으면 **인자 모양이 같아야 한다.**
    /// 다르면 UI 가 앱에 보내던 호출이 cored 에서 INVALID_PARAMS 로 거절된다 — 그리고
    /// 그 거절은 프레임워크 로그 한 줄이라 조용하다.
    /// 실제 서빙 표 — 이름과 인자 이름만 뽑는다.
    fn served_table() -> Vec<(&'static str, Vec<&'static str>)> {
        soksak_cored::registry::COMMANDS
            .iter()
            .map(|c| (c.name, c.args.iter().map(|a| a.name).collect()))
            .collect()
    }

    #[test]
    fn every_served_command_has_the_shape_of_its_app_command() {
        assert_eq!(
            mismatches(&app_commands(), served_table()),
            Vec::<String>::new(),
            "cored 서빙 모양이 앱 명령과 다르다 — UI 는 자기가 누구와 말하는지 모른다. \
             프로세스 상태(정체성·홈·DB 경로)는 매 호출 인자가 아니라 cored 부팅 인자다"
        );
    }

    /// 게이트 자격 — **위반을 심어 잡는지**. 통과만 하는 검사는 통과로 위장한다.
    /// 여기 심는 세 모양이 이 결함이 실제로 났던 세 가지 방식이다.
    #[test]
    fn the_gate_catches_every_way_the_shape_can_drift() {
        let app = app_commands();
        // ① 앱이 안 받는 인자를 cored 가 요구한다 — 실제로 났던 결함(2026-07-28).
        let extra = mismatches(&app, [("app_environment", vec!["identifier", "home"])]);
        assert_eq!(extra.len(), 1, "인자를 더 요구하는 것을 못 잡았다: {extra:?}");
        assert!(extra[0].contains("app_environment"), "{extra:?}");
        // ② 앱이 받는 인자를 cored 가 흘린다 — 호출자가 보낸 값이 조용히 버려진다.
        let dropped = mismatches(&app, [("data_kv_get", vec!["ns"])]);
        assert_eq!(dropped.len(), 1, "빠뜨린 인자를 못 잡았다: {dropped:?}");
        // ③ 이름만 다르다 — 프레임워크가 번역해야 하고, 그 번역이 두 번째 진실이 된다.
        let renamed = mismatches(&app, [("data_kv_get", vec!["namespace", "key"])]);
        assert_eq!(renamed.len(), 1, "이름 어긋남을 못 잡았다: {renamed:?}");
        // 표기만 다른 것은 결함이 아니다(Tauri 가 넘길 때 바꾸는 표기다).
        let cased = mismatches(&app, [("binary_integrity", vec!["binPath", "libPath"])]);
        assert_eq!(cased, Vec::<String>::new(), "표기 차이를 결함으로 봤다: {cased:?}");
        // 앱에 없는 이름은 대조하지 않는다 — cored 자기 서술(cored.commands).
        let own = mismatches(&app, [("cored.commands", vec![])]);
        assert_eq!(own, Vec::<String>::new(), "{own:?}");
    }

    /// 오라클 생존 단언 — 파서가 죽으면 이 게이트는 아무것도 지키지 않는다("0"의 두 얼굴).
    #[test]
    fn the_parser_actually_reads_the_command_surface() {
        let app = app_commands();
        assert!(app.len() > 100, "앱 명령을 못 읽었다: {}", app.len());
        // 알려진 모양 하나를 못박는다 — 파서가 인자를 통째로 흘리면 여기서 걸린다.
        let kv = app
            .iter()
            .find(|c| c.name == "data_kv_get")
            .expect("data_kv_get 을 못 찾았다");
        assert_eq!(
            kv.args,
            ["key".to_string(), "ns".to_string()].into_iter().collect(),
            "State 는 호출자 인자가 아니고 ns·key 는 맞다"
        );
        // 인자 없는 명령도 인자 없음으로 읽혀야 한다 — 이것이 이 게이트의 핵심 사례다.
        let env = app
            .iter()
            .find(|c| c.name == "app_environment")
            .expect("app_environment 를 못 찾았다");
        assert!(env.args.is_empty(), "인자가 있다고 읽었다: {:?}", env.args);
    }

    /// 표기 정규화가 실제로 두 표기를 같게 보는지 — 이게 틀리면 게이트가 거짓 RED 를 낸다.
    #[test]
    fn snake_case_and_camel_case_name_the_same_argument() {
        assert_eq!(canon("timeout_ms"), canon("timeoutMs"));
        assert_eq!(canon("bin_path"), canon("binPath"));
        assert_ne!(canon("host"), canon("port"));
    }
}
