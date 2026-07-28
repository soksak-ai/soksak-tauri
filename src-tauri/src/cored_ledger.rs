// 이식 장부 — "이 명령은 어디로 가는가"를 소스에서 실측한다.
//
// 진행률을 산문에 적으면 하루 만에 틀린다(문서의 "160개"가 다음날 187 이었다). 그래서 숫자를
// 문서가 아니라 **소스에서 세고**, 세는 규칙을 여기 둔다. 물어보면 답이 나오고, 명령이 늘거나
// 옮겨지면 답이 저절로 따라온다.
//
// 분류는 **1차**다. 시그니처만 보고, 본문이 부르는 함수까지 따라가지 않는다. 이 세션의 실측이
// 그 한계를 이미 보여 줬다: 1차로 52개가 이식 가능해 보였는데 전이 의존을 3단계 따라가니 8개로
// 줄었다. 그래서 여기 나오는 A 는 "옮길 수 있다"가 아니라 **"시그니처가 막지 않는다"**이고,
// 실제 이식은 본문을 읽어야 결정된다. 그 차이를 이름으로 남긴다.

use std::collections::BTreeMap;

use crate::cored_shape_gate::{app_commands, AppCommand};

/// 명령 하나의 갈 곳.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Lane {
    /// 이미 cored 가 서빙한다.
    Served,
    /// 프레임워크의 것 — 창·웹뷰·네이티브 표면. 다른 프로세스로 영영 안 간다.
    Framework,
    /// 관리 상태·앱 핸들에 묶였다. 계약(WindowOracle·ActivitySink·CommandDispatch)이 푼다.
    StateBound,
    /// 시그니처가 막지 않는다. 본문을 읽어야 실제 이식 가능 여부가 갈린다.
    Open,
}

impl Lane {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Lane::Served => "served",
            Lane::Framework => "framework",
            Lane::StateBound => "state-bound",
            Lane::Open => "open",
        }
    }
}

/// 창을 소유하는 명령 가족 — 이름 접두로 판정한다.
///
/// 접두만으로 창 소유를 다 잡지는 못한다(그래서 아래에서 주입 타입도 본다). 다만 이 가족들은
/// **이름 자체가 프레임워크 표면**이라 본문을 안 봐도 확정이고, Electron 어댑터가 이미 그렇게 다룬다.
// 프레임워크 갈래 — 이 접두사를 가진 명령은 창을 쥐므로 다른 프로세스로 가지 않는다.
//
// **멤버 없는 갈래를 미리 선언하지 않는다.** 앞을 내다본 선언은 그 자체가 결정이고, 그 이름의
// 명령이 생기는 순간 아무도 결정한 적 없이 "프레임워크의 것"이 되어 이식 대상에서 빠진다.
// 프레임워크 쪽에서는 같은 이름이 소켓에 닿지 못한 채 부재로 거절된다 — 양쪽 다 조용하다.
// 대상이 생겼을 때 넣는다.
const FRAMEWORK_FAMILIES: &[&str] = &["webview_", "engine_", "titlebar_", "window_"];

/// 창을 직접 쥐는 주입 타입. 이것이 있으면 그 명령은 창의 것이다.
const WINDOW_TYPES: &[&str] = &["Window", "WebviewWindow", "Webview"];

/// 한 명령의 갈 곳을 판정한다.
pub(crate) fn lane_of(cmd: &AppCommand, served: &[&str]) -> Lane {
    if served.contains(&cmd.name.as_str()) {
        return Lane::Served;
    }
    if FRAMEWORK_FAMILIES.iter().any(|p| cmd.name.starts_with(p))
        || cmd.injected.iter().any(|t| WINDOW_TYPES.contains(&t.as_str()))
    {
        return Lane::Framework;
    }
    if !cmd.injected.is_empty() {
        return Lane::StateBound;
    }
    Lane::Open
}

