# Performance Constitution — Interaction Performance Principles

Seven principles that protect soksak's interaction performance. Every frontend
change is reviewed against this document. A violation is a defect — "it works"
is not a pass.

Background: a 2026-06 audit found ten structural causes (R1–R10) that drove
WebContent CPU to ~100% from light interactions alone (divider/tab/sidebar
drags, scrolling). Every cause was a violation of a principle below. The
measurement harness lives in `scripts/perf/`.

Korean translation: [`PERFORMANCE.ko.md`](./PERFORMANCE.ko.md). The English
file is canonical; on conflict, English wins.

## Principles

### 1. Minimal subscriptions

A component subscribes, via selector, only to the data it actually renders.

- Forbidden: bare hooks with no selector (`useSessions()` / `useSettings()`) —
  every store write re-renders that component and all of its children.
- Whole-store subscriptions (`useSessions.subscribe(cb)`) are the same — the
  callback runs on every write, so expensive callbacks must be coalesced per
  frame (principles 4 and 5).
- Use a `useShallow` pick when multiple fields are needed. Actions are stable
  references fixed at definition time, so per-action selectors are safe.

### 2. Render boundary = data boundary

`React.memo` boundaries match data-ownership units (GroupArea=content,
FileViewer=view, ProjectPane=project …). Props crossing a boundary guarantee
referential stability (useCallback / stable selectors / refs). Custom
comparators are forbidden — they breed staleness bugs. A memo that does not
hold with the default shallow compare has a wrong design.

### 3. Separate transient from durable state

Mid-gesture values (drags) are transient state. Commit to the store (durable
state) once at gesture end — or, when visual tracking is required, at most
once per frame. Writing to the store on every mousemove is forbidden.

### 4. High-frequency events run once per frame

Continuous-input handlers (mousemove, dragover, scroll-linked work) are
coalesced to once per frame with `rafThrottle` (src/lib). At gesture end,
`flush()` commits the final value — before removing listeners, or the last
frame is lost and the UI snaps back. A non-focused WebKit pauses rAF; in that
state the same helper coalesces to one `MessageChannel` task instead. This is a
one-shot event boundary, not a timer or polling loop, and keeps no-focus command
injection capable of producing each requested DOM layout.

### 5. Expensive side effects run once, after input settles

IPC (invoke), PTY resize (SIGWINCH), and native-webview move/resize run once
after input settles (trailing debounce). Storms cost not only active-phase CPU
but **delayed spikes** (e.g. hundreds of SIGWINCHes → a TUI redraw cascade for
seconds). Forced layout reads (getBoundingClientRect etc.) never run
synchronously per render — move them to rAF timing.

#### 5a. Visual continuity at a native composition boundary

A user gesture never shows discontinuous content. The means depends on where the content lives:

- An in-document surface follows its DOM parent. Core and Electron install no native bounds follower,
  screenshot stand-in, veil handoff, or z-order transaction.
- A Tauri child webview stays live at one stable z-order. Predictable rail relocation is a finite snap
  transaction: the current DOM slot is the source coordinate, intermediate mutation writes are locked,
  and the folded target frame is committed once. A stale native frame is never used as the next
  journey's origin.
- A plugin-owned windowed engine joins that same Tauri transaction through the public DOM claim event.
  Tauri supplies the final committed rect and awaits the engine ACK; the plugin does not infer a
  framework name or chase intermediate relocation frames.
- Unpredictable resize input is event-driven (`ResizeObserver` and explicit gesture edges), coalesced
  per label, and always converges on the current public slot. It does not run a frame polling loop.
- Focus lighting is one SVG plane outside the work surface, never `filter` or `opacity` on a content
  ancestor, so DOM, canvas, and WebGL renderers keep their normal composition path. Only the Tauri
  adapter projects the same `--dim` value to an AppKit plane, committed with the surface frame. The
  SVG base veil uses a luminance mask: white retains the veil and a black aperture removes it. An
  alpha mask is forbidden because both colors are opaque and therefore close the aperture.
