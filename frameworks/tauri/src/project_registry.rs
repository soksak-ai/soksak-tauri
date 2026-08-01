// 프로젝트 전역 단일 오픈 레지스트리 — workspace P6 의 시행 지점(단일 진실).
// 하나의 프로젝트(정규화 root)는 전 창을 통틀어 최대 1곳에만 열린다. 정체성=root(P4)라
// "같은 폴더 다른 프로젝트"는 정의상 불가 — 이 레지스트리가 그 전역 시행이다.
//
// in-memory 싱글톤(프로세스 수명): 재기동 = 빈 레지스트리라 crash-stale claim 이 없다.
// 변이는 "project-registry-change" 를 전 창에 브로드캐스트(크로스윈도우 상태 규칙 —
// Rust 싱글톤 + 창 오라클 배달). 프론트 가드(sessions P5, 창-로컬 dedup)는 UX 보조일 뿐
// 시행이 아니다. 충돌 응답은 소유 창 label — 호출측은 그 창을 포커스한다(중복 창 생성 금지).

use crate::window_oracle::WindowOracle;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct ProjectRegistry {
    // 정규화 root 경로 → 소유 창 label. 정규화는 호출부(validate_project_root) 책임.
    map: Mutex<HashMap<String, String>>,
}

impl ProjectRegistry {
    /// root 를 label 창이 점유. 이미 다른 창이 점유 중이면 Err(그 창 label).
    /// 같은 창의 재청구는 멱등 Ok(복원·재시도 경로가 안전하도록).
    /// 점유. `Ok(true)` = 지도가 실제로 바뀌었다, `Ok(false)` = 같은 창의 재청구(멱등).
    ///
    /// 둘을 가르는 이유: 통지는 **변이에만** 따라야 한다. 안 바뀐 것도 뿌리면 복원·재시도가
    /// 매번 전 창을 다시 읽게 만들고, 그 소음 속에서 진짜 변경이 묻힌다.
    pub fn claim(&self, root: &str, label: &str) -> Result<bool, String> {
        let mut m = self.map.lock().unwrap();
        match m.get(root) {
            Some(owner) if owner != label => Err(owner.clone()),
            Some(_) => Ok(false),
            None => {
                m.insert(root.to_string(), label.to_string());
                Ok(true)
            }
        }
    }

    /// root 해제 — 소유 창(label)의 요청일 때만 제거. 반환 = 실제로 제거됐는가.
    pub fn release(&self, root: &str, label: &str) -> bool {
        let mut m = self.map.lock().unwrap();
        match m.get(root) {
            Some(owner) if owner == label => {
                m.remove(root);
                true
            }
            _ => false,
        }
    }

    /// 창 파괴 시 그 창의 모든 점유 해제. 반환 = 해제된 root 목록.
    pub fn release_window(&self, label: &str) -> Vec<String> {
        let mut m = self.map.lock().unwrap();
        let roots: Vec<String> = m
            .iter()
            .filter(|(_, v)| v.as_str() == label)
            .map(|(k, _)| k.clone())
            .collect();
        for r in &roots {
            m.remove(r);
        }
        roots
    }

    /// root 의 현재 소유 창 label. 레지스트리 API·테스트가 덮는다(프로덕션 배선은 소비처가 생기면).
    #[allow(dead_code)]
    pub fn owner(&self, root: &str) -> Option<String> {
        self.map.lock().unwrap().get(root).cloned()
    }

    /// 전체 스냅샷(진단·list 커맨드용).
    pub fn snapshot(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .map
            .lock()
            .unwrap()
            .iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect();
        v.sort();
        v
    }
}

// ── 네 입구 ───────────────────────────────────────────────────────────────────
// 한 원장을 공유하는 넷이다. 여기서는 레지스트리와 **창 사실 계약**만 받는다 — 창이
// 살아 있는가와 사건을 뿌리는 것 둘 다 WindowOracle 이 이미 말하는 답이라, 호스트 타입이
// 시그니처에 없어야 앱 밖 디스패처가 같은 넷을 그대로 부른다.
// 아래 `#[tauri::command]` 는 State·핸들을 벗겨 넘기는 번역층이다(로직을 두지 않는다).

// 변이는 전 창 브로드캐스트("project-registry-change") — 크로스윈도우 반응(픽커 최근목록
// 비활성화 표시 등)은 이 신호를 listen 한다(폴링 금지).
fn emit_change(windows: &dyn WindowOracle) {
    windows.broadcast(soksak_core::project_registry::CHANGE_EVENT, serde_json::Value::Null);
}

/// root 를 label 창이 점유. 성사되면 변이를 알린다. 충돌이면 소유 창 label 을 Err 로.
pub(crate) fn claim(
    registry: &ProjectRegistry,
    windows: &dyn WindowOracle,
    root: &str,
    label: &str,
) -> Result<(), String> {
    let outcome = registry.claim(root, label);
    // 지도가 바뀌었을 때만 알린다 — 같은 창의 재청구는 아무것도 안 바꾼다.
    if matches!(outcome, Ok(true)) {
        emit_change(windows);
    }
    outcome.map(|_| ())
}

