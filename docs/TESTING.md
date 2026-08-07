# Testing

Two standard targets across every repo — core, plugins, sidecars. A repo exposes them as
`make test-unit` / `make test-e2e` (Makefile) or the same-named `npm` scripts.

## The two targets

- **`test-unit`** — deterministic, no LLM, no running app. Pure logic and type checks that
  a machine can settle offline. Core: `spec-gate` (plugin-spec/plugin-api build + headless
  manifest gate), `typecheck` (tsc), `check` (cargo check), `test` (cargo test), `test-front`
  (vitest). A plugin: its vitest/cargo suite. This is the pre-commit gate; it must be green
  before every commit.
- **`test-e2e`** — drives a running app over its socket. Idempotent and self-cleaning:
  each harness creates its own windows/projects, asserts, and tears them down, never touching
  the user's workspace. Takes an identity (`IDENTITY=debug` by default). Core suite:
  orchestrator, project-rail, nl-console, browser-restore, multiwindow, resize.

## Harness methodology

- **Idempotent scenario files, not throwaway scripts.** A harness reruns cleanly: it cleans
  its leftovers on entry, works only inside its own fixtures, and removes what it made. Never
  write a one-shot script for something a reusable harness should own.
- **Fixture roots live under `~/.soksak-e2e`**, reused idempotently — separate from the app
  homes (`~/.soksak`, `~/.soksak-dev`, `~/.soksak-debug`). State is reclaimed through the
  window lifecycle (teardown closes the window), not by minting a fresh temp dir each run.
- **Introspect, don't skip.** When a check "can't be tested," add the introspection command
  that exposes the fact (a status query, a measurement) rather than skipping. "No mechanism"
  is not an excuse — extend the surface.
- **Separate deterministic assertions from LLM-dependent steps.** Deterministic checks assert
  exact outcomes; steps that call an LLM (agent turns) retry with tolerance, never gate on a
  specific model output.
- **Measure the real signal.** Read the actual runtime fact (`term.read` for terminal output,
  `stty size` for the live winsize, public presentation state and event traces for render) —
  not a static/inferred value or an automated verdict from image pixels.

## Canonical browser acceptance: B01–B12

`browser`, `browser-chromium`, and `browser-chromium-offscreen` pass every applicable rule with
the same fixture and assertions. Framework-specific state may explain a failure; it never waives
or weakens an applicable rule. The code source of truth is `scripts/e2e/lib/browser-gates.mjs`, and
every report contains the full 3-engine × 12-gate matrix of 36 cells. A rule may be
`not-applicable` only when the catalog derives that state from the report's framework/platform
identity; a runtime, adapter, or test cannot claim it for itself.

`slot-freeze.mjs` records each owned B01–B11 gate exactly once per engine run in the canonical
judge; B12 belongs to the separate cold-start titlebar runner. The address-bar value is read through
the discovered public address and `ui.measure.value`. IME, wheel, and full-capture facts likewise
feed their event ledgers and explicit view/path receipts directly into mappers. If a public response
lacks a required field, the mapper preserves `null` and the gate remains RED; it never fills the gap
from requested values or PNG pixels.
The B03 mapper requires an independent owner ledger, exposed `compositionKind=slot|renderer`
nodes, and the surface receipt's shared `topologyPath`; it never derives one ledger from another.
The core owns the participant declaration shape (`lib/compositionParticipants`) and each framework
stamps its own participants. When `framework.provision` reports `nativeChildWebview=false`, the
surface receipt comes from the content view host's own live list (`contentViews` in
`webview.surfaces`); a slot node never stands in for a surface. The judge never asks which
framework it is.
The B05 mapper joins the click ACK address/time, the layout transaction's trace causality, actual
presentation events, settlement, and the finite hold receipt. It never estimates a missing time or
hold from recorded frames.
The B06 mapper independently requires each pane's public `--dim`/level, adapter alpha, the single
plane's base/aperture ledger, and both rail/sidebar exemption and plane-exclusion facts. One exempt
attribute cannot stand in for the other observations.
The B10 mapper closes only the baseline and each resize ACK's observed window/frame/generation/
presentation/continuity snapshot into transactions. It never copies a requested `size` into the
observed window geometry.