- A `viewId` is product-view identity; its DOM container is a React render generation. Duplicate
  registration of the same generation is an idempotent acquire, while a new generation atomically
  supersedes the old one. A late cleanup from the old generation is identity-guarded and cannot remove
  the new owner. Treating normal space/tab replacement as a global duplicate error is forbidden because
  it can tear down the entire renderer.
- Captured pixels are evidence (`window.record` / `window.snapshot`), never replacement UI.
  Electron capture uses the normal `capturePage` capturer lifetime so the parent and `<webview>` guest
  are composited together. It does not force `stayHidden:true` and never focuses the window.

### 6. Preserve the platform paint path

CSS that breaks WebKit's composited (async) scrolling or composited layers is
forbidden. Canonical example: global `::-webkit-scrollbar` customization
(forces the legacy scrollbar path). Prefer standard `scrollbar-width` /
`scrollbar-color`. Suspected patterns must be verified with an A/B harness
measurement before adoption.

### 7. No completion without measurement

A change that touches performance ships with before/after numbers from
`scripts/perf/run.sh`. Scenarios (S1–S7) and the gate procedure are in
`scripts/perf/README.md`. Read both the active phase and the tail — tail
regressions signal side-effect storms.

### 8. A number without its profile is not a measurement

Every performance number states the cargo profile it was taken under, and numbers
from different profiles are never compared. `scripts/perf/run-t.sh` discovers the
profile from the running executable's path (`identity_cargo_profile` in `lib.sh`:
cargo puts the `dev` profile in `target/debug` and `release` in `target/release`)
and writes it to `meta.cargoProfile`; `check-budgets.mjs` rejects a mismatch as
`INVALID_CONDITIONS`.

Why this is a principle and not a note: the workspace declares only
`[profile.release]`, so `make dev` and `make build-debug` (`tauri build --debug`)
both produce cargo's `dev` profile — `opt-level=0`, `debug-assertions`,
`overflow-checks` — for the whole dependency tree, the bundled C SQLite included.
Measured on the repo's own `RawRing::push` under its operating conditions
(256 KiB ring, 8192 B chunks, 100 MB), the same code runs at **77.09 MB/s** at
`opt-level=0` and **737.03 MB/s** at `opt-level=3` — a 9.56x gap on one hot loop.
Every budget in `budgets.json` was taken on the unoptimized profile. A number
that does not say which profile produced it cannot be acted on.

### 9. Regression gates and absolute targets are separate files

`budgets.json` holds `baseline x headroom` — the right shape for catching a
regression, and the wrong shape for catching an absolute defect, because the
baseline is whatever the defect already produced. Recorded consequence: an idle
CPU baseline of 46.4% derives a budget of 60, so the gate certifies half a core
burned at rest, and a run at 51.5% passes.

`targets.json` holds what a healthy number *is*. Targets are derived from a
measurement or from arithmetic over measurements, never invented, and each entry
carries its derivation and the command that reproduces it. A target is never
widened to make a run pass — when one cannot be met, the next bottleneck is
located by measurement and recorded. A run that regresses fails (exit 1); a run
that holds the line but misses a target exits 3 and is not called green.

## Boot latency — first answer, not first pixel

Boot is measured as the time from launch to the app answering its first
command. `make boot-latency` runs it against a cold start: the launcher
records when it called `open`, and every span reports through the activity
ledger, so the process side and the front end read on one timeline.

The launcher owns the start time. Measuring from the caller counts `make`
and `node` startup as the app's boot — 1658ms measured that way against
717ms measured from the launch itself.

The measurement asks **once**. Retrying hides a lost delivery behind the
next question: a `cmd-request` emitted before the window installs its
listener is dropped, and the sender waits out `DEFAULT_REPLY_WAIT_MS`. That
one lost delivery was 9.4s of an 11.7s boot until the window started
draining what it missed (`cmd_listener_ready`).

Spans, measured 2026-08-08 on a warm start at ~500ms total:

| span | ms | what |
| --- | --- | --- |
| launch → `rust:process-enter` | ~75 | LaunchServices and dyld |
| → `rust:setup-enter` | ~155 | framework init |
| → `rust:data-open` | ~50 | store claim (the owner already holds it) |
| → `executor:catalog-registered` | ~210 | webview and module graph |
| → `executor:pending-drained` | ~5 | listener up, missed deliveries drained |

Two costs are paid per owner lifetime rather than per launch, and both grow
with the data:

- The store's boot open runs `PRAGMA quick_check` over the whole database.
  Measured at 106MB: 1471ms, 99.8% of the open (`init_base` 0ms,
  `reconcile_fts` 2ms, `write_canary` 0ms). `data.stats` answers these as
  `openTimings`. The gate stays where it is — `cored` owns the store and
  outlives the app — but a growing store grows that one open.
- Standing up `cored` when it is absent: 285–615ms.

`controller.activate` is awaited by the core, so whatever a plugin does
there lands on boot. Each activate is stamped by name and duration
(`plugin-activate:<id>`), including when it throws. Activation is
registration: restoring documents or other state belongs to the view that
needs it, not to activate.

## Plugin performance contract

Plugin event handlers (`onDidChangeActiveView` etc.) run **synchronously on
the main thread**. Do not do heavy work (parsing, network post-processing,
bulk DOM) inside the handler — defer it. The host coalesces state diffs per
frame, so events describe the final state; do not depend on per-tick
intermediate values.

## Terminal renderer — WKWebView composite stretch (invariant)

Symptom: during a macOS window-edge drag (live resize), terminal glyphs
stretch (blurry scaling). DOM (tabs, sidebar) stays crisp; only the terminal
distorts.

Root cause: during live resize AppKit stops redraws (`inLiveResize`) and
scales the GPU-composited layer (the WebGL/Canvas renderer's `<canvas>`) to
the new window size as a CALayer (`layerContentsRedrawPolicy` stretches layer
contents unless explicitly redrawn). DOM stays sharp because WebKit
re-rasterizes tiles every frame. Chromium avoids this with a synchronous paint
in the resize callback; WKWebView has no such path, and Safari shows the same
symptom. In short, **WKWebView + GPU canvas cannot structurally avoid resize
stretch** — the canvas is a WebKit-internal composited layer whose
contentsGravity we cannot touch.

Rules:

- The default terminal renderer is WebGL (`xtermRenderer: "webgl"`) —
  throughput first (the user default). Composite stretch during window resize
  comes with it (cause above). This default chooses throughput over resize
  fidelity.
- Switch to DOM when resize fidelity matters — WebKit re-rasterizes DOM every
  frame, so it does not stretch. Settings "terminal renderer" or
  `sok settings.set '{"key":"xtermRenderer","value":"dom"}'`. Live terminals
  switch in place (WebGL addon load/dispose).
- [HARD] Workarounds that hide the stretch by covering the body are forbidden
  — concealment is not a fix. Renderer choice (DOM) is the only root remedy.

Evidence (2026-06 investigation, URLs verified):

- NSView.LayerContentsRedrawPolicy — `never`/`onSetNeedsDisplay` stretch layer
  contents on resize without an explicit redraw (`duringViewResize` redraws
  every frame):
  <https://developer.apple.com/documentation/appkit/nsview/layercontentsredrawpolicy-swift.enum>
- Cocoa Live Window Resizing — `inLiveResize`; content preservation is an
  opt-in optimization:
  <https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaPerformance/Articles/CocoaLiveResize.html>
- MTKView/SKView live-resize content stretch (CALayer contentsGravity + halted
  redraw): <https://developer.apple.com/forums/thread/94765>
- servo/webrender #1640 — on macOS "a frame must be drawn before returning
  from the resize callback" (without synchronous paint, content lags/scales):
  <https://github.com/servo/webrender/issues/1640>

Code anchor: renderer selection lives in the terminal plugin
(soksak-plugin-terminal-xterm, `src/terminal.ts` `xtermRenderer`).