/// 지금 이 소스 트리의 이식 장부.
pub(crate) fn ledger() -> BTreeMap<Lane, Vec<String>> {
    let served: Vec<&str> = soksak_cored::registry::COMMANDS
        .iter()
        .map(|c| c.name)
        .collect();
    let mut out: BTreeMap<Lane, Vec<String>> = BTreeMap::new();
    for cmd in app_commands() {
        out.entry(lane_of(&cmd, &served))
            .or_default()
            .push(cmd.name);
    }
    for names in out.values_mut() {
        names.sort();
    }
    out
}

/// open 갈래에서 **아직 아무 답도 없는** 이름들 — 표를 받아서 판정한다.
///
/// open 은 "시그니처가 막지 않는다"는 뜻일 뿐이다. 거기 남은 이름에 대해 소스가 말할 수 있는
/// 답은 둘이다: 서빙한다(COMMANDS), 또는 사유를 달고 거절한다(UNSERVED). 둘 다 아닌 이름은
/// **아직 아무도 조사하지 않은 것**인데, 그 상태는 어디에도 안 남는다 — 프레임워크 저자는
/// UNKNOWN_COMMAND 한 줄을 받고 "여기서는 못 하는 것"으로 읽는다. 그 오독이 조사 없는 흉내를
/// 부른다. 그래서 미답을 사람 기억이 아니라 여기서 센다.
///
/// 표를 인자로 받는다: 실제 표로도, 합성한 표로도 같은 판정을 내려야 이 게이트가 산 것이다.
fn unanswered_in(open: &[String], served: &[&str], refused: &[&str]) -> Vec<String> {
    open.iter()
        .filter(|n| !served.contains(&n.as_str()) && !refused.contains(&n.as_str()))
        .cloned()
        .collect()
}

/// cored 가 서빙하는 이름들.
fn served_names() -> Vec<&'static str> {
    soksak_cored::registry::COMMANDS.iter().map(|c| c.name).collect()
}

/// 사유를 달고 거절한 이름들.
fn refused_names() -> Vec<&'static str> {
    soksak_cored::registry::UNSERVED.iter().map(|u| u.name).collect()
}

/// 지금 이 소스 트리의 미답 — open 갈래에서 서빙도 거절도 아닌 이름들.
pub(crate) fn unanswered() -> Vec<String> {
    let open = ledger().remove(&Lane::Open).unwrap_or_default();
    unanswered_in(&open, &served_names(), &refused_names())
}