| ID | Fixed rule | Machine evidence |
|---|---|---|
| B01 | Initial mount + address bar + page identity in all three engines | Each tab performs at least two real navigations — a per-view unique document, then the canonical fixture. Every navigation reads the public address bar value, `document.title`, and body text, and all three equal that navigation's requested values. A page identity that repeats across views is rejected: only the view we asked can answer its own document. A navigation that fails, or an address bar that is not exposed, is carried as a named observation failure instead of ending the run. |
| B02 | Korean IME `beforeinput`/`input`, with value retention across transitions and resize | Read both input events and the final value, then assert the same value at every transition and resize checkpoint. |
| B03 | DOM slot ↔ live surface 1:1, rounding-only frame, shared topology | Assert count, ownership, and coordinate deltas from public DOM rects, native/engine rects, and the identity ledger. On Tauri, a content slot becomes a native hole only through an adapter lifecycle claim (`direct`/`pane`) or the neutral `data-external-surface=<stable identity>` declaration. Undeclared DOM slots are never guessed to be holes. `direct`, `PaneSurfaceHost`, and external-provider geometry are each audited exactly once by their owning plane. Electron does not project this declaration because its browser body remains a DOM child. For an in-document surface the participants are the declared slot and the tag inside it, and the third ledger is the content view host's live list. |
| B04 | One atomic FLOW move for rail, pane, and native surface | An acknowledged finite trace joins the initial raw rect and the exact same-transaction DOM-commit raw rect to actual presentation events, then asserts connectivity, coordinates, and settlement for all three. |
| B05 | Zero flicker, black frames, ghosts, or post-landing disappearance | The public presentation trace asserts continuous live/visible/painted state and zero replacements, gaps, or disappearances. |
| B06 | Only active is bright; inactive is dim; rail/sidebar are not dimmed | Public style state asserts one lighting plane and its active aperture, pane dim values, rail/sidebar exclusion from the plane, and adapter alpha 1 (no duplicate dimming). |
| B07 | PIN left-adjacent, right-adjacent, and detached border/layout invariance | Assert border relations and invariant rail/pane DOM identity, rects, and split tree across all three focus states. The drawn side is measured from the rail and pane boxes the relation node publishes, never read from the declared border mode. |
| B08 | PIN maximize/restore in both directions with invariant station | For left and right, assert exact direction, split, and station equality before maximize and after restore, plus the target view's native surface rect at baseline, maximize, and restore: maximize must grow it and restore must return it to the baseline within one rounding pixel. |
| B09 | Rail `+`, right sidebar, and modal above native surfaces | Public hit/layer state at a real overlap reports chrome as the topmost owner. |
| B10 | Hostile rapid whole-window resize is affine and restores | Every finite resize transaction asserts DOM/native coordinate agreement and restoration of the original final geometry. |
| B11 | Pane resize round trip + wheel `0→480→0` + tab-targeted full capture | Assert settlement for the explicit view, real scroll events, capture extent/document geometry, and restored scroll state. |
| B12 | macOS traffic-light center/composition agreement under cold start, hostile resize, and titlebar-height changes | A window may be presented only after restored logical size and saved zoom have received their native applied ACK, then the post-zoom public titlebar has composed GREEN. Tauri uses one AppKit main-thread transaction and one paint owner: the three derived backing regions, three live AppKit buttons, and three DOM reservations assert mapping, containment, vertical centers, and resize agreement. The startup gate flushes the AppKit display transaction and then takes a read-only actual-versus-declared geometry sample; an earlier `lastApplyOk` receipt cannot authorize presentation if the displayed button frames or owner hierarchy no longer hold. `trafficLightPosition` is forbidden in Tauri configuration while this dynamic composer is installed because it installs Tao's competing fixed-y draw owner and also feeds non-child Wry paths; the adapter preserves the initial AppKit horizontal spacing and derives vertical position only from the public DOM titlebar. Public async resize owns its `Window` through an awaited oneshot ACK; timeout-then-late mutation and queued bare `NSWindow` pointers are forbidden. `titlebar.height.set {height}` changes the public DOM geometry, waits for a complete paint boundary, and returns the same strict native receipt; `titlebar.height.reset` restores the exact prior inline height/flex basis. Every cold-start and height sample must have zero button/backing center delta (rounding-only tolerance). Electron must eventually assert the same contract from a public adapter backed by `BrowserWindow.getWindowButtonPosition`; until that adapter exists B12 is explicitly `blocked`, and DOM clones or synthesized native frames are forbidden substitutes. Non-macOS reports mark this gate statically `not-applicable`. |

### B04 exact DOM-commit ledger

