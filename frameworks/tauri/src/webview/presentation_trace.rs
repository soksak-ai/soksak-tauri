use serde::{Deserialize, Serialize};

/// Public identity binding for one DOM content owner and its native pane surface host.
///
/// All three identities are declared by the caller. The Tauri adapter does not recover a view id
/// or logical workspace pane from a framework name, DOM selector, or native-host label convention.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresentationTraceOwner {
    pub(crate) view_id: String,
    pub(crate) native_host_id: String,
    pub(crate) surface_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(super) struct PresentationRect {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) w: f64,
    pub(super) h: f64,
}

impl PresentationRect {
    pub(super) fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PresentationSurface {
    pub(super) view_id: String,
    pub(super) surface_id: String,
    pub(super) generation: u64,
    pub(super) live: bool,
    pub(super) visible: bool,
    pub(super) painted: bool,
    pub(super) dom_frame: PresentationRect,
    pub(super) surface_frame: PresentationRect,
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::{RefCell, RefMut};
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
    use objc2_quartz_core::{CACurrentMediaTime, CADisplayLink};
    use serde::Serialize;
    use tokio::sync::oneshot;

    use super::{PresentationSurface, PresentationTraceOwner};
    use crate::webview::layer;

    const DEFAULT_MAX_EVENTS: usize = 256;
    const MIN_MAX_EVENTS: usize = 2;
    const MAX_MAX_EVENTS: usize = 4096;
    const FIRST_DISPLAY_TIMEOUT: Duration = Duration::from_secs(1);
    const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(1);
    const MAX_PRESENTATION_GAP_MS: f64 = 50.0;

    static NEXT_SOURCE_GENERATION: AtomicU64 = AtomicU64::new(1);

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PresentationEvent {
        sequence: usize,
        source_generation: u64,
        presentation_revision: u64,
        presented_at_unix_ms: f64,
        surfaces: Vec<PresentationSurface>,
    }

    #[derive(Clone, Debug, Default, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PresentationViolations {
        replacements: u64,
        gaps: u64,
        disappearances: u64,
        unpresented: u64,
        dropped_events: u64,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ArmReceipt {
        trace_id: String,
        owner_view_ids: Vec<String>,
        armed_at_unix_ms: f64,
        baseline_frame_sequence: usize,
        source_generation: u64,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CloseReceipt {
        trace_id: String,
        closed: bool,
        owner_view_ids: Vec<String>,
        armed_at_unix_ms: f64,
        baseline_frame_sequence: usize,
        presentation_events: Vec<PresentationEvent>,
        violations: PresentationViolations,
    }

    struct TraceState {
        trace_id: String,
        owners: Vec<PresentationTraceOwner>,
        armed_at_unix_ms: f64,
        unix_from_media_ms: f64,
        source_generation: u64,
        next_revision: u64,
        max_events: usize,
        events: Vec<PresentationEvent>,
        baseline_sender: Option<oneshot::Sender<Result<ArmReceipt, String>>>,
        baseline_identity: Option<HashMap<String, (String, u64)>>,
        violations: PresentationViolations,
    }

    impl TraceState {
        fn owner_view_ids(&self) -> Vec<String> {
            self.owners
                .iter()
                .map(|owner| owner.view_id.clone())
                .collect()
        }

        fn arm_receipt(&self) -> ArmReceipt {
            ArmReceipt {
                trace_id: self.trace_id.clone(),
                owner_view_ids: self.owner_view_ids(),
                armed_at_unix_ms: self.armed_at_unix_ms,
                baseline_frame_sequence: 0,
                source_generation: self.source_generation,
            }
        }

        fn close_receipt(&self) -> CloseReceipt {
            CloseReceipt {
                trace_id: self.trace_id.clone(),
                closed: true,
                owner_view_ids: self.owner_view_ids(),
                armed_at_unix_ms: self.armed_at_unix_ms,
                baseline_frame_sequence: 0,
                presentation_events: self.events.clone(),
                violations: self.violations.clone(),
            }
        }

        fn fail_baseline(&mut self, error: String) {
            if let Some(sender) = self.baseline_sender.take() {
                let _ = sender.send(Err(error));
            }
        }

        fn record_display(&mut self, link: &CADisplayLink) {
            // Apple's timestamp is the time the previous frame was actually displayed. A link can
            // first report the refresh immediately preceding installation; that frame is outside
            // this transaction and must not become its baseline.
            let displayed_at_unix_ms = self.unix_from_media_ms + link.timestamp() * 1000.0;
            if !displayed_at_unix_ms.is_finite()
                || displayed_at_unix_ms + f64::EPSILON < self.armed_at_unix_ms
            {
                return;
            }
            if let Some(previous) = self.events.last().map(|event| event.presented_at_unix_ms) {
                if displayed_at_unix_ms <= previous {
                    self.violations.dropped_events =
                        self.violations.dropped_events.saturating_add(1);
                    return;
                }
                if displayed_at_unix_ms - previous > MAX_PRESENTATION_GAP_MS {
                    self.violations.gaps = self.violations.gaps.saturating_add(1);
                }
            }
            if self.events.len() >= self.max_events {
                self.violations.dropped_events = self.violations.dropped_events.saturating_add(1);
                return;
            }

            let surfaces = match layer::capture_pane_presentations(&self.owners) {
                Ok(surfaces) => surfaces,
                Err(error) => {
                    self.violations.disappearances =
                        self.violations.disappearances.saturating_add(1);
                    self.violations.unpresented = self.violations.unpresented.saturating_add(1);
                    self.fail_baseline(error);
                    return;
                }
            };
            if surfaces
                .iter()
                .any(|surface| !surface.live || !surface.visible)
            {
                self.violations.disappearances = self.violations.disappearances.saturating_add(1);
            }
            if surfaces.iter().any(|surface| !surface.painted) {
                self.violations.unpresented = self.violations.unpresented.saturating_add(1);
            }

            let identity = surfaces
                .iter()
                .map(|surface| {
                    (
                        surface.view_id.clone(),
                        (surface.surface_id.clone(), surface.generation),
                    )
                })
                .collect::<HashMap<_, _>>();
            if let Some(baseline) = &self.baseline_identity {
                if baseline != &identity {
                    self.violations.replacements = self.violations.replacements.saturating_add(1);
                }
            } else {
                self.baseline_identity = Some(identity);
            }

            let sequence = self.events.len();
            let revision = self.next_revision;
            self.next_revision = self.next_revision.saturating_add(1);
            self.events.push(PresentationEvent {
                sequence,
                source_generation: self.source_generation,
                presentation_revision: revision,
                presented_at_unix_ms: displayed_at_unix_ms,
                surfaces,
            });
            if sequence == 0 {
                if let Some(sender) = self.baseline_sender.take() {
                    let _ = sender.send(Ok(self.arm_receipt()));
                }
            }
        }
    }

    pub struct PresentationTraceTargetIvars {
        state: RefCell<TraceState>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PresentationTraceTargetIvars]
        #[name = "SoksakPanePresentationTraceTarget"]
        struct PresentationTraceTarget;

        unsafe impl NSObjectProtocol for PresentationTraceTarget {}

        impl PresentationTraceTarget {
            #[unsafe(method(recordPresentation:))]
            fn record_presentation(&self, link: &CADisplayLink) {
                self.ivars().state.borrow_mut().record_display(link);
            }
        }
    );

    struct TraceEntry {
        window: String,
        _target: Retained<PresentationTraceTarget>,
        link: Retained<CADisplayLink>,
    }

    thread_local! {
        static ACTIVE_TRACES: RefCell<HashMap<String, TraceEntry>> = RefCell::new(HashMap::new());
    }

    fn unix_ms() -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }

    fn validated_owners(
        mut owners: Vec<PresentationTraceOwner>,
    ) -> Result<Vec<PresentationTraceOwner>, String> {
        if owners.is_empty() {
            return Err("presentation trace owner가 비었습니다".into());
        }
        let mut view_ids = HashSet::new();
        for owner in &owners {
            if owner.view_id.trim().is_empty()
                || owner.native_host_id.trim().is_empty()
                || owner.surface_id.trim().is_empty()
            {
                return Err("presentation trace identity가 비었습니다".into());
            }
            if !view_ids.insert(owner.view_id.clone()) {
                return Err(format!(
                    "presentation trace viewId가 중복됩니다: {}",
                    owner.view_id
                ));
            }
        }
        owners.sort_by(|left, right| left.view_id.cmp(&right.view_id));
        Ok(owners)
    }

    fn install_on_main(
        window: String,
        trace_id: String,
        owners: Vec<PresentationTraceOwner>,
        max_events: usize,
        baseline_sender: oneshot::Sender<Result<ArmReceipt, String>>,
    ) {
        if ACTIVE_TRACES.with(|traces| traces.borrow().contains_key(&trace_id)) {
            let _ = baseline_sender.send(Err(format!(
                "presentation trace가 이미 열려 있습니다: {trace_id}"
            )));
            return;
        }
        let anchor_ptr = match layer::presentation_trace_anchor(&window, &owners) {
            Ok(ptr) => ptr,
            Err(error) => {
                let _ = baseline_sender.send(Err(error));
                return;
            }
        };
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = baseline_sender.send(Err(
                "presentation trace는 main thread에서만 설치합니다".into()
            ));
            return;
        };
        let armed_at_unix_ms = unix_ms();
        let unix_from_media_ms = armed_at_unix_ms - CACurrentMediaTime() * 1000.0;
        let source_generation = NEXT_SOURCE_GENERATION
            .fetch_add(1, Ordering::Relaxed)
            .max(1);
        let target =
            mtm.alloc::<PresentationTraceTarget>()
                .set_ivars(PresentationTraceTargetIvars {
                    state: RefCell::new(TraceState {
                        trace_id: trace_id.clone(),
                        owners,
                        armed_at_unix_ms,
                        unix_from_media_ms,
                        source_generation,
                        next_revision: 1,
                        max_events,
                        events: Vec::with_capacity(max_events.min(512)),
                        baseline_sender: Some(baseline_sender),
                        baseline_identity: None,
                        violations: PresentationViolations::default(),
                    }),
                });
        let target: Retained<PresentationTraceTarget> = unsafe { msg_send![super(target), init] };
        let anchor = unsafe { &*(anchor_ptr as *const objc2_app_kit::NSView) };
        let link =
            unsafe { anchor.displayLinkWithTarget_selector(&target, sel!(recordPresentation:)) };
        unsafe {
            link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes);
        }
        ACTIVE_TRACES.with(|traces| {
            traces.borrow_mut().insert(
                trace_id,
                TraceEntry {
                    window,
                    _target: target,
                    link,
                },
            );
        });
    }

    fn remove_on_main(trace_id: &str) -> Result<CloseReceipt, String> {
        let entry = ACTIVE_TRACES
            .with(|traces| traces.borrow_mut().remove(trace_id))
            .ok_or_else(|| format!("presentation trace가 없습니다: {trace_id}"))?;
        entry.link.invalidate();
        let state: RefMut<'_, TraceState> = entry._target.ivars().state.borrow_mut();
        if state.events.is_empty() {
            return Err(format!(
                "presentation trace에 표시 프레임이 없습니다: {trace_id}"
            ));
        }
        Ok(state.close_receipt())
    }

    async fn remove_via_main_thread(
        app: &tauri::AppHandle,
        trace_id: String,
    ) -> Result<CloseReceipt, String> {
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(remove_on_main(&trace_id));
        })
        .map_err(|error| error.to_string())?;
        tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver)
            .await
            .map_err(|_| "presentation trace close main-thread 시간 초과".to_string())?
            .map_err(|_| "presentation trace close 응답 통로가 닫혔습니다".to_string())?
    }

    pub(crate) async fn arm(
        app: tauri::AppHandle,
        window: String,
        trace_id: String,
        owners: Vec<PresentationTraceOwner>,
        max_events: Option<usize>,
    ) -> Result<serde_json::Value, String> {
        if trace_id.trim().is_empty() {
            return Err("presentation traceId가 비었습니다".into());
        }
        let owners = validated_owners(owners)?;
        let max_events = max_events.unwrap_or(DEFAULT_MAX_EVENTS);
        if !(MIN_MAX_EVENTS..=MAX_MAX_EVENTS).contains(&max_events) {
            return Err(format!(
                "presentation trace maxEvents 범위는 {MIN_MAX_EVENTS}..={MAX_MAX_EVENTS}입니다"
            ));
        }

        let (baseline_sender, baseline_receiver) = oneshot::channel();
        let cleanup_trace_id = trace_id.clone();
        app.run_on_main_thread(move || {
            install_on_main(window, trace_id, owners, max_events, baseline_sender);
        })
        .map_err(|error| error.to_string())?;

        match tokio::time::timeout(FIRST_DISPLAY_TIMEOUT, baseline_receiver).await {
            Ok(Ok(Ok(receipt))) => serde_json::to_value(receipt).map_err(|error| error.to_string()),
            Ok(Ok(Err(error))) => {
                let _ = remove_via_main_thread(&app, cleanup_trace_id).await;
                Err(error)
            }
            Ok(Err(_)) => {
                let _ = remove_via_main_thread(&app, cleanup_trace_id).await;
                Err("presentation trace baseline 응답 통로가 닫혔습니다".into())
            }
            Err(_) => {
                let _ = remove_via_main_thread(&app, cleanup_trace_id).await;
                Err("보이는 pane에서 display-link baseline을 받지 못했습니다".into())
            }
        }
    }

    pub(crate) async fn close(
        app: tauri::AppHandle,
        trace_id: String,
    ) -> Result<serde_json::Value, String> {
        let receipt = remove_via_main_thread(&app, trace_id).await?;
        serde_json::to_value(receipt).map_err(|error| error.to_string())
    }

    pub(crate) fn forget_window(window: &str) {
        ACTIVE_TRACES.with(|traces| {
            let mut traces = traces.borrow_mut();
            let ids = traces
                .iter()
                .filter(|(_, entry)| entry.window == window)
                .map(|(trace_id, _)| trace_id.clone())
                .collect::<Vec<_>>();
            for trace_id in ids {
                if let Some(entry) = traces.remove(&trace_id) {
                    entry.link.invalidate();
                }
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::{validated_owners, PresentationTraceOwner};

        #[test]
        fn owner_inventory_is_explicit_unique_and_deterministic() {
            let owners = validated_owners(vec![
                PresentationTraceOwner {
                    view_id: "right".into(),
                    native_host_id: "pane-b".into(),
                    surface_id: "surface-b".into(),
                },
                PresentationTraceOwner {
                    view_id: "left".into(),
                    native_host_id: "pane-a".into(),
                    surface_id: "surface-a".into(),
                },
            ])
            .expect("valid inventory");
            assert_eq!(owners[0].view_id, "left");
            assert_eq!(owners[1].view_id, "right");
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) use macos::{arm, close, forget_window};

#[cfg(not(target_os = "macos"))]
pub(super) async fn arm(
    _app: tauri::AppHandle,
    _window: String,
    _trace_id: String,
    _owners: Vec<PresentationTraceOwner>,
    _max_events: Option<usize>,
) -> Result<serde_json::Value, String> {
    Err("native pane presentation trace는 macOS Tauri adapter 기능입니다".into())
}

#[cfg(not(target_os = "macos"))]
pub(super) async fn close(
    _app: tauri::AppHandle,
    _trace_id: String,
) -> Result<serde_json::Value, String> {
    Err("native pane presentation trace는 macOS Tauri adapter 기능입니다".into())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn forget_window(_window: &str) {}