/// 사람·기계가 함께 읽는 한 줄들.
pub(crate) fn summary() -> Vec<String> {
    ledger()
        .into_iter()
        .map(|(lane, names)| format!("{}: {}", lane.as_str(), names.len()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 장부가 실제 소스에서 나온다 — 파서가 죽으면 0을 답하고 그 0이 통과로 위장한다.
    #[test]
    fn the_ledger_is_measured_not_declared() {
        let l = ledger();
        let total: usize = l.values().map(Vec::len).sum();
        assert!(total > 150, "명령을 못 읽었다: {total}");
        // 네 갈래가 전부 비어 있지 않다 — 하나라도 비면 판정 규칙이 무너진 것이다.
        for lane in [Lane::Served, Lane::Framework, Lane::StateBound, Lane::Open] {
            assert!(
                l.get(&lane).is_some_and(|v| !v.is_empty()),
                "{} 갈래가 비었다: {:?}",
                lane.as_str(),
                summary()
            );
        }
    }

    /// cored 가 서빙하는 이름은 전부 served 로 잡힌다 — 장부와 서빙 표가 갈리면 진행률이 거짓이 된다.
    #[test]
    fn every_served_command_is_counted_as_served() {
        let l = ledger();
        let served = l.get(&Lane::Served).cloned().unwrap_or_default();
        let app: Vec<String> = app_commands().into_iter().map(|c| c.name).collect();
        for c in soksak_cored::registry::COMMANDS {
            // 앱에 없는 이름(cored 자기 서술)은 장부의 대상이 아니다.
            if !app.contains(&c.name.to_string()) {
                continue;
            }
            assert!(
                served.contains(&c.name.to_string()),
                "{} 를 서빙하는데 장부가 모른다: {served:?}",
                c.name
            );
        }
    }

    /// 판정 규칙이 실제로 가르는지 — 심은 예로 확인한다. 규칙이 무너지면 전부 한 갈래로 몰린다.
    #[test]
    fn the_rule_actually_separates_the_lanes() {
        fn cmd(name: &str, injected: &[&str]) -> AppCommand {
            AppCommand {
                name: name.into(),
                args: Default::default(),
                injected: injected.iter().map(|s| s.to_string()).collect(),
                file: "x.rs".into(),
            }
        }
        let served = ["themes_scan"];
        assert_eq!(lane_of(&cmd("themes_scan", &[]), &served), Lane::Served);
        // 이름이 곧 프레임워크 표면인 가족.
        assert_eq!(lane_of(&cmd("webview_list", &[]), &served), Lane::Framework);
        // 창을 직접 쥐면 이름과 무관하게 프레임워크의 것이다.
        assert_eq!(
            lane_of(&cmd("term_exec", &["Window"]), &served),
            Lane::Framework
        );
        // 앱 핸들·관리 상태는 계약이 푸는 축.
        assert_eq!(
            lane_of(&cmd("daemon_start", &["AppHandle"]), &served),
            Lane::StateBound
        );
        assert_eq!(lane_of(&cmd("fs_read", &[]), &served), Lane::Open);
    }

    /// open 에 남은 이름은 **서빙되거나, 사유를 달고 거절되거나** 둘 중 하나다.
    ///
    /// 셋째 상태(아무 답도 없음)는 소스 어디에도 안 남아서 사람 기억에만 산다. 기억은 하루면
    /// 틀린다 — 그리고 틀린 자리는 "여기서는 못 한다"로 읽혀 다시 조사되지 않는다.
    #[test]
    fn every_open_name_is_either_served_or_refused_with_a_reason() {
        let l = ledger();
        let open = l.get(&Lane::Open).cloned().unwrap_or_default();
        // 오라클 생존 — 파서가 죽어 open 이 비면 미답도 0 이 되어 통과로 위장한다.
        assert!(!open.is_empty(), "open 갈래가 비었다 — 이 검사는 판정할 수 없다");
        assert_eq!(
            unanswered_in(&open, &served_names(), &refused_names()),
            Vec::<String>::new(),
            "아직 아무 답도 없는 이름이 있다 — 서빙하거나, 무엇이 막는지 UNSERVED 에 적어라",
        );
    }

    /// 거절 목록의 이름은 **실재하는 앱 명령**이다.
    ///
    /// 없어진 명령의 사유가 남으면 그 선언은 아무것도 막지 않으면서 막는 것처럼 보인다.
    /// 읽는 사람은 조사된 벽으로 믿고, 그 벽은 이미 없다.
    #[test]
    fn every_refused_name_is_a_real_app_command() {
        let app: Vec<String> = app_commands().into_iter().map(|c| c.name).collect();
        // 오라클 생존 — 표 둘 중 하나라도 못 읽으면 이 검사는 판정한 것이 없다.
        assert!(app.len() > 100, "앱 명령을 못 읽었다: {}", app.len());
        let refused = refused_names();
        assert!(!refused.is_empty(), "거절 목록이 비었다 — 이 검사는 판정할 수 없다");
        let dead: Vec<&str> = refused
            .iter()
            .copied()
            .filter(|n| !app.contains(&n.to_string()))
            .collect();
        assert_eq!(
            dead,
            Vec::<&str>::new(),
            "앱에 없는 이름의 거절 사유가 남아 있다 — 없어진 결함을 계속 막는 것처럼 보인다",
        );
    }

    /// 한 이름에 답이 둘일 수는 없다 — 서빙하면서 거절 사유를 다는 것은 결함이다.
    ///
    /// 겹치면 `cored.commands` 는 서빙한다고 말하고 거절 표는 못 한다고 말한다. 어느 쪽을
    /// 읽었는지에 따라 답이 갈리고, 갈린 답은 오류가 아니라 **다른 사실**로 퍼진다.
    #[test]
    fn no_name_is_both_served_and_refused() {
        let served = served_names();
        let refused = refused_names();
        assert!(!served.is_empty() && !refused.is_empty(), "표를 못 읽었다");
        let both: Vec<&str> = refused
            .iter()
            .copied()
            .filter(|n| served.contains(n))
            .collect();
        assert_eq!(
            both,
            Vec::<&str>::new(),
            "같은 이름이 서빙 표와 거절 표에 함께 있다 — 표로 올라갔으면 사유를 지워라",
        );
    }

    /// **이 소스 트리에** 미답이 없다.
    ///
    /// 아래 규칙 검사는 합성 입력으로 돈다 — 규칙이 옳음을 보이지만 실제 표가 어떤지는 말하지
    /// 않는다. 실측: 거절 표에서 clipboard_read 를 빼도 전 스위트가 통과했다. 규칙만 검사하면
    /// "아직 안 함"이 조용히 남고, 그 침묵이 곧 이 게이트가 막으려던 것이다.
    #[test]
    fn this_tree_has_no_unanswered_name() {
        // 오라클 생존 — open 이 비면 미답도 0 이 되어 통과로 위장한다("0 의 두 얼굴").
        let open = ledger().remove(&Lane::Open).unwrap_or_default();
        assert!(!open.is_empty(), "open 갈래를 읽지 못했다 — 이 검사는 판정할 수 없다");
        assert_eq!(
            unanswered(),
            Vec::<String>::new(),
            "open 갈래에 서빙도 거절도 아닌 이름이 있다 — 옮기거나 사유를 달아 UNSERVED 에 올려라",
        );
    }

    fn the_gate_catches_a_name_with_no_answer_at_all() {
        let open = vec!["theme_install".to_string(), "clipboard_read".to_string()];
        // 둘 다 답이 있으면 미답은 없다.
        assert_eq!(
            unanswered_in(&open, &["theme_install"], &["clipboard_read"]),
            Vec::<String>::new(),
        );
        // 서빙 표에서 빠지면 그 이름이 미답으로 잡힌다.
        assert_eq!(
            unanswered_in(&open, &[], &["clipboard_read"]),
            vec!["theme_install".to_string()],
        );
        // 거절 표에서 빠져도 마찬가지다.
        assert_eq!(
            unanswered_in(&open, &["theme_install"], &[]),
            vec!["clipboard_read".to_string()],
        );
    }

    /// 장부는 물어서 알 수 있어야 한다(R7) — 요약이 갈래마다 숫자를 말한다.
    #[test]
    fn the_summary_names_every_lane_with_a_count() {
        let s = summary();
        assert_eq!(s.len(), 4, "{s:?}");
        for line in &s {
            let (_, n) = line.split_once(": ").expect("갈래: 수");
            assert!(n.parse::<usize>().is_ok(), "{line}");
        }
    }
}

#[cfg(test)]
mod report {
    use super::*;

    /// 지금 장부를 눈으로 본다. 단언이 아니라 **보고**다 — `cargo test lane_report -- --nocapture`.
    #[test]
    fn lane_report() {
        for line in summary() {
            println!("{line}");
        }
        let l = ledger();
        if let Some(open) = l.get(&Lane::Open) {
            println!("\nopen({}) — 시그니처가 막지 않는 것들:", open.len());
            let refused = refused_names();
            for n in open {
                let mark = if refused.contains(&n.as_str()) {
                    "거절(사유 있음)"
                } else {
                    "미답"
                };
                println!("  {n} — {mark}");
            }
        }
        let u = unanswered();
        println!("\nopen 미답: {}", u.len());
        for n in &u {
            println!("  {n}");
        }
    }
}

// 테스트는 별도 파일에 산다 — 같은 파일에 두면 코드를 읽는 사람이 검사까지 스크롤로 지나야
// 하고, 검사를 고치는 편집이 코드 파일의 diff 로 섞인다. `#[path]` 로 붙이면 분리하면서도
// 비공개 항목(FRAMEWORK_FAMILIES)에 그대로 닿는다.
#[cfg(test)]
#[path = "cored_ledger_family_tests.rs"]
mod family_tests;