Before the stimulus, B04 waits for the `ui.trace.multi.start` ACK, which proves that the initial raw
rects were read and the layout-journal subscription was installed. When React commits the target DOM
in its layout effect, the journal wrapper synchronously emits `transactionId` and
`domCommittedAtUnixMs` before awaiting the surface ACK. The subscriber reads the rail and both
pane/slot rect pairs in that same callback. The `ui.trace.multi.close` receipt must contain exactly
one initial sample and one DOM-commit sample for the judged transaction; missing, duplicate, or
foreign-transaction samples are RED. An actual presentation event before the commit epoch uses only
the initial rect, and an event at or after it uses only the commit rect. A nearest 16ms timer sample,
a wider time tolerance, interpolation, or movement projection is never composition authority. The
expiry timeout only reclaims the finite subscription; it does not poll coordinates.

Ordering two producers by their timestamps assumes one epoch, and the field name `...UnixMs` does not
prove one. Before any coordinate is compared, each producer's observation span must intersect the
window the layout journal declared for that transaction: `startAtUnixMs`..`startAtUnixMs + durationMs`
for a glide, `preparedAtUnixMs`..`closedAtUnixMs` for a snap. A producer that does not intersect it is
reported by its distance in milliseconds, never by a coordinate delta. Intersection is a fact, not a
tolerance; no minimum overlap is granted.

For Tauri pane surfaces, the owner inventory is also exact: `webview.pane.hosts` must yield one host
for the requested window, `viewId`, workspace `logicalPaneId`, and surface member. The trace is armed
with that fact's separate `nativeHostId`. A missing/duplicate join, a null logical identity, an
ambiguous `pane` field, or a host-label-derived logical id is RED.

This event represents a FLOW relocation, not initial mount. A cold application's first DOM/surface
composition has no layout transaction and remains independently covered by B01 mount and B03
one-to-one inventory/frame contracts.

### B05 actual presentation-event ledger

B05 arms a finite trace before the stimulus and accepts only events emitted by the actual
compositor/display callback. DOM or status samples, PNG/video, recorder frame numbers, and stats
queries cannot be synthesized into presentation events. Every event has a contiguous sequence,
stable surface identity/generation, increasing presentation revision/time, live/visible/painted
facts, and DOM-versus-surface frames within 1px. Fixed judge limits are 50ms to first presentation,
50ms between active events, 550ms from click to settled, and a 250ms minimum post-settle hold with
the identical owner inventory. Replacements, gaps, disappearances, unpresented surfaces, and dropped
events are all exactly zero. The adapter emits actual display and lifecycle events; the core harness
consumes the public trace.

Three public receipts close the causal chain. `ui.input.click` answers the stimulus epoch
(`atUnixMs`) and the declared `causeTraceId`, the matching `layout.transactions` entry carries that
same `causeTraceId`, and `ui.layout.wait-settled` answers the settle epoch and whether a surface
owner confirmed it (`syncPending`). The hold is a finite window that keeps the observation open past
settlement, and its contents come only from display-callback events. The waiting itself is not
evidence: start, end, and surface inventory are all judged from actual presentation event epochs, so
a window cut short produces RED, never a false GREEN. The hold is never filled from interval/rAF
samples.

A layout transaction never closes before the start epoch it declared. A glide declares an absolute
future `startAtUnixMs` so the DOM and the out-of-document surfaces leave together, and that epoch is
later than the surface ACK. Stamping `closedAtUnixMs` at the ACK would report a motion as over
before it began, so the transaction stays open until the surface ACK and that declared start have
both passed; a glide's `startAtUnixMs` therefore always falls inside
`preparedAtUnixMs`..`closedAtUnixMs`. A snap declares no start and closes at its ACK.

Run the live Tauri/macOS B12 gate with `make e2e-titlebar-dev`. It builds once, hashes that executable, creates one run id, and completes exactly three cold restarts even when an earlier cycle is RED. Every cycle must report the same build id, run id, framework, platform, sorted live-window population, and all three browser acceptance identities. Missing or duplicate cycles and any identity/window drift make the aggregate RED; the aggregate is GREEN only when every window in all three cycles is GREEN.

