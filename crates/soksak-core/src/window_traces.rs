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

/// manifest 에 이 창의 slot 을 넣는다(같은 label 은 교체). 바뀌었으면 true.
///
/// **읽기·병합·쓰기가 한 자리에서 일어나야 한다.** 부르는 쪽이 전체를 읽어 고쳐 쓰면, 같은
/// 홈을 보는 두 프로세스가 겹칠 때 나중 쓰기가 상대의 slot 을 지운다 — 그 손실은 오류가
/// 아니라 "재시작했더니 저쪽 창이 안 열린다"로 나타난다. 그래서 이 병합은 저장소를 쥔 쪽이
/// 한 트랜잭션 안에서 부른다.
///
/// `roots` 가 비면 제거다 — 워크스페이스가 없는 창은 되살릴 것이 없다.
///
/// manifest 모양이 예상과 다르면 손대지 않는다(`prune_slot` 과 같은 이유).
pub fn upsert_slot(manifest: &mut Value, entry: &Value) -> bool {
    let Some(label) = entry.get("label").and_then(|l| l.as_str()) else {
        return false;
    };
    let empty = entry
        .get("roots")
        .and_then(|r| r.as_array())
        .map(|r| r.is_empty())
        .unwrap_or(true);
    if empty {
        return prune_slot(manifest, label);
    }
    let Some(slots) = manifest.get_mut("slots").and_then(|s| s.as_array_mut()) else {
        return false;
    };
    if let Some(existing) = slots
        .iter_mut()
        .find(|s| s.get("label").and_then(|l| l.as_str()) == Some(label))
    {
        // 같은 값을 다시 쓰지 않는다 — 안 바뀐 쓰기가 다른 창의 동시 갱신을 되돌린다.
        if existing == entry {
            return false;
        }
        *existing = entry.clone();
        return true;
    }
    slots.push(entry.clone());
    true
}

/// 마지막 포커스 창 기록. 바뀌었으면 true.
pub fn set_focused(manifest: &mut Value, label: &str) -> bool {
    let Some(obj) = manifest.as_object_mut() else {
        return false;
    };
    if obj.get("focusedLabel").and_then(|l| l.as_str()) == Some(label) {
        return false;
    }
    obj.insert("focusedLabel".into(), Value::String(label.to_string()));
    true
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

#[cfg(test)]
mod upsert_tests {
    use super::*;
    use serde_json::json;

    fn slot(label: &str, root: &str) -> Value {
        json!({ "label": label, "roots": [root], "activeRoot": root })
    }

    /// 두 프로세스가 각자 자기 창을 넣어도 **둘 다 남는다** — 이것이 레이스가 닫혔다는 뜻이다.
    ///
    /// RED 근거: 부르는 쪽이 전체를 읽어 고쳐 쓰면(read-modify-write) 나중 쓰기가 상대의 slot 을
    /// 지운다. 같은 홈을 Tauri 와 Electron 이 함께 보므로 그 겹침은 가정이 아니라 일상이다.
    #[test]
    fn 서로_다른_창은_함께_남는다() {
        let mut m = json!({ "slots": [] });
        assert!(upsert_slot(&mut m, &slot("w-tauri", "/a")));
        assert!(upsert_slot(&mut m, &slot("w-electron", "/b")));
        let labels: Vec<&str> =
            m["slots"].as_array().unwrap().iter().map(|s| s["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec!["w-tauri", "w-electron"]);
    }

    #[test]
    fn 같은_창은_교체된다() {
        let mut m = json!({ "slots": [] });
        upsert_slot(&mut m, &slot("w-1", "/a"));
        assert!(upsert_slot(&mut m, &slot("w-1", "/b")));
        assert_eq!(m["slots"].as_array().unwrap().len(), 1);
        assert_eq!(m["slots"][0]["activeRoot"], "/b");
    }

    /// 같은 값을 다시 쓰지 않는다 — 안 바뀐 쓰기가 다른 창의 동시 갱신을 되돌린다.
    #[test]
    fn 안_바뀌면_쓰지_않는다() {
        let mut m = json!({ "slots": [] });
        upsert_slot(&mut m, &slot("w-1", "/a"));
        assert!(!upsert_slot(&mut m, &slot("w-1", "/a")));
    }

    /// roots 가 비면 제거다 — 워크스페이스 없는 창은 되살릴 것이 없다.
    #[test]
    fn 빈_roots_는_제거다() {
        let mut m = json!({ "slots": [] });
        upsert_slot(&mut m, &slot("w-1", "/a"));
        assert!(upsert_slot(&mut m, &json!({ "label": "w-1", "roots": [] })));
        assert!(m["slots"].as_array().unwrap().is_empty());
    }

    #[test]
    fn 포커스_기록은_바뀔_때만_참이다() {
        let mut m = json!({ "slots": [] });
        assert!(set_focused(&mut m, "w-1"));
        assert!(!set_focused(&mut m, "w-1"));
        assert_eq!(m["focusedLabel"], "w-1");
    }
}
