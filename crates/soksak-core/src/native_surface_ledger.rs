use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Deserialize;

/// DOM이 공개한 네이티브 표면 제외 영역. CSS 논리 px, top-left 원점이다.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SurfaceHole {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Default)]
pub struct NativeWindowLabels(Mutex<Vec<(usize, String)>>);

impl NativeWindowLabels {
    pub fn register(&self, ptr: usize, label: &str) {
        if let Ok(mut labels) = self.0.lock() {
            labels.retain(|(known_ptr, known_label)| *known_ptr != ptr && known_label != label);
            labels.push((ptr, label.to_owned()));
        }
    }
    pub fn forget(&self, label: &str) {
        if let Ok(mut labels) = self.0.lock() {
            labels.retain(|(_, known)| known != label);
        }
    }
    pub fn label(&self, ptr: usize) -> Option<String> {
        self.0
            .lock()
            .ok()?
            .iter()
            .find(|(known, _)| *known == ptr)
            .map(|(_, label)| label.clone())
    }
}

pub struct EventThrottle {
    started: Instant,
    last_ms: AtomicU64,
}

impl Default for EventThrottle {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            last_ms: AtomicU64::new(u64::MAX),
        }
    }
}

impl EventThrottle {
    pub fn allow_every_ms(&self, interval: u64) -> bool {
        let now = self.started.elapsed().as_millis() as u64;
        let last = self.last_ms.load(Ordering::Relaxed);
        if last != u64::MAX && now.saturating_sub(last) < interval {
            return false;
        }
        self.last_ms.store(now, Ordering::Relaxed);
        true
    }
}

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
        self.0
            .lock()
            .map(|state| state.members.clone())
            .unwrap_or_default()
    }

    pub fn label(&self, ptr: usize) -> Option<String> {
        self.0.lock().ok()?.labels.get(&ptr).cloned()
    }
}

/// 네이티브 표면을 담는 host의 identity와 소유 창을 같은 수명으로 보존한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSurfaceHost {
    pub ptr: usize,
    pub window: String,
}

#[derive(Default)]
pub struct NativeSurfaceHosts(Mutex<BTreeMap<String, NativeSurfaceHost>>);

impl NativeSurfaceHosts {
    pub fn register(&self, label: &str, ptr: usize, window: &str) {
        if let Ok(mut hosts) = self.0.lock() {
            hosts.insert(
                label.to_owned(),
                NativeSurfaceHost {
                    ptr,
                    window: window.to_owned(),
                },
            );
        }
    }

    pub fn ptr(&self, label: &str) -> Option<usize> {
        self.0.lock().ok()?.get(label).map(|host| host.ptr)
    }

    pub fn host(&self, label: &str) -> Option<NativeSurfaceHost> {
        self.0.lock().ok()?.get(label).cloned()
    }

    pub fn remove(&self, label: &str) -> Option<NativeSurfaceHost> {
        self.0.lock().ok()?.remove(label)
    }