Each window records the alignment right after the restart and the alignment after the load separately. The runner first reads the startup gate receipt (`window.startup` platform, generation, creationCommitted, rendererGreen, presentationInFlight, presented, and the presented composition sequence), samples the untouched cold composition, then waits for `ui.layout.wait-settled` before taking the baseline again. Any geometry, DOM instance, or inline-style difference between those two samples is RED, and one adapter boolean never stands in for the presented fact. Every sample carries the single paint owner ledger (identity, drawOwnerCount, targetSequence, appliedTargetSequence, mutationSequence, drawSequence, applying, lastApplyOk, lastApplyError). Across any span where the window geometry is unchanged, more mutations than composed transactions mean AppKit moved the buttons and the owner sat them back down, which is the `correct → wrong → correct` intermediate regression and is RED. Each cycle summary carries its cold-start receipt, and a cycle that continues the previous cycle's composition sequence is rejected as a warm run.

Each window is measured at 30, 60, and 72 CSS px through public commands, then receives one finite hostile whole-window resize sequence. Every transaction carries the actual Tauri titlebar probe generation and its raw DOM reservation, AppKit button/backing, titlebar, and viewport rectangles. The final requested outer size, the later `window.info`, and a held read must all restore the exact baseline outer size and composition. Every applied sample also has a later read-only held sample; geometry, DOM identity/style, and native presentation revision must remain exact across that interval, so a late framework redraw cannot pass on its earlier correct frame.

Evidence is stored below `~/.soksak-e2e/evidence/titlebar-composition/<run-id>/<cycle>/`; `run.json` is the closed three-cycle verdict. Machine verdicts use public DOM/AppKit rectangles and startup receipts. Stored screenshots and finite recordings are mandatory human inspection evidence but never determine PASS/FAIL.

Each engine×gate machine state is one of `not-applicable`, `not-run`, `blocked`, `red`, or `green`. `green` and
`red` require machine-reproduced evidence; `blocked` requires a concrete reason such as a missing
public measurement surface. Neither `blocked` nor `not-run` counts as success. `not-applicable`
is excluded from the required count and is valid only for the static catalog condition above. The
machine summary is `green` only when every required cell is `green`; otherwise it preserves the
outstanding state with `red` → `blocked` → `not-run` precedence.

Screenshots and recordings must be inspected during development to discover defects, but they are
never an input to, or success evidence for, an automated machine gate. Convert every visual finding
into numeric public coordinates, state, or event traces and reproduce it as RED in the same gate.
Human review of images and recordings is recorded separately as `visualReview` with
`not-applicable`, `pending`, `passed`, or `failed`; it never changes machine state. Conversely,
machine `green` never changes
`visualReview` to `passed`. `createBrowserGateReport`, `setMachineGateStatus`,
`setVisualReviewStatus`, and `serializeBrowserGateReport` serialize the complete result in fixed
order without mixing the two verdicts.

## Harness rules (learned the hard way)

- **Never let a harness restart the app in a loop.** Recovery from a wedged state runs at
  most once, then fails loudly with the diagnostic — a restart→respawn→rescan loop is not a
  recovery.
- **A socket read that hits EOF raises**, it does not spin: `recv` returning empty forever is
  a hang, so treat EOF as an error.
- **Unwrap the response envelope once, in the rpc helper.** Machine payload nests under
  `data` (MESSAGE-PROTOCOL); flatten it in the helper so assertions read flat fields.
- **Target a workspace window explicitly.** `main` is the control plane with no workspace, so
  a harness that measures a project must open its own `w-*` window and route every command to
  it — an unaddressed command lands on the control plane and measures nothing.
- **Background step captures use an event boundary, never a timer.** `ui.input.drag` with
  `captureSteps:true` uses rAF after a focused paint, but an unfocused WebKit has no rAF and
  throttles even short timers. Its no-focus path therefore waits for one `MessageChannel` task,
  forces DOM layout, and reports each such boundary in `recording.frameFallbacks`.
- **Process-owning live measurements get an isolated lane.** `pnpm test` runs ordinary Vitest
  files in parallel, then runs `scripts/electron/content-view-live.test.mjs` alone. That test
  boots a real Chromium guest; under the full worker fan-out it can starve for 45 seconds while
  completing in under two seconds alone. Do not raise its timeout or omit it — keep both phases
  under the same public test command.

## Plugin & sidecar repos

A plugin repo's `test-unit` is its own suite (vitest or cargo). A repo with a build step
(TypeScript `src/`) builds before it publishes; a plugin also wires `soksak-plugin-doctor`
into `prepublishOnly` so the integrity gate (theme/permission/naming/envelope) runs before
release. A test script that runs `vitest` with zero test files is a false green — either add
a real test or drop the script.

---

한국어 안내는 [TESTING.ko.md](TESTING.ko.md).
