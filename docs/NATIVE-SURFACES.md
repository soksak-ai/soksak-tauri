# Native content surfaces

This document is the current contract for content that is rendered outside the main DOM.

## 1. One product slot, framework-owned placement

The browser product declares exactly one public slot:

```html
<div data-content-view-body="<label>"></div>
```

The plugin owns browser chrome, navigation, and this slot declaration. A provider that owns an
external engine also owns the engine's bounds command, but it does not own the framework layout
transaction, z-order, clipping, visibility composition, or framework detection.

- Electron appends its `<webview>` directly to the slot. The element follows normal DOM layout.
  It installs no bounds observer, geometry transaction, veil, or follow loop.
  Electron does not register a plugin native-presentation host either: `nativeSurface` can enter a
  `PaneSurfaceHost` only when the selected adapter installed that public host, and the Electron
  registry remains empty. Its ordinary DOM element may use normal stacking, but no AppKit/native
  z-order transaction runs.
- Tauri creates an OS child webview. The Tauri adapter reads the slot rect and owns the child frame,
  visibility ledger, input bridge, overlay ordering, and diagnostics.
- A windowed external engine in Tauri declares the same slot and synchronously claims the public
  `soksak:external-surface-layout-transition` DOM transaction. Tauri chooses snap, reads the final
  committed slot rect, and waits for the provider's bounds ACK. The provider locks its ordinary
  event-armed follower during that transaction; it does not follow intermediate CSS frames.

The public plugin identity remains `soksak-plugin-browser-native`. A future neutral rename requires a
session, dependency, and command-namespace migration.

This boundary is enforced twice. Source contracts reject native follow, hole, veil, and pane-host
ownership from the Electron adapter. The built-artifact gate rejects Tauri SDK, pane commands,
native bounds transactions, hole markers, AppKit ordering, and external-surface transitions from
`dist/electron`; source placement alone is not accepted as proof of bundle isolation.

## 2. Tauri layering

The browser child stays at one stable native boundary in front of the main webview. Ordinary layout
movement changes only its bounds; it never raises and lowers the child as part of motion.

DOM overlays are a separate explicit state. When a modal or menu must cover native content, the
Tauri overlay gate lowers the child for that state and raises it again on the matching end event.
That state transition is not inferred from coordinates or timers.

The external-engine container occupies the same stable boundary in front of the main webview. Empty
container space returns `hitTest=nil`, and an offscreen surface whose input is forwarded by the DOM
also returns `hitTest=nil`. Pixels are therefore visible above the DOM while the public slot owns
input. The native surface is the sole product display path; a frame stream is never copied into a
second DOM image. Only the explicit overlay gate lowers and raises the whole container.

The single product fact for focus lighting is each pane's public `--dim` value, and the single
presentation device is one SVG plane outside the content tree. Neither the Tauri nor Electron
adapter installs a `--dim` observer, lighting IPC, `PaneSurfaceHost` or member alpha adjustment, or a
separate veil. Adapter presentation alpha remains 1, so the SVG plane applies dimming exactly once.

Transparent DOM pixels and `set_ignore_cursor_events` are not the browser embedding mechanism.
Those APIs describe desktop click-through windows and operate at window scope; they cannot provide
a reliable per-slot browser composition contract.

## 3. Bounds contract

The nested `data-content-view-body` rect is the single geometry source. Outer tab, pane, rail, or
visual-hole markers are not alternative bounds.

1. Fold fractional DOM edges with `surfaceRectOf`: ceil left/top and floor right/bottom.
2. Position changes arrive through committed `layout.reflow` events.
3. Size changes arrive through `ResizeObserver`.
4. Serialize writes per label and coalesce queued events into one read of the newest rect.
5. Do not send an unchanged rect.
6. Apply position and size as one native frame transaction.
7. Hidden surfaces do not receive incidental bounds writes. On reveal, restore a detached child if
   necessary, apply the newest rect, then show without stealing focus.

There is no polling, pointer prediction, or forever-rAF follower.

## 4. Rail relocation

Electron keeps ordinary DOM motion and mounts the plugin provider in the main document. Tauri cannot
atomically submit a main-renderer pane and a native child that only meet at the window root, so its
adapter mounts the same provider source exactly once in a pane renderer and groups that renderer with
its native members under one `PaneSurfaceHost`.

- The plugin and core branch only through the public `PluginViewPresentationHost`; neither names a
  framework. Electron registers no host and therefore retains the direct DOM path.
