use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// 네이티브 표면의 불투명 identity와 선택적 공개 label을 한 잠금 아래 보존한다.
///
/// 포인터는 이 타입에서 역참조하지 않는다. 프레임워크가 살아 있는 네이티브 트리를 순회할 때
/// 멤버십을 대조하는 키일 뿐이며, label은 그 identity와 같은 등록 수명을 갖는다.
#[derive(Default)]
pub struct NativeSurfaceLedger(Mutex<LedgerState>);

#[derive(Default)]
struct LedgerState {
    members: HashSet<usize>,
    labels: HashMap<usize, String>,
}

impl NativeSurfaceLedger {
    pub fn register(&self, ptr: usize, label: Option<&str>) {
        if let Ok(mut state) = self.0.lock() {
            state.members.insert(ptr);
            if let Some(label) = label {
                state.labels.insert(ptr, label.to_owned());
            }
        }
    }

    pub fn unregister(&self, ptr: usize) {
        if let Ok(mut state) = self.0.lock() {
            state.members.remove(&ptr);
            state.labels.remove(&ptr);
        }
    }

    pub fn len(&self) -> usize {
        self.0.lock().map(|state| state.members.len()).unwrap_or(0)
    }

    pub fn members(&self) -> HashSet<usize> {
        self.0.lock().map(|state| state.members.clone()).unwrap_or_default()
    }

    pub fn label(&self, ptr: usize) -> Option<String> {
        self.0.lock().ok()?.labels.get(&ptr).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::NativeSurfaceLedger;

    #[test]
    fn label_and_membership_have_one_lifetime() {
        let ledger = NativeSurfaceLedger::default();
        ledger.register(7, Some("browser-7"));
        assert!(ledger.members().contains(&7));
        assert_eq!(ledger.label(7).as_deref(), Some("browser-7"));

        ledger.unregister(7);
        assert!(!ledger.members().contains(&7));
        assert_eq!(ledger.label(7), None);
    }

    #[test]
    fn an_unlabelled_engine_surface_is_still_a_member() {
        let ledger = NativeSurfaceLedger::default();
        ledger.register(9, None);
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger.label(9), None);
    }
}