/// root 해제(소유 창만). 반환 = 실제로 해제됐는가.
pub(crate) fn release(
    registry: &ProjectRegistry,
    windows: &dyn WindowOracle,
    root: &str,
    label: &str,
) -> bool {
    let released = registry.release(root, label);
    if released {
        emit_change(windows);
    }
    released
}

/// 살아 있는 창의 점유만. Destroyed 를 못 받는 경로(SIGKILL·라벨 재사용 레이스)가 남긴
/// 유령 점유가 픽커/오케스트레이터에 "열림"으로 표면화되는 것을 구조적으로 차단한다
/// (실측: 닫힌 프로젝트가 열림+선택으로 표시).
pub(crate) fn owners_live(
    registry: &ProjectRegistry,
    windows: &dyn WindowOracle,
) -> Vec<(String, String)> {
    registry
        .snapshot()
        .into_iter()
        .filter(|(_, window)| windows.is_live(window))
        .collect()
}

/// 창 파괴 시 그 창의 모든 점유 해제. 반환 = 해제된 root 목록.
pub(crate) fn release_window(
    registry: &ProjectRegistry,
    windows: &dyn WindowOracle,
    label: &str,
) -> Vec<String> {
    let freed = registry.release_window(label);
    if !freed.is_empty() {
        emit_change(windows);
    }
    freed
}

// ── Tauri 커맨드 계층 ─────────────────────────────────────────────────────────

/// root 점유 시도. 성공 {ok:true}, 충돌 {ok:false, ownedBy:<label>}.
/// window = 호출 창(자동 인지 — 프론트 label 전달 불요).
#[tauri::command]
pub fn project_claim(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ProjectRegistry>,
    root: String,
) -> serde_json::Value {
    match claim(state.inner(), &app, &root, window.label()) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(owner) => serde_json::json!({ "ok": false, "ownedBy": owner }),
    }
}

/// root 해제(소유 창만). 반환 { released }.
#[tauri::command]
pub fn project_release(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, ProjectRegistry>,
    root: String,
) -> serde_json::Value {
    let released = release(state.inner(), &app, &root, window.label());
    serde_json::json!({ "released": released })
}

/// 전역 점유 스냅샷 { owners: [{root,window}] } — 픽커의 "다른 창에 열림" 표시용.
#[tauri::command]
pub fn project_owners(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectRegistry>,
) -> serde_json::Value {
    let owners: Vec<serde_json::Value> = owners_live(state.inner(), &app)
        .into_iter()
        .map(|(root, window)| serde_json::json!({ "root": root, "window": window }))
        .collect();
    serde_json::json!({ "owners": owners })
}

