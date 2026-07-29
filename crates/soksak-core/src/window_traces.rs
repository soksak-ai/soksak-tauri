// 닫힌 창의 **영속 흔적** — 무엇을 지우는가.
//
// 창을 만들고 부수는 일은 프레임워크의 것이다. 하지만 "닫힌 창이 무엇을 남기는가"는
// 프레임워크의 것이 아니다. 흔적을 남기면 다음 부트의 리스폰이 그 slot 을 그대로 되살린다 —
// 사용자가 닫은 창이 재시작마다 돌아오고, 닫을수록 늘어난다.
//
// 실측(2026-07-28, Electron): 창을 전부 닫은 뒤 컨트롤 창을 한 번 재적재하자 여태 열었던 창
// 15 개가 되살아났다. 방금 닫은 창까지 포함해서다. 규칙이 프레임워크 쪽에 한 벌씩 있었기
// 때문이다 — 한쪽(Tauri)은 Destroyed 에서 지웠고, 다른 쪽에는 그 자리가 아예 없었다.
// 그래서 규칙은 여기 하나로 두고 저장소를 가진 쪽이 각자 부른다.
//
// 흔적은 둘이다:
//  ① 그 창의 워크스페이스 스냅샷 — kv `core:window/<label>`
//  ② 복원 manifest `core:windows` 의 그 창 slot
// 하나만 지우면 반쪽이 남는다: 스냅샷만 지우면 리스폰이 빈 slot 을 살려 유령 창이 뜨고,
// slot 만 지우면 스냅샷이 영원히 쌓인다.
//
// 값만 다룬다 — 저장소를 열지도, 창을 부수지도 않는다. 둘 다 부르는 쪽의 자원이다.

use serde_json::Value;

/// 창 흔적이 사는 ns.
pub const NS: &str = "core";

/// 복원 manifest 의 키.
pub const MANIFEST_KEY: &str = "windows";

/// 이 창의 워크스페이스 스냅샷 키.
///
/// 앱이 저장할 때 쓰는 모양과 **같아야 한다**(makeCoreStore key `window/<label>`). 갈리면
/// 지우는 쪽이 없는 키를 지우고 진짜 스냅샷은 남는다 — 조용히, 오류 없이.
pub fn snapshot_key(label: &str) -> String {
    format!("window/{label}")
}

/// manifest 에서 이 창의 slot 을 뺀다. 뺐으면 true.
///
/// 바뀐 게 없으면 false 다 — 부르는 쪽은 그때 저장하지 않는다. 안 바뀐 값을 다시 쓰면
/// 그 쓰기가 다른 창의 동시 갱신을 되돌린다.
///
/// manifest 모양이 예상과 다르면(슬롯 배열이 없으면) 손대지 않는다. 모르는 모양을 고쳐 쓰면
/// 그 순간 복원 상태 전체를 잃는다 — 흔적 하나 지우자고 낼 대가가 아니다.
pub fn prune_slot(manifest: &mut Value, label: &str) -> bool {
    let Some(slots) = manifest.get_mut("slots").and_then(|s| s.as_array_mut()) else {
        return false;
    };
    let before = slots.len();
    slots.retain(|s| s.get("label").and_then(|l| l.as_str()) != Some(label));
    slots.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({
            "focusedLabel": "w-2",
            "slots": [
                { "label": "w-1", "roots": ["/a"] },
                { "label": "w-2", "roots": ["/b"] }
            ]
        })
    }

    /// 앱이 저장하는 키와 같아야 한다 — 갈리면 없는 키를 지우고 진짜는 남는다.
    #[test]
    fn the_snapshot_key_is_the_one_the_app_writes() {
        assert_eq!(snapshot_key("w-1"), "window/w-1");
    }

    #[test]
    fn pruning_removes_only_that_slot() {
        let mut m = manifest();
        assert!(prune_slot(&mut m, "w-1"));
        let labels: Vec<&str> = m["slots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, vec!["w-2"]);
        // 다른 최상위 필드는 건드리지 않는다.
        assert_eq!(m["focusedLabel"], "w-2");
    }

    /// 안 바뀐 값을 다시 쓰면 그 쓰기가 다른 창의 동시 갱신을 되돌린다.
    #[test]
    fn pruning_an_absent_slot_changes_nothing() {
        let mut m = manifest();
        assert!(!prune_slot(&mut m, "w-없음"));
        assert_eq!(m, manifest());
    }

    /// 두 번 지워도 두 번째는 조용히 없음이다 — 회수 경로는 여러 번 불릴 수 있다.
    #[test]
    fn pruning_is_idempotent() {
        let mut m = manifest();
        assert!(prune_slot(&mut m, "w-1"));
        assert!(!prune_slot(&mut m, "w-1"));
    }

    /// 모르는 모양을 고쳐 쓰면 복원 상태 전체를 잃는다 — 흔적 하나 값이 아니다.
    #[test]
    fn an_unknown_manifest_shape_is_left_alone() {
        for mut odd in [json!({}), json!({ "slots": "nope" }), json!([]), json!(null)] {
            let before = odd.clone();
            assert!(!prune_slot(&mut odd, "w-1"));
            assert_eq!(odd, before);
        }
    }
}
