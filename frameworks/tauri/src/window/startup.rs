//! Pure startup-presentation gate for native windows.
//!
//! A creator registers a window before building it with `visible = false`. Creation and a
//! renderer-provided GREEN composition receipt are recorded independently. The caller may take a
//! presentation decision only after both facts exist. On macOS, the receipt must match a non-zero
//! native sequence both when it is accepted and at the presentation boundary.

use std::{collections::HashMap, fmt, num::NonZeroU64};

/// Monotonic identity for one native-window lifetime.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct WindowGeneration(NonZeroU64);

impl WindowGeneration {
    pub fn new(value: u64) -> Option<Self> {
        NonZeroU64::new(value).map(Self)
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// A label is reusable only after its previous generation has been forgotten.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WindowIdentity {
    pub label: String,
    pub generation: WindowGeneration,
}

impl WindowIdentity {
    pub fn new(label: impl Into<String>, generation: WindowGeneration) -> Self {
        Self {
            label: label.into(),
            generation,
        }
    }
}

/// Composition contract used by this window lifetime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowPlatform {
    MacOs,
    Other,
}

impl WindowPlatform {
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::MacOs
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::Other
        }
    }
}

/// Renderer assertion supplied at the GREEN composition boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RendererGreenReceipt {
    MacOs {
        sequence: u64,
        current_native_sequence: u64,
    },
    Other,
}

impl RendererGreenReceipt {
    const fn platform(self) -> WindowPlatform {
        match self {
            Self::MacOs { .. } => WindowPlatform::MacOs,
            Self::Other => WindowPlatform::Other,
        }
    }
}

/// Fresh native state read immediately before acting on a presentation decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CurrentNativeSequence {
    MacOs(u64),
    NotApplicable,
}

impl CurrentNativeSequence {
    const fn platform(self) -> WindowPlatform {
        match self {
            Self::MacOs(_) => WindowPlatform::MacOs,
            Self::NotApplicable => WindowPlatform::Other,
        }
    }
}

/// Validated composition proof retained by the gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompositionProof {
    MacOs { sequence: NonZeroU64 },
    Other,
}

/// The only outcome that authorizes the platform adapter to reveal a window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresentationDecision {
    pub identity: WindowIdentity,
    pub requested_focus: bool,
    pub composition: CompositionProof,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PresentationOutcome {
    Pending,
    SuppressedHeadless,
    Present(PresentationDecision),
    AlreadyPresented,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupStatus {
    pub identity: WindowIdentity,
    pub platform: WindowPlatform,
    pub requested_focus: bool,
    pub headless: bool,
    pub creation_committed: bool,
    pub renderer_green: bool,
    pub composition: Option<CompositionProof>,
    pub presentation_in_flight: bool,
    pub presented: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartupGateError {
    EmptyLabel,
    GenerationExhausted,
    LabelAlreadyRegistered {
        label: String,
        generation: WindowGeneration,
    },
    UnknownWindow {
        label: String,
        generation: WindowGeneration,
    },
    GenerationMismatch {
        label: String,
        expected: WindowGeneration,
        actual: WindowGeneration,
    },
    ReceiptPlatformMismatch {
        expected: WindowPlatform,
        actual: WindowPlatform,
    },
    DecisionPlatformMismatch {
        expected: WindowPlatform,
        actual: WindowPlatform,
    },
    ZeroNativeSequence {
        receipt_sequence: u64,
        current_native_sequence: u64,
    },
    NativeSequenceMismatch {
        receipt_sequence: u64,
        current_native_sequence: u64,
    },
    PresentationNotInFlight {
        label: String,
        generation: WindowGeneration,
    },
}

impl fmt::Display for StartupGateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyLabel => formatter.write_str("startup window label must not be empty"),
            Self::GenerationExhausted => {
                formatter.write_str("startup window generation space is exhausted")
            }
            Self::LabelAlreadyRegistered { label, generation } => write!(
                formatter,
                "startup window is already registered: {label}@{}",
                generation.get()
            ),
            Self::UnknownWindow { label, generation } => write!(
                formatter,
                "startup window is not registered: {label}@{}",
                generation.get()
            ),
            Self::GenerationMismatch {
                label,
                expected,
                actual,
            } => write!(
                formatter,
                "startup window generation mismatch for {label}: expected {}, got {}",
                expected.get(),
                actual.get()
            ),
            Self::ReceiptPlatformMismatch { expected, actual } => write!(
                formatter,
                "renderer receipt platform mismatch: expected {expected:?}, got {actual:?}"
            ),
            Self::DecisionPlatformMismatch { expected, actual } => write!(
                formatter,
                "presentation sequence platform mismatch: expected {expected:?}, got {actual:?}"
            ),
            Self::ZeroNativeSequence {
                receipt_sequence,
                current_native_sequence,
            } => write!(
                formatter,
                "macOS startup sequence must be non-zero: receipt={receipt_sequence}, current={current_native_sequence}"
            ),
            Self::NativeSequenceMismatch {
                receipt_sequence,
                current_native_sequence,
            } => write!(
                formatter,
                "macOS startup sequence is not current: receipt={receipt_sequence}, current={current_native_sequence}"
            ),
            Self::PresentationNotInFlight { label, generation } => write!(
                formatter,
                "startup presentation was not authorized: {label}@{}",
                generation.get()
            ),
        }
    }
}