- A Tauri pane renderer reports every public slot and chrome node. The main document projects those
  addresses and frames for discovery and auditing; it does not render a second plugin UI instance.
- Pane ownership has two explicit identities. `logicalPaneId` is the workspace layout pane (`pan-*`),
  while `nativeHostId` is the adapter-owned AppKit `PaneSurfaceHost` registry key. The
  `PluginViewPresentationHost` receives the logical id directly from the layout owner and updates
  that binding without recreating the plugin or native surface. `PluginViewContext.paneId` is a
  caller/terminal binding and must never substitute for the layout identity. `webview.pane.hosts`
  exposes both ids plus `viewId` and does not expose an ambiguous `pane` alias. Presentation traces
  resolve an exact window/view/logical-pane/member tuple, then arm native capture with the returned
  `nativeHostId`; framework-label parsing is forbidden.
- The renderer and all native members keep pane-local frames. Rail relocation changes only the one
  parent `PaneSurfaceHost` frame, so every visible child inherits the same presentation transaction.
- Window and pane resize use the declared affine viewport contract to resize the host and its local
  members without stretching old pixels or running a follower loop.
- A hostile resize validates two finite phases: every requested native size must satisfy the stored
  affine host/member contract immediately, and the final resize-settled event must produce live
  projected-DOM/native equality. Intermediate renderer paints may be coalesced and are visual
  diagnostics, not fabricated per-request DOM commits.
- `webview.pane.composition` requires one projected pane, one native host, one member per declared
  slot, rounding-only frame deltas, and `rendererTopology.panelAtomicMotion=true`.
- Main-document layout settlement does not imply child-renderer settlement. A slot report and its
  acknowledged native-member write are distinct states. `webview.pane.composition.wait` first
  commits the current host DOM frame, then waits on native-member commit events belonging to that
  exact child viewport, and finally applies the same strict composition verdict. Late commits from
  an older viewport never release the barrier. Its finite `settleTimeoutMs` is failure containment,
  not polling; `timeoutMs` remains the command transport's reserved response deadline.
  The parent explicitly emits one `measure` event at this boundary because an unfocused WKWebView
  may defer `ResizeObserver` and `resize`; the child runs the same slot reporter and creates no
  alternate coordinate path or follower loop.

Screenshots, PNG or motion stand-ins, Core Animation copies, veils, two-rAF handoffs, frame-by-frame
bounds loops, and timing attempts between independent renderers are forbidden. They do not create a
shared presentation owner.

Every direct surface host and grouped `PaneSurfaceHost` is an AppKit sibling immediately below the
main DOM WKWebView. The DOM's transparent content holes reveal those surfaces, while opaque chrome
(the rail add button, right overlay sidebar, menus, and modals) remains naturally above them. Grouping
must preserve this ordering; plain `addSubview` is forbidden because it appends the pane above the DOM.
`webview.pane.composition` exposes the observed sibling relation as `chromeAboveHost`; a declaration
or class-name guess is not evidence. The rail and browser do not normally intersect, so the rail gate
uses this global sibling-order fact plus a DOM hit inside `rail/add`. The right sidebar and modal do
intersect a live surface and therefore additionally require a hit point inside the positive overlap.
Both facts travel in the gate receipt: the sibling order as the surface's `chromeAboveHost`, the DOM
side as `ui.hit`'s `owners` — the declared owner chain at that point, topmost first. A consumer never
stitches its own chain from `dataset`, `host` and `painters`, and never writes the expected owner into
the receipt; a receipt whose owner or order comes from the harness cannot fail. A violation of either
fact is recorded as evidence and judged, never thrown — a thrown violation leaves the run blocked and
its name absent from the report.

Ownership of a point is read by containment in that chain, never by an address prefix. The chain is
the ancestor path, so a chrome surface owns the point exactly when the chain contains it, and every
entry above it is one of its descendants. An address proves containment in neither direction:
`sidebar/right/resizer` is a DOM sibling of `sidebar/right`, and a plugin view mounted inside the
sidebar declares node ids in its own namespace — a plugin does not know where the core attached its
view, and knowing would be coupling. Above the target only descendant chrome may remain; a native
surface between them is a violation even when the chain contains the target. `ui.measure`'s
`occlusion.reachable` answers the same question at the node's center and crosses shadow boundaries
exactly as the hit-test descends them, because a plugin view mounts inside a shadow root.