/// 창 파괴 시 정리(lib.rs WindowEvent::Destroyed 에서 호출).
pub fn on_window_destroyed(app: &tauri::AppHandle, label: &str) {
    let registry = {
        use tauri::Manager;
        app.state::<ProjectRegistry>()
    };
    release_window(registry.inner(), app, label);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_oracle::WindowOracle;

    /// 계약만 구현한 창 — Tauri 없이 점유 보고·브로드캐스트를 검증한다.
    struct Fake {
        labels: Vec<String>,
        sent: Mutex<Vec<String>>,
    }

    impl WindowOracle for Fake {
        fn live_labels(&self) -> Vec<String> {
            self.labels.clone()
        }
        fn emit_to(&self, _label: &str, _event: &str, _payload: serde_json::Value) -> bool {
            true
        }
        fn broadcast(&self, event: &str, _payload: serde_json::Value) -> bool {
            self.sent.lock().unwrap().push(event.to_string());
            true
        }
    }

    fn fake(labels: &[&str]) -> Fake {
        Fake {
            labels: labels.iter().map(|s| s.to_string()).collect(),
            sent: Mutex::new(Vec::new()),
        }
    }

    // 유령 점유 필터는 "그 창이 살아 있는가" 하나만 필요하다. 그 사실을 앱 핸들에서 캐면
    // 필터 로직이 앱 프로세스를 못 떠나고, 앱 없이는 한 줄도 검증할 수 없다.
    #[test]
    fn 죽은_창의_점유는_보고에서_빠진다() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/live", "w-live").is_ok());
        assert!(r.claim("/ghost", "w-dead").is_ok()); // Destroyed 를 못 받은 창
        assert_eq!(
            owners_live(&r, &fake(&["w-live"])),
            vec![("/live".to_string(), "w-live".to_string())],
            "죽은 창의 점유가 '열림'으로 표면화되면 픽커가 못 여는 프로젝트를 열림으로 보인다"
        );
    }

    // 점유 성사만 브로드캐스트한다 — 충돌은 상태를 안 바꿨으니 알릴 것도 없다.
    #[test]
    fn 점유_변이만_브로드캐스트한다() {
        let r = ProjectRegistry::default();
        let o = fake(&["main", "w-1"]);
        assert!(claim(&r, &o, "/a", "main").is_ok());
        assert_eq!(o.sent.lock().unwrap().as_slice(), ["project-registry-change"]);
        // 같은 창의 재청구는 지도를 안 바꾼다 — 안 바뀐 것을 뿌리면 복원·재시도가 매번 전
        // 창을 다시 읽게 만들고, 그 소음 속에서 진짜 변경이 묻힌다(Electron 쪽 픽스처 검사와
        // 같은 규칙: 통지 수 = 변이 수).
        assert!(claim(&r, &o, "/a", "main").is_ok(), "재청구는 멱등이다");
        assert_eq!(
            o.sent.lock().unwrap().len(),
            1,
            "멱등 재청구는 지도를 안 바꿨으니 알릴 것도 없다"
        );
        assert_eq!(claim(&r, &o, "/a", "w-1"), Err("main".to_string()));
        assert_eq!(
            o.sent.lock().unwrap().len(),
            1,
            "거절된 claim 은 상태를 안 바꿨다 — 알릴 변이가 없다"
        );
        assert!(release(&r, &o, "/a", "main"));
        assert_eq!(o.sent.lock().unwrap().len(), 2);
        assert!(!release(&r, &o, "/a", "w-1"));
        assert_eq!(o.sent.lock().unwrap().len(), 2, "무효 release 도 변이가 아니다");
    }

    #[test]
    fn 중복_claim_은_소유_창을_알린다() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert_eq!(r.claim("/a", "w-1"), Err("main".to_string()));
        assert_eq!(r.owner("/a").as_deref(), Some("main"));
    }

    #[test]
    fn 같은_창의_재청구는_멱등() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(r.claim("/a", "main").is_ok());
    }

    #[test]
    fn release_후_재claim_성공() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(r.release("/a", "main"));
        assert!(r.claim("/a", "w-1").is_ok());
        assert_eq!(r.owner("/a").as_deref(), Some("w-1"));
    }

    #[test]
    fn 비소유_창의_release_는_무효() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "main").is_ok());
        assert!(!r.release("/a", "w-1")); // 남의 점유는 못 푼다
        assert_eq!(r.owner("/a").as_deref(), Some("main"));
    }

    #[test]
    fn 창_파괴는_그_창의_점유만_전부_해제() {
        let r = ProjectRegistry::default();
        assert!(r.claim("/a", "w-1").is_ok());
        assert!(r.claim("/b", "w-1").is_ok());
        assert!(r.claim("/c", "main").is_ok());
        let mut freed = r.release_window("w-1");
        freed.sort();
        assert_eq!(freed, vec!["/a".to_string(), "/b".to_string()]);
        assert_eq!(r.owner("/a"), None);
        assert_eq!(r.owner("/c").as_deref(), Some("main"));
    }

    /// 픽스처가 오라클이다 — 이 파일 하나를 프레임워크 쪽 검사도 읽는다.
    ///
    /// 지도는 창을 소유한 쪽이 진다(수명이 창의 수명)라서 구현이 둘이다. 규칙까지 둘이면
    /// 같은 조작에 두 프레임워크가 다르게 답하고, 그 차이는 "이쪽에서만 프로젝트가 안 열린다"다.
    #[test]
    fn the_fixture_binds_both_implementations() {
        let raw = include_str!("../../../crates/soksak-core/fixtures/project-claims.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("픽스처 JSON");
        let cases = doc["cases"].as_array().expect("cases");
        // 오라클 생존 — 비면 아무것도 안 지키면서 통과한다.
        assert!(!cases.is_empty(), "픽스처가 비었다");
        for c in cases {
            let why = c["why"].as_str().unwrap_or("");
            let reg = ProjectRegistry::default();
            for step in c["steps"].as_array().unwrap() {
                let root = step["root"].as_str().unwrap_or("");
                let label = step["label"].as_str().unwrap_or("");
                match step["op"].as_str().unwrap() {
                    "claim" => {
                        let got = reg.claim(root, label);
                        let want = &step["want"];
                        if want["ok"] == true {
                            assert!(got.is_ok(), "{why}: claim 이 실패했다 {got:?}");
                        } else {
                            let owner = got.expect_err(why);
                            assert_eq!(owner, want["ownedBy"].as_str().unwrap(), "{why}");
                        }
                    }
                    "release" => {
                        assert_eq!(
                            reg.release(root, label),
                            step["want"]["released"].as_bool().unwrap(),
                            "{why}"
                        );
                    }
                    // 살아 있는 창이 바뀌었다 — 죽은 창의 점유는 그 순간 점유가 아니다.
                    "alive" => {
                        let alive: Vec<&str> = step["labels"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap())
                            .collect();
                        for (root, owner) in reg.snapshot() {
                            if !alive.contains(&owner.as_str()) {
                                reg.release(&root, &owner);
                            }
                        }
                    }
                    op => panic!("{why}: 모르는 단계 {op}"),
                }
            }
            let want: Vec<(String, String)> = c["owners"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    (
                        o["root"].as_str().unwrap().to_string(),
                        o["window"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            assert_eq!(reg.snapshot(), want, "{why}");
        }
    }
}
