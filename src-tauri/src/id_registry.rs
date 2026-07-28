// 실체 id 전역 레지스트리 — "단일 id 로 창을 넘는 호출"의 시행 지점(IDENTITY §6).
//
// 왜 있어야 하나: 명령은 한 창으로만 배달되고(emit_to) 탭·pane id 는 그 창의 렌더러에만
// 산다. 그래서 `pan-xxx` 하나로 부르면 봉투가 지목한 창 안에서만 찾고, 다른 창의 것이면
// TARGET_NOT_FOUND 였다 — "단일 id 만으로도 호출 가능"(R-B6)이 창을 넘지 못했다.
// 이 레지스트리가 id → 소유 창을 풀어 라우팅하고, 둘 이상으로 풀리면 AMBIGUOUS 로
// 후보를 싣는다(짐작 없음). ProjectRegistry(root 축)와 같은 패턴 — in-memory 싱글톤,
// 재기동 = 빈 레지스트리(crash-stale 없음), 창 파괴 시 일괄 회수.
//
// 등록은 개별 발급이 아니라 **선언**이다(검증 감사 지적 — 발급은 렌더러 reducer 안의
// 동기 함수이고 등록은 비동기 invoke 라, 개별 등록은 경쟁 상태가 된다). 창이 복원을
// 마치면 자기 id 집합 **전체**를 세대 번호와 함께 한 번 선언하고, 그 창의 이전 세대
// 등록은 통째로 대체된다(set-replace). window.reload 처럼 Destroyed 없이 렌더러 상태가
// 갈리는 경우도 다음 선언이 유령을 걷는다.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
pub struct IdRegistry {
    // 창 label → (세대, 그 창이 선언한 id 집합)
    by_window: Mutex<HashMap<String, (u64, HashSet<String>)>>,
}

/// 단일 id 해소 결과 — 짐작 없이 셋 중 하나다.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    /// 정확히 한 창이 선언했다.
    One(String),
    /// 둘 이상 — 후보 창 label 들(정렬). 호출자가 경로로 좁힌다.
    Many(Vec<String>),
    /// 아무 창도 선언하지 않았다.
    None,
}

impl IdRegistry {
    /// 창의 id 집합 선언(set-replace). 세대가 현 세대보다 낮으면 늦게 도착한 옛 선언이므로
    /// 버린다 — reload 직후 옛 렌더러의 선언이 새 선언을 덮는 역전을 막는다.
    pub fn declare(&self, label: &str, generation: u64, ids: Vec<String>) -> bool {
        let mut m = self.by_window.lock().unwrap();
        if let Some((cur, _)) = m.get(label) {
            if *cur > generation {
                return false;
            }
        }
        m.insert(label.to_string(), (generation, ids.into_iter().collect()));
        true
    }

    /// 창 파괴 — 그 창의 선언을 통째로 걷는다.
    pub fn forget_window(&self, label: &str) {
        self.by_window.lock().unwrap().remove(label);
    }

    /// 단일 id → 소유 창. 선언 위에서만 판정한다(짐작 없음).
    pub fn resolve(&self, id: &str) -> Resolution {
        let m = self.by_window.lock().unwrap();
        let mut owners: Vec<String> = m
            .iter()
            .filter(|(_, (_, ids))| ids.contains(id))
            .map(|(label, _)| label.clone())
            .collect();
        owners.sort();
        match owners.len() {
            0 => Resolution::None,
            1 => Resolution::One(owners.pop().unwrap()),
            _ => Resolution::Many(owners),
        }
    }
}

// ── 두 입구 ───────────────────────────────────────────────────────────────────
// 레지스트리만 있으면 선다 — 봉투 조립까지 입구가 갖는다. 봉투가 커맨드 몸통에 있으면
// 앱 밖 디스패처가 같은 답을 다시 조립하게 되고, 두 조립은 언젠가 갈린다.
// 아래 `#[tauri::command]` 는 State 를 벗겨 넘기는 번역층이다(로직을 두지 않는다).

pub(crate) fn declare_ids(
    registry: &IdRegistry,
    label: &str,
    generation: u64,
    ids: Vec<String>,
) -> bool {
    registry.declare(label, generation, ids)
}