Overlay verification addresses the visible overlay surface, not only its full-window backdrop. The
modal card is exposed as `modal/project-new/card`; a pixel probe is placed inside the card/native-slot
intersection. The right sidebar probe is likewise placed inside the sidebar/native-slot intersection.
Both intersections and probe coordinates are written beside the PNG, so an arbitrary non-overlapping
marker cannot produce GREEN. A probe declaration is acknowledged only after
`ContentViewHost.chromePresentationSettled()`; Tauri implements that barrier with the main
WKWebView's `afterScreenUpdates=true` snapshot completion rather than a timer.

## 5. Visibility and input

Visibility is explicit state owned by the Tauri content-view adapter. Bounds never imply show or
hide. A hidden DOM slot and a hidden native surface are compared by `webview.composition`; neither
is guessed from a zero rect.

Native child input never reaches the main DOM. The Tauri adapter may bridge the minimum native
events needed by shared host UI such as dividers. Such bridges are Tauri-only and expose commands or
status for deterministic testing. Electron uses the DOM path directly.

An offscreen engine is the explicit exception: its display NSView does not accept input, and events
from the public slot DOM are forwarded through the engine protocol. This separates one native pixel
owner from one DOM input owner; it does not duplicate presentation.

Product-visible differences are public capabilities:

| Capability | Tauri system webview | Electron webview |
| --- | ---: | ---: |
| `supportsDocumentStart` | true | false |
| `supportsInputInjection` | false | true |

Composition implementation details are not capabilities and must not leak into product branches.

## 6. Verification

Completion requires all of the following:

- unit RED→GREEN for adapter ownership, event-only following, one target bounds write, and no
  motion-time z-order handoff;
- `webview.composition` one-to-one agreement between visible slots and live native frames, allowing
  only the shared rounding rule;
- rail relocation passes its projected DOM transition trace, native presentation trace, final
  slot/native coordinates, and shared renderer topology in one numeric scenario;
- the DOM transition trace is armed by an acknowledged start command before the stimulus and judges
  only raw rects read in the same-transaction journal DOM-commit callback; nearest timer samples,
  interpolation, and movement projection are forbidden;
- each adapter emits native presentation events from its actual compositor/display callback,
  exposing owner identity, generation, revision, time, and lifecycle through the public interface;
  core never infers those events from DOM/status/PNG/video/stats or fills the hold with polling;
- every violation count a presentation receipt declares must be recoverable from that receipt's own
  events, so an adapter that never measures an axis cannot answer zero for it. The close command
  recomputes the recoverable lower bound and returns it as `selfAudit`: a count lower than what the
  receipt's own display epochs prove is reported by name, and the caller reads that fact without
  asking for it. A skipped display epoch is judged against the previous frame's own declared next
  display time, never against a fixed interval, because the refresh rate varies per frame;
- causality between a stimulus and a surface is joined by declared ids and core receipts, never by
  timestamp proximity: the epoch the stimulus answered, the `causeTraceId` carried by the layout
  transaction that stimulus opened, and the settle receipt's settle epoch plus whether a surface
  owner confirmed it. A caller never stamps the settle time from its own clock and never traces a
  stimulus back from a frame number;
- the baseline for hostile whole-window resize verification is the pre-resize observation the same
  command read from the same observer before requesting the first size. A baseline is never derived
  from the requested sizes. An observer that cannot answer yet is a refusal carrying its reason —
  not a zero and not the requested value — and that refusal never cancels the finite resize
  transaction;
- `window.pixels` agreement between the active/inactive luminance ratio and declared `--dim`, plus
  no per-surface lighting state in `webview.surfaces`;
- one reusable matrix that runs the system webview, windowed Chromium, and offscreen Chromium against
  the same local document, commits Korean text through the real input path, alternates two exposed
  content-surface addresses six times, and captures 48 frames per transition without focusing the
  window;
- every recorded stimulus starts only after the recorder emits that its baseline frame was written;
  dispatching a record Promise is not capture readiness, and a guessed lead delay is not a boundary;
- direct human inspection of the PNG sequence: no black frame, thin residual strip, detached page,
  or surface disappearance after settling. PNG/video decoding does not decide the automated E2E
  verdict. A visually discovered defect becomes a transaction-id, phase, coordinate, or clock
  invariant and is then proven with the same numeric RED→GREEN criterion;
- Electron build and tests proving that no Tauri observer, IPC, native lighting, z-order, or geometry
  transaction is installed there.