impl std::error::Error for StartupGateError {}

#[derive(Debug)]
struct WindowStartup {
    identity: WindowIdentity,
    platform: WindowPlatform,
    requested_focus: bool,
    headless: bool,
    creation_committed: bool,
    composition: Option<CompositionProof>,
    presentation_in_flight: bool,
    presented: bool,
}

/// Label-keyed ledger. Wrap this value in the framework's chosen synchronization primitive.
#[derive(Debug, Default)]
pub struct StartupGate {
    next_generation: u64,
    windows: HashMap<String, WindowStartup>,
}

impl StartupGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a native-window lifetime before its externally-owned builder creates it hidden.
    ///
    /// This state machine never emits a presentation decision from registration alone. The window
    /// adapter remains responsible for setting `visible = false` at native creation.
    pub fn begin_hidden(
        &mut self,
        label: impl Into<String>,
        platform: WindowPlatform,
        requested_focus: bool,
        headless: bool,
    ) -> Result<WindowIdentity, StartupGateError> {
        let label = label.into();
        if label.is_empty() {
            return Err(StartupGateError::EmptyLabel);
        }
        if let Some(active) = self.windows.get(&label) {
            return Err(StartupGateError::LabelAlreadyRegistered {
                label,
                generation: active.identity.generation,
            });
        }
        let raw_generation = self
            .next_generation
            .checked_add(1)
            .ok_or(StartupGateError::GenerationExhausted)?;
        let generation =
            WindowGeneration::new(raw_generation).ok_or(StartupGateError::GenerationExhausted)?;
        self.next_generation = raw_generation;
        let identity = WindowIdentity::new(label.clone(), generation);
        self.windows.insert(
            label,
            WindowStartup {
                identity: identity.clone(),
                platform,
                requested_focus,
                headless,
                creation_committed: false,
                composition: None,
                presentation_in_flight: false,
                presented: false,
            },
        );
        Ok(identity)
    }

    pub fn active_identity(&self, label: &str) -> Option<WindowIdentity> {
        self.windows.get(label).map(|entry| entry.identity.clone())
    }

    /// Record completion of native installation, address settlement, and final startup geometry.
    pub fn commit_creation(&mut self, identity: &WindowIdentity) -> Result<(), StartupGateError> {
        self.entry_mut(identity)?.creation_committed = true;
        Ok(())
    }

    /// Record a GREEN renderer receipt.
    ///
    /// macOS receipts are accepted only when their sequence is non-zero and exactly matches the
    /// native sequence read for the same transaction. A later presentation decision repeats the
    /// equality check against a fresh native read.
    pub fn accept_renderer_green(
        &mut self,
        identity: &WindowIdentity,
        receipt: RendererGreenReceipt,
    ) -> Result<(), StartupGateError> {
        let entry = self.entry(identity)?;
        let actual_platform = receipt.platform();
        if entry.platform != actual_platform {
            return Err(StartupGateError::ReceiptPlatformMismatch {
                expected: entry.platform,
                actual: actual_platform,
            });
        }
        let proof = match receipt {
            RendererGreenReceipt::MacOs {
                sequence,
                current_native_sequence,
            } => {
                let sequence = validate_macos_sequence(sequence, current_native_sequence)?;
                CompositionProof::MacOs { sequence }
            }
            RendererGreenReceipt::Other => CompositionProof::Other,
        };
        let entry = self.entry_mut(identity)?;
        if !entry.presented && !entry.presentation_in_flight {
            entry.composition = Some(proof);
        }
        Ok(())
    }

    /// Return a one-shot authorization to reveal the window.
    ///
    /// The caller must perform any platform presentation synchronously from `Present`. Pending,
    /// suppressed, rejected, and repeated outcomes never authorize visibility.
    pub fn take_present_decision(
        &mut self,
        identity: &WindowIdentity,
        current_native_sequence: CurrentNativeSequence,
    ) -> Result<PresentationOutcome, StartupGateError> {
        let entry = self.entry(identity)?;
        if entry.presented {
            return Ok(PresentationOutcome::AlreadyPresented);
        }
        if entry.presentation_in_flight {
            return Ok(PresentationOutcome::Pending);
        }
        let Some(composition) = entry.composition else {
            return Ok(PresentationOutcome::Pending);
        };
        if !entry.creation_committed {
            return Ok(PresentationOutcome::Pending);
        }
        if entry.headless {
            return Ok(PresentationOutcome::SuppressedHeadless);
        }
        let actual_platform = current_native_sequence.platform();
        if entry.platform != actual_platform {
            return Err(StartupGateError::DecisionPlatformMismatch {
                expected: entry.platform,
                actual: actual_platform,
            });
        }
        match (composition, current_native_sequence) {
            (CompositionProof::MacOs { sequence }, CurrentNativeSequence::MacOs(current)) => {
                validate_macos_sequence(sequence.get(), current)?;
            }
            (CompositionProof::Other, CurrentNativeSequence::NotApplicable) => {}
            // Platform equality above makes these combinations unreachable.
            _ => unreachable!("composition proof and registered platform diverged"),
        }

        let entry = self.entry_mut(identity)?;
        entry.presentation_in_flight = true;
        Ok(PresentationOutcome::Present(PresentationDecision {
            identity: entry.identity.clone(),
            requested_focus: entry.requested_focus,
            composition,
        }))
    }

    /// Commit the externally-owned native presentation only after the platform action and its
    /// final layout/display transaction have completed. Authorization alone is not visibility.
    pub fn commit_presentation(
        &mut self,
        identity: &WindowIdentity,
    ) -> Result<(), StartupGateError> {
        let entry = self.entry_mut(identity)?;
        if !entry.presentation_in_flight {
            return Err(StartupGateError::PresentationNotInFlight {
                label: identity.label.clone(),
                generation: identity.generation,
            });
        }
        entry.presentation_in_flight = false;
        entry.presented = true;
        Ok(())
    }

    /// Release an authorization whose native action failed. The same still-current GREEN receipt
    /// may then be retried; no visible fact is fabricated.
    pub fn abort_presentation(
        &mut self,
        identity: &WindowIdentity,
    ) -> Result<bool, StartupGateError> {
        let entry = self.entry_mut(identity)?;
        let was_in_flight = entry.presentation_in_flight;
        entry.presentation_in_flight = false;
        Ok(was_in_flight)
    }

    pub fn status(&self, identity: &WindowIdentity) -> Result<StartupStatus, StartupGateError> {
        let entry = self.entry(identity)?;
        Ok(StartupStatus {
            identity: entry.identity.clone(),
            platform: entry.platform,
            requested_focus: entry.requested_focus,
            headless: entry.headless,
            creation_committed: entry.creation_committed,
            renderer_green: entry.composition.is_some(),
            composition: entry.composition,
            presentation_in_flight: entry.presentation_in_flight,
            presented: entry.presented,
        })
    }

    /// Forget one exact native-window lifetime.
    ///
    /// Repeating a forget after removal is a successful no-op. A stale generation cannot remove a
    /// newly-created window that reused the same label.
    pub fn forget(&mut self, identity: &WindowIdentity) -> Result<bool, StartupGateError> {
        let Some(entry) = self.windows.get(&identity.label) else {
            return Ok(false);
        };
        if entry.identity.generation != identity.generation {
            return Err(StartupGateError::GenerationMismatch {
                label: identity.label.clone(),
                expected: entry.identity.generation,
                actual: identity.generation,
            });
        }
        self.windows.remove(&identity.label);
        Ok(true)
    }

    fn entry(&self, identity: &WindowIdentity) -> Result<&WindowStartup, StartupGateError> {
        let Some(entry) = self.windows.get(&identity.label) else {
            return Err(StartupGateError::UnknownWindow {
                label: identity.label.clone(),
                generation: identity.generation,
            });
        };
        if entry.identity.generation != identity.generation {
            return Err(StartupGateError::GenerationMismatch {
                label: identity.label.clone(),
                expected: entry.identity.generation,
                actual: identity.generation,
            });
        }
        Ok(entry)
    }

    fn entry_mut(
        &mut self,
        identity: &WindowIdentity,
    ) -> Result<&mut WindowStartup, StartupGateError> {
        let Some(entry) = self.windows.get_mut(&identity.label) else {
            return Err(StartupGateError::UnknownWindow {
                label: identity.label.clone(),
                generation: identity.generation,
            });
        };
        if entry.identity.generation != identity.generation {
            return Err(StartupGateError::GenerationMismatch {
                label: identity.label.clone(),
                expected: entry.identity.generation,
                actual: identity.generation,
            });
        }
        Ok(entry)
    }
}