pub(crate) fn resolve_id(registry: &IdRegistry, id: &str) -> serde_json::Value {
    match registry.resolve(id) {
        Resolution::One(label) => serde_json::json!({ "kind": "one", "window": label }),
        Resolution::Many(labels) => serde_json::json!({ "kind": "many", "windows": labels }),
        Resolution::None => serde_json::json!({ "kind": "none" }),
    }
}

#[tauri::command]
pub fn id_registry_declare(
    registry: tauri::State<IdRegistry>,
    label: String,
    generation: u64,
    ids: Vec<String>,
) -> bool {
    declare_ids(registry.inner(), &label, generation, ids)
}

#[tauri::command]
pub fn id_registry_resolve(
    registry: tauri::State<IdRegistry>,
    id: String,
) -> serde_json::Value {
    resolve_id(registry.inner(), &id)
}

pub fn on_window_destroyed(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    app.state::<IdRegistry>().forget_window(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // 해소 결과의 봉투 모양은 커맨드 몸통이 아니라 입구가 갖는다 — 몸통에 두면 앱 밖
    // 디스패처가 같은 답을 다시 조립하게 되고, 두 조립은 언젠가 갈린다.
    #[test]
    fn 해소_봉투는_state_없이_선다() {
        let r = IdRegistry::default();
        assert!(declare_ids(&r, "w-a", 1, ids(&["pan-aaaaaa"])));
        assert_eq!(
            resolve_id(&r, "pan-aaaaaa"),
            serde_json::json!({ "kind": "one", "window": "w-a" })
        );
        assert!(declare_ids(&r, "w-b", 1, ids(&["pan-aaaaaa"])));
        assert_eq!(
            resolve_id(&r, "pan-aaaaaa"),
            serde_json::json!({ "kind": "many", "windows": ["w-a", "w-b"] })
        );
        assert_eq!(
            resolve_id(&r, "pan-zzzzzz"),
            serde_json::json!({ "kind": "none" })
        );
        assert!(
            !declare_ids(&r, "w-a", 0, ids(&["pan-old111"])),
            "낮은 세대 거절도 입구가 그대로 돌려준다"
        );
    }

    #[test]
    fn a_sole_declaration_resolves_to_its_window() {
        let r = IdRegistry::default();
        r.declare("w-a", 1, ids(&["pan-aaaaaa", "tab-bbbbbb"]));
        assert_eq!(r.resolve("pan-aaaaaa"), Resolution::One("w-a".into()));
    }

    #[test]
    fn a_collision_lists_every_owner_instead_of_guessing() {
        let r = IdRegistry::default();
        r.declare("w-b", 1, ids(&["tab-cccccc"]));
        r.declare("w-a", 1, ids(&["tab-cccccc"]));
        assert_eq!(
            r.resolve("tab-cccccc"),
            Resolution::Many(vec!["w-a".into(), "w-b".into()]),
            "둘 이상 = 후보 나열, 정렬은 표시 안정성일 뿐 선택이 아니다"
        );
    }

    #[test]
    fn redeclaration_replaces_the_whole_set() {
        // window.reload 는 Destroyed 없이 렌더러 상태를 버린다 — 다음 선언이 유령을 걷는다.
        let r = IdRegistry::default();
        r.declare("w-a", 1, ids(&["tab-old111"]));
        r.declare("w-a", 2, ids(&["tab-new222"]));
        assert_eq!(r.resolve("tab-old111"), Resolution::None);
        assert_eq!(r.resolve("tab-new222"), Resolution::One("w-a".into()));
    }

    #[test]
    fn a_late_stale_declaration_cannot_overwrite_a_newer_one() {
        let r = IdRegistry::default();
        r.declare("w-a", 2, ids(&["tab-new222"]));
        assert!(!r.declare("w-a", 1, ids(&["tab-old111"])), "낮은 세대는 버린다");
        assert_eq!(r.resolve("tab-new222"), Resolution::One("w-a".into()));
    }

    #[test]
    fn destroying_a_window_reclaims_its_declarations() {
        let r = IdRegistry::default();
        r.declare("w-a", 1, ids(&["pan-dddddd"]));
        r.forget_window("w-a");
        assert_eq!(r.resolve("pan-dddddd"), Resolution::None);
    }
}