`window.snapshot` and `window.record` are the visual source of truth. DOM state alone cannot prove a
native child was painted.

## Pointer input into a native surface

A surface is addressed by the node the projection declares — `data-surface` for the content surface
itself, `data-realm` for a node that lives in a child renderer. Neither is guessed from the address
text. A gesture verb sends **every step of one gesture inside one call**: the caller cannot stitch
the steps, because a CLI round trip is longer than the double-click interval and two presses then
arrive as two separate single clicks.

The contract carries what happened, not only where: `down`, `up`, `move`, `drag`, `enter`, `exit`,
which button, and the click count. `drag` is not `move` — a move with a button held is a different
OS event, and sending it as a move gives the page `buttons: 0`, so code that watches for a held
button does nothing.

Two facts about injected pointers are engine rules, not defects:

- `MouseEvent.buttons` is always `0`. macOS derives it from the physical mouse, and the only way to
  change that is to move the real cursor.
- **Hover cannot be injected on the system webview.** Measured 2026-08-08: five deliveries each
  reached the page zero times — the view's own `mouseMoved:`, the window's `sendEvent:`, an NSEvent
  built onto the window, an `mouseEntered:`/`mouseMoved:` pair, and `CGEventPostToPid` into this
  process's own queue — with every condition satisfied (not hidden, full `visibleRect`, key window,
  topmost at that point, first responder). Presses, releases and drags arrive through the same path.
  The engine updates hover only from the real pointer stream, and producing that stream means taking
  the cursor away from the person at the machine. So hover is refused by name rather than answered
  as success. A press is what creates hover there: one click delivers `mouseover`, `mouseenter` and
  `pointerover` along with it.

`ui.input.state` answers what a surface can receive right now, and it takes a point because some
conditions differ per position. Ask it whenever an input verb reports success and nothing happens.

## Composition (IME)

Committing finished text never enters the composition state, so it cannot prove that path. Korean,
Japanese and Chinese pass through it before anything is committed: the page receives
`compositionstart` / `compositionupdate`, shows characters that are not yet its value, and backspace
removes a jamo rather than a character.

`ui.input.compose` sets what is being composed, and the same verb without `text` ends it — the place
a person reaches with space or enter. Leaving a composition open makes the next input stack on top
of it.

Measured 2026-08-08 on the system webview, driving `ㅎ` → `하` → `한` and then ending:

```
compositionstart → compositionupdate:ㅎ → compositionupdate:하 → compositionupdate:한
                 → compositionend:한     value: "한"
```

Each step also emitted `beforeinput` and `input`, which is what a person typing through an IME
produces. It goes through the AppKit text input client, not through DOM value assignment.

## Who delivers a surface's input

Only surfaces the framework holds could receive a pointer. A view whose content is drawn by an
engine sidecar was refused with "no webview" — measured 2026-08-08: of three browsers only the
system-webview one could be clicked, double-clicked or dragged, which to a person read as each
browser behaving differently.

The core does not learn those engines. It asks who owns a surface and the owner answers for itself:
`app.provideSurfaceInput({ owns, sendInput, inputState })`. Ownership is answered **by label matched
against the views actually alive**, never guessed from the label's shape — a prefix rule keeps
claiming surfaces after their view is gone, and those deliveries vanish silently. Two owners
claiming the same surface is an error, not a coin flip.

Where the owner is an engine that accepts injected moves, hover works there — unlike the system
webview.

## Keyboard needs the window to hold focus

Keys reach a surface through the engine's own path: named keys (Enter, Escape, arrows) go as the
commands AppKit sends when a person types; characters go through the text input client.

But nothing lands unless **that window holds keyboard focus**. Measured 2026-08-08: with the window
not key, the document's `hasFocus()` is false and the page receives nothing, while the call still
answered success. Both `ui.input.key` and `ui.input.compose` refuse by name in that state.

`window.focus` answers `key` for the same reason: bringing a window forward does not take the
keyboard when another app is active. The request succeeding and the focus arriving are two different
facts, and every keyboard command downstream depends on the second one.

## Messages say what to do

A refusal used to read: "this node is a projection of another realm — events stuck into the host do
not reach inside it". That explains our internals to someone who only wanted to know what to call
instead. Two rules are enforced by a gate over every `message:` in the command catalog: no internal
vocabulary (realm, projection, renderer), and never say only that something cannot be done.