    pub fn labels_in(&self, window: &str) -> Vec<String> {
        self.0
            .lock()
            .map(|hosts| {
                hosts
                    .iter()
                    .filter(|(_, host)| host.window == window)
                    .map(|(label, _)| label.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// back-to-front sibling 목록에서 host 하나만 main 바로 앞/뒤 경계로 옮긴다.
pub fn surface_sibling_order(
    siblings: &[usize],
    host_ptr: usize,
    main_ptr: usize,
    above_main: bool,
) -> Vec<usize> {
    if host_ptr == main_ptr || !siblings.contains(&host_ptr) || !siblings.contains(&main_ptr) {
        return siblings.to_vec();
    }
    let mut reordered = siblings
        .iter()
        .copied()
        .filter(|ptr| *ptr != host_ptr)
        .collect::<Vec<_>>();
    let Some(main_index) = reordered.iter().position(|ptr| *ptr == main_ptr) else {
        return siblings.to_vec();
    };
    reordered.insert(main_index + usize::from(above_main), host_ptr);
    reordered
}

pub type SurfaceRect = (f64, f64, f64, f64);

#[derive(Default)]
struct SurfaceLayoutState {
    window_zoom: HashMap<String, f64>,
    view_zoom: HashMap<String, f64>,
    raw: HashMap<String, SurfaceRect>,
    applied: HashMap<String, SurfaceRect>,
}

#[derive(Default)]
pub struct NativeSurfaceLayout(Mutex<SurfaceLayoutState>);

impl NativeSurfaceLayout {
    pub fn set_window_zoom(&self, label: &str, zoom: f64) {
        if let Ok(mut state) = self.0.lock() {
            state.window_zoom.insert(label.to_owned(), zoom);
        }
    }
    pub fn window_zoom(&self, label: &str) -> f64 {
        self.0
            .lock()
            .ok()
            .and_then(|state| state.window_zoom.get(label).copied())
            .unwrap_or(1.0)
    }
    pub fn set_view_zoom(&self, label: &str, zoom: f64) {
        if let Ok(mut state) = self.0.lock() {
            state.view_zoom.insert(label.to_owned(), zoom);
        }
    }
    pub fn view_zoom(&self, label: &str) -> f64 {
        self.0
            .lock()
            .ok()
            .and_then(|state| state.view_zoom.get(label).copied())
            .unwrap_or(1.0)
    }
    pub fn set_raw(&self, label: &str, rect: SurfaceRect) {
        if let Ok(mut state) = self.0.lock() {
            state.raw.insert(label.to_owned(), rect);
        }
    }
    pub fn raw(&self, label: &str) -> Option<SurfaceRect> {
        self.0.lock().ok()?.raw.get(label).copied()
    }
    pub fn set_applied(&self, label: &str, rect: SurfaceRect) {
        if let Ok(mut state) = self.0.lock() {
            state.applied.insert(label.to_owned(), rect);
        }
    }
    pub fn applied(&self, label: &str) -> Option<SurfaceRect> {
        self.0.lock().ok()?.applied.get(label).copied()
    }
    pub fn remove_surface(&self, label: &str) {
        if let Ok(mut state) = self.0.lock() {
            state.view_zoom.remove(label);
            state.raw.remove(label);
            state.applied.remove(label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        surface_sibling_order, EventThrottle, NativeSurfaceHosts, NativeSurfaceLayout,
        NativeSurfaceLedger, NativeWindowLabels,
    };

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

    #[test]
    fn host_registry_owns_identity_and_window_membership_together() {
        let hosts = NativeSurfaceHosts::default();
        hosts.register("browser-a", 11, "window-a");
        hosts.register("browser-b", 22, "window-a");
        hosts.register("browser-c", 33, "window-b");

        assert_eq!(hosts.ptr("browser-a"), Some(11));
        assert_eq!(
            hosts.host("browser-a").map(|host| host.window),
            Some("window-a".into())
        );
        assert_eq!(hosts.labels_in("window-a"), vec!["browser-a", "browser-b"]);
        assert_eq!(hosts.remove("browser-a").map(|host| host.ptr), Some(11));
        assert_eq!(hosts.ptr("browser-a"), None);
    }

    #[test]
    fn sibling_order_moves_only_the_named_host_around_main() {
        let siblings = [10, 20, 30, 40];
        assert_eq!(
            surface_sibling_order(&siblings, 10, 40, true),
            vec![20, 30, 40, 10]
        );
        assert_eq!(
            surface_sibling_order(&siblings, 10, 40, false),
            vec![20, 30, 10, 40]
        );
        assert_eq!(surface_sibling_order(&siblings, 99, 40, true), siblings);
    }

    #[test]
    fn layout_state_keeps_raw_applied_and_zoom_axes_separate() {
        let layout = NativeSurfaceLayout::default();
        layout.set_window_zoom("window-a", 1.5);
        layout.set_view_zoom("browser-a", 1.2);
        layout.set_raw("browser-a", (1.0, 2.0, 3.0, 4.0));
        layout.set_applied("browser-a", (2.0, 3.0, 4.0, 5.0));
        assert_eq!(layout.window_zoom("window-a"), 1.5);
        assert_eq!(layout.view_zoom("browser-a"), 1.2);
        assert_eq!(layout.raw("browser-a"), Some((1.0, 2.0, 3.0, 4.0)));
        assert_eq!(layout.applied("browser-a"), Some((2.0, 3.0, 4.0, 5.0)));
        layout.remove_surface("browser-a");
        assert_eq!(layout.raw("browser-a"), None);
        assert_eq!(layout.applied("browser-a"), None);
        assert_eq!(layout.view_zoom("browser-a"), 1.0);
    }

    #[test]
    fn native_window_labels_replace_reused_pointer_and_label() {
        let labels = NativeWindowLabels::default();
        labels.register(10, "window-a");
        labels.register(20, "window-b");
        labels.register(11, "window-a");
        assert_eq!(labels.label(10), None);
        assert_eq!(labels.label(11).as_deref(), Some("window-a"));
        labels.forget("window-a");
        assert_eq!(labels.label(11), None);
        assert_eq!(labels.label(20).as_deref(), Some("window-b"));
    }

    #[test]
    fn event_throttle_allows_first_event_without_polling() {
        let throttle = EventThrottle::default();
        assert!(throttle.allow_every_ms(25));
        assert!(!throttle.allow_every_ms(25));
    }
}