fn validate_macos_sequence(
    receipt_sequence: u64,
    current_native_sequence: u64,
) -> Result<NonZeroU64, StartupGateError> {
    let Some(sequence) = NonZeroU64::new(receipt_sequence) else {
        return Err(StartupGateError::ZeroNativeSequence {
            receipt_sequence,
            current_native_sequence,
        });
    };
    if current_native_sequence == 0 {
        return Err(StartupGateError::ZeroNativeSequence {
            receipt_sequence,
            current_native_sequence,
        });
    }
    if receipt_sequence != current_native_sequence {
        return Err(StartupGateError::NativeSequenceMismatch {
            receipt_sequence,
            current_native_sequence,
        });
    }
    Ok(sequence)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mac_receipt(sequence: u64) -> RendererGreenReceipt {
        RendererGreenReceipt::MacOs {
            sequence,
            current_native_sequence: sequence,
        }
    }

    fn begin_mac(
        gate: &mut StartupGate,
        label: &str,
        requested_focus: bool,
        headless: bool,
    ) -> WindowIdentity {
        gate.begin_hidden(label, WindowPlatform::MacOs, requested_focus, headless)
            .expect("hidden registration")
    }

    #[test]
    fn hidden_registration_alone_never_authorizes_presentation() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);

        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(1)),
            Ok(PresentationOutcome::Pending)
        );
        assert_eq!(
            gate.status(&identity).expect("status"),
            StartupStatus {
                identity,
                platform: WindowPlatform::MacOs,
                requested_focus: true,
                headless: false,
                creation_committed: false,
                renderer_green: false,
                composition: None,
                presentation_in_flight: false,
                presented: false,
            }
        );
    }

    #[test]
    fn creation_then_green_presents_once_and_retains_focus_intent() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);

        gate.commit_creation(&identity).expect("creation commit");
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(7)),
            Ok(PresentationOutcome::Pending)
        );
        gate.accept_renderer_green(&identity, mac_receipt(7))
            .expect("green receipt");
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(7)),
            Ok(PresentationOutcome::Present(PresentationDecision {
                identity: identity.clone(),
                requested_focus: true,
                composition: CompositionProof::MacOs {
                    sequence: NonZeroU64::new(7).unwrap(),
                },
            }))
        );
        assert!(
            !gate.status(&identity).expect("status before native commit").presented,
            "authorizing a platform action must not claim that the native window is visible"
        );
        gate.commit_presentation(&identity)
            .expect("native presentation commit");
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::NotApplicable),
            Ok(PresentationOutcome::AlreadyPresented)
        );
    }

    #[test]
    fn failed_platform_action_can_abort_and_retry_the_same_green_receipt() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);
        gate.commit_creation(&identity).unwrap();
        gate.accept_renderer_green(&identity, mac_receipt(7)).unwrap();

        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(7)),
            Ok(PresentationOutcome::Present(_))
        ));
        gate.abort_presentation(&identity)
            .expect("failed native action rollback");
        assert!(!gate.status(&identity).unwrap().presented);
        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(7)),
            Ok(PresentationOutcome::Present(_))
        ));
        gate.commit_presentation(&identity).unwrap();
        assert!(gate.status(&identity).unwrap().presented);
    }

    #[test]
    fn green_then_creation_presents_once_without_focus() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "w-restored", false, false);

        gate.accept_renderer_green(&identity, mac_receipt(11))
            .expect("green receipt");
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(11)),
            Ok(PresentationOutcome::Pending)
        );
        gate.commit_creation(&identity).expect("creation commit");
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(11)),
            Ok(PresentationOutcome::Present(PresentationDecision {
                identity: identity.clone(),
                requested_focus: false,
                composition: CompositionProof::MacOs {
                    sequence: NonZeroU64::new(11).unwrap(),
                },
            }))
        );
        gate.commit_presentation(&identity).unwrap();
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(99)),
            Ok(PresentationOutcome::AlreadyPresented)
        );
    }

    #[test]
    fn repeated_facts_cannot_produce_a_second_present_decision() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "w-repeat", false, false);
        gate.commit_creation(&identity).unwrap();
        gate.accept_renderer_green(&identity, mac_receipt(3))
            .unwrap();
        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(3)),
            Ok(PresentationOutcome::Present(_))
        ));
        gate.commit_presentation(&identity).unwrap();

        gate.commit_creation(&identity).unwrap();
        gate.accept_renderer_green(&identity, mac_receipt(4))
            .unwrap();
        assert_eq!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(4)),
            Ok(PresentationOutcome::AlreadyPresented)
        );
        assert_eq!(
            gate.status(&identity).unwrap().composition,
            Some(CompositionProof::MacOs {
                sequence: NonZeroU64::new(3).unwrap(),
            })
        );
    }

    #[test]
    fn headless_window_never_presents_in_either_fact_order() {
        for receipt_first in [false, true] {
            let mut gate = StartupGate::new();
            let identity = begin_mac(&mut gate, "main", true, true);
            if receipt_first {
                gate.accept_renderer_green(&identity, mac_receipt(5))
                    .unwrap();
                gate.commit_creation(&identity).unwrap();
            } else {
                gate.commit_creation(&identity).unwrap();
                gate.accept_renderer_green(&identity, mac_receipt(5))
                    .unwrap();
            }
            assert_eq!(
                gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(5)),
                Ok(PresentationOutcome::SuppressedHeadless)
            );
            assert!(!gate.status(&identity).unwrap().presented);
        }
    }

    #[test]
    fn macos_receipt_requires_an_exact_current_nonzero_sequence() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);

        for receipt in [
            RendererGreenReceipt::MacOs {
                sequence: 0,
                current_native_sequence: 1,
            },
            RendererGreenReceipt::MacOs {
                sequence: 1,
                current_native_sequence: 0,
            },
        ] {
            assert!(matches!(
                gate.accept_renderer_green(&identity, receipt),
                Err(StartupGateError::ZeroNativeSequence { .. })
            ));
        }
        for receipt in [
            RendererGreenReceipt::MacOs {
                sequence: 4,
                current_native_sequence: 5,
            },
            RendererGreenReceipt::MacOs {
                sequence: 6,
                current_native_sequence: 5,
            },
        ] {
            assert!(matches!(
                gate.accept_renderer_green(&identity, receipt),
                Err(StartupGateError::NativeSequenceMismatch { .. })
            ));
        }
        assert!(!gate.status(&identity).unwrap().renderer_green);
    }

    #[test]
    fn presentation_revalidates_the_current_macos_sequence() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);
        gate.commit_creation(&identity).unwrap();
        gate.accept_renderer_green(&identity, mac_receipt(8))
            .unwrap();

        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(0)),
            Err(StartupGateError::ZeroNativeSequence { .. })
        ));
        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(9)),
            Err(StartupGateError::NativeSequenceMismatch {
                receipt_sequence: 8,
                current_native_sequence: 9,
            })
        ));
        assert!(!gate.status(&identity).unwrap().presented);

        gate.accept_renderer_green(&identity, mac_receipt(9))
            .unwrap();
        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(9)),
            Ok(PresentationOutcome::Present(_))
        ));
    }

    #[test]
    fn platform_mismatches_are_rejected() {
        let mut gate = StartupGate::new();
        let mac = begin_mac(&mut gate, "main", true, false);
        assert_eq!(
            gate.accept_renderer_green(&mac, RendererGreenReceipt::Other),
            Err(StartupGateError::ReceiptPlatformMismatch {
                expected: WindowPlatform::MacOs,
                actual: WindowPlatform::Other,
            })
        );

        let other = gate
            .begin_hidden("w-other", WindowPlatform::Other, false, false)
            .unwrap();
        gate.commit_creation(&other).unwrap();
        gate.accept_renderer_green(&other, RendererGreenReceipt::Other)
            .unwrap();
        assert_eq!(
            gate.take_present_decision(&other, CurrentNativeSequence::MacOs(1)),
            Err(StartupGateError::DecisionPlatformMismatch {
                expected: WindowPlatform::Other,
                actual: WindowPlatform::MacOs,
            })
        );
    }

    #[test]
    fn non_macos_green_and_creation_are_independent_prerequisites() {
        for receipt_first in [false, true] {
            let mut gate = StartupGate::new();
            let identity = gate
                .begin_hidden("w-other", WindowPlatform::Other, false, false)
                .unwrap();
            if receipt_first {
                gate.accept_renderer_green(&identity, RendererGreenReceipt::Other)
                    .unwrap();
                assert_eq!(
                    gate.take_present_decision(&identity, CurrentNativeSequence::NotApplicable),
                    Ok(PresentationOutcome::Pending)
                );
                gate.commit_creation(&identity).unwrap();
            } else {
                gate.commit_creation(&identity).unwrap();
                assert_eq!(
                    gate.take_present_decision(&identity, CurrentNativeSequence::NotApplicable),
                    Ok(PresentationOutcome::Pending)
                );
                gate.accept_renderer_green(&identity, RendererGreenReceipt::Other)
                    .unwrap();
            }
            assert_eq!(
                gate.take_present_decision(&identity, CurrentNativeSequence::NotApplicable),
                Ok(PresentationOutcome::Present(PresentationDecision {
                    identity,
                    requested_focus: false,
                    composition: CompositionProof::Other,
                }))
            );
        }
    }

    #[test]
    fn wrong_generation_is_rejected_by_every_state_transition() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);
        let wrong = WindowIdentity::new(
            identity.label.clone(),
            WindowGeneration::new(identity.generation.get() + 1).unwrap(),
        );

        assert!(matches!(
            gate.commit_creation(&wrong),
            Err(StartupGateError::GenerationMismatch { .. })
        ));
        assert!(matches!(
            gate.accept_renderer_green(&wrong, mac_receipt(1)),
            Err(StartupGateError::GenerationMismatch { .. })
        ));
        assert!(matches!(
            gate.take_present_decision(&wrong, CurrentNativeSequence::MacOs(1)),
            Err(StartupGateError::GenerationMismatch { .. })
        ));
        assert!(matches!(
            gate.status(&wrong),
            Err(StartupGateError::GenerationMismatch { .. })
        ));
        assert!(matches!(
            gate.forget(&wrong),
            Err(StartupGateError::GenerationMismatch { .. })
        ));
        assert_eq!(gate.active_identity("main"), Some(identity));
    }

    #[test]
    fn unknown_lifetime_is_rejected_but_forget_is_idempotent() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);
        assert_eq!(gate.forget(&identity), Ok(true));
        assert_eq!(gate.forget(&identity), Ok(false));
        assert!(matches!(
            gate.commit_creation(&identity),
            Err(StartupGateError::UnknownWindow { .. })
        ));
        assert!(matches!(
            gate.accept_renderer_green(&identity, mac_receipt(1)),
            Err(StartupGateError::UnknownWindow { .. })
        ));
        assert!(matches!(
            gate.take_present_decision(&identity, CurrentNativeSequence::MacOs(1)),
            Err(StartupGateError::UnknownWindow { .. })
        ));
    }

    #[test]
    fn recreated_label_gets_a_new_generation_and_stale_forget_cannot_remove_it() {
        let mut gate = StartupGate::new();
        let old = begin_mac(&mut gate, "main", true, false);
        assert_eq!(gate.forget(&old), Ok(true));
        let recreated = begin_mac(&mut gate, "main", false, false);

        assert!(recreated.generation > old.generation);
        assert!(matches!(
            gate.forget(&old),
            Err(StartupGateError::GenerationMismatch {
                expected,
                actual,
                ..
            }) if expected == recreated.generation && actual == old.generation
        ));
        assert_eq!(gate.active_identity("main"), Some(recreated));
    }

    #[test]
    fn active_label_cannot_be_registered_twice() {
        let mut gate = StartupGate::new();
        let identity = begin_mac(&mut gate, "main", true, false);
        assert_eq!(
            gate.begin_hidden("main", WindowPlatform::MacOs, false, false),
            Err(StartupGateError::LabelAlreadyRegistered {
                label: "main".to_string(),
                generation: identity.generation,
            })
        );
    }

    #[test]
    fn labels_and_generation_space_are_validated() {
        let mut gate = StartupGate::new();
        assert_eq!(
            gate.begin_hidden("", WindowPlatform::MacOs, true, false),
            Err(StartupGateError::EmptyLabel)
        );
        gate.next_generation = u64::MAX;
        assert_eq!(
            gate.begin_hidden("main", WindowPlatform::MacOs, true, false),
            Err(StartupGateError::GenerationExhausted)
        );
    }

    #[test]
    fn independent_windows_cannot_satisfy_each_others_prerequisites() {
        let mut gate = StartupGate::new();
        let main = begin_mac(&mut gate, "main", true, false);
        let workspace = begin_mac(&mut gate, "w-1", false, false);
        gate.commit_creation(&main).unwrap();
        gate.accept_renderer_green(&workspace, mac_receipt(12))
            .unwrap();

        assert_eq!(
            gate.take_present_decision(&main, CurrentNativeSequence::MacOs(12)),
            Ok(PresentationOutcome::Pending)
        );
        assert_eq!(
            gate.take_present_decision(&workspace, CurrentNativeSequence::MacOs(12)),
            Ok(PresentationOutcome::Pending)
        );
    }
}
