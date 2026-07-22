# soksak Sidebar — The Projection Rail (v2)

This is a child of `docs/ARCHITECTURE.md` (the skeleton contract). It governs the two global rails (left, right) and the rail footer. The parent contract wins on any conflict. Where this document and code disagree, fix the code. Where this document and a single-source-of-truth schema disagree, the schema wins for what it can enforce and this document wins for everything it cannot.

The decision record behind this model — axioms A1–A10, rules R1–R9, and the per-tool assignment table — is `plans/sidebar-projection-spec.md`. This document states the shipped behavior in the present tense and does not restate the derivation.

---

## 1. Model

Every window lays out as `[left rail | content | right rail]`. Splitting is recursive and unbounded in content only; the rails never host content splits.

A rail is composed of three bands:

- **Projection slots** — the sidebar declared by the space's single bound content view (`railBindingViewId`). Activating a view rebinds the space **only when its resolved sidebar differs** — same-function moves (terminal to terminal) keep the binding and move only the FLOW position; switching to a different function (or another per-view document) swaps the projection. Rail interaction changes neither. When the rail's FLOW station changes, the sidebar frame **travels** — a real coordinate transition, passing behind the content panes — and the content swap itself carries no appear/disappear effect. The sidebar moves; it is never staged as hide-then-show.
  Every slot renders in the **common frame**: a host-owned header (the function's icon and title, plus rail controls — the first left slot carries the rail-look toggle) above a body that is the plugin's alone. The whole header is the move handle — grabbing it drags the rail to a grid line; header buttons stay buttons. Functions sharing a reference share the frame and the instance. The rail has two looks, persisted as the `railLook` setting: `pane` (card tint and elevation, reads like a split pane) and `ground` (flat on the floor, hairline borders only).
- **Pin stack** — reserved. The left rail carries no user pin axis: it renders projections only. A plugin-owned resident surface belongs to the right rail and opens when its renderer ships. Stale pins from older snapshots render tolerantly and are removable with `ui.projection.unpin`.
- **Rail footer** — resident `rail-footer` views, pinned to the bottom.

Tools do not render sidebars inside their own view. A content view *declares* its sidebar; the rail projects it. Left is mandatory in the declaration, right is optional; a content view without a declaration is a parse error (A1), and `decoration: true` is the only exemption.

## 2. Declarations

`contributes.views[]` entries with the `content` placement, and `contributes.fileViewers[]` entries, may carry a `sidebar` field:

```jsonc
"sidebar": {
  "left":  [ { "contract": "soksak-spec-plugin-sidebar-file-tree", "range": "^0.0.1", "view": "tree", "instance": "shared" } ],
  "right": [ { "ref": "self.inspector", "instance": "per-view" } ],
  "template": "stack"        // slot arrangement when a side has 2+ slots: "stack" | "tabs"
}
```

- A slot references either the plugin's own rail view (`ref: "self.<viewId>"`) or a **contract address** (`{contract, range, view}`) resolved to the active implementer — plugin-id name pins are rejected (parent C3). Cross-plugin contract references require the matching `consumes` pin.
- `instance` is the identity axis: `shared` = one instance per project (`projectId|ref`), `per-view` = one per bound content view (`projectId|ref|viewId`).
- A referenced view carries the `rail` placement. `rail-footer` is the bottom resident slot. `resident: true` marks a rail view for the right-side resident surface; it grants no left-rail presence.
- `decoration: true` marks a content view exempt from the sidebar obligation. `transparent`/`nativeSurface` do not exempt.

Resolution failure — unimplemented contract, disabled provider, missing consumes — degrades that slot to an empty slot with a notice, without touching other slots or pins, and promotes losslessly when the cause clears.

## 3. Projection Behavior

- **Stability**: each space owns one binding, rebound only when the active view's resolution differs. Same-resolution focus moves only the FLOW position while slots, instances, scroll, and state stay unchanged.
- **Keep-alive**: projected instances stay mounted and display-toggled. Dead per-view instances (their bound view closed) and absorbed instances are evicted.
- **Absorption**: a stale pinned shared ref (from an older snapshot) absorbs its projection slot (`satisfied-by-pin`) — the pin stack owns the single render until the pin is removed.
- **Open intents**: a rail view opens resources through the binding context — the bound group — adding a tab without replacing existing panels, reusing an existing view for the same resource. With no binding it places into the active group. Cross-tool actions beyond that go through commands under contract pins, exactly like any other consumer.
- **Succession**: when the bound view closes, the binding falls back to the most recent surviving focus-history view in the same space, then to tab adjacency.
- **Restore**: cold restart reproduces the projection isomorphically — per-space binding, slot composition, instanceKey links, structural state. Stale pins persist in the per-project window snapshot until removed.

## 4. Commands and Events

| Surface | Behavior |
|---|---|
| `ui.projection.state` | Read a project's binding (view/group/content), resolved slots with status (`live`/`degraded`/`satisfied-by-pin`), pins, and focus history. |
| `ui.projection.pin` / `unpin` | `pin` rejects both sides: the left rail is projection-only (no pin axis), and the right side is the reserved plugin surface, rejected until its pin stack renderer ships. `unpin` removes stale pins idempotently. |
| `ui.intent.open` | Open a path through the binding context (same path the rail uses). |
| `projection.changed` | Fires when the resolution fingerprint changes — space rebinding, slot statuses, or pins. Same-resolution focus moves do not fire it. Boot observation is silent. |

`plugin.view.open` rejects the `rail` and `rail-footer` placements as open targets — rail views appear only through sidebar declarations. Dev-source loading is development-identity only; debug and release homes verify published installs.

## 5. Principles (S1–S10)

These are HARD. They are stated absolutely on purpose.

### S1. The host renders the frame only.
Projection band, pin strip, body slots, footer slot, width, visibility: the host's. Everything inside a body slot is the plugin's. A control that belongs to one view lives in that view, not in the frame.

### S2. No hardcoded content anywhere in a rail.
No built-in FILES tab, no reserved core panel in a rail body. Every rendered body arrives from a registered `PluginViewProvider` through a declaration or a pin. Core management surfaces live outside the rails (the plugin manager is a modal).

### S3. Empty rail is the frame and nothing else.
Zero pins and a collapsed projection band render the frame alone. Empty is a valid, stable state, not a defect to paper over.

### S4. The view context is the only channel into a rail view.
A rail mount receives `{ projectId, root, paneId, boundViewId, setBadge }` plus `app.*` capabilities — `boundViewId` names the content view a projected instance serves (per-view store attachment). Content-only context fields (`setStatus`, `setTitle`, `setIcon`, `setRestoreState`) are no-ops on rail mounts. No store, no layout tree, no theme object crosses this seam.

### S5. Selection, keep-alive and fallback are the host's.
The host owns pin-tab selection and keeps inactive views alive. When a view unregisters, the host falls back without dangling selections or orphaned mounts; a reloaded view reconciles from current state.

### S6. Theme via host CSS variables.
A rail view inherits theme strictly through host-propagated CSS custom properties. No theme store reads, no palette literals, no theme-name branches.

### S7. cwd-following is opt-in and capability-driven.
A follower reads its context `paneId` and subscribes through `app.terminal`. The host pushes nothing.

### S8. A follow toggle belongs to the view, not the host.
The file explorer's cwd-follow is the explorer's header toggle, defaulting to project root. The host has no follow mode.

### S9. Views appear only through the declared seams.
Registration (`contributes.views[]` + `registerView`), sidebar declarations (`sidebar` on content views and file viewers), and pins. There is no other path into a rail.

### S10. Verify, never assume.
Rail conformance is proven: `ui.projection.state` assertions for binding and slots, `projection.changed` for transitions, `window.snapshot` read directly for pixels, and restore proven cold **and** warm-idempotent — a single cold pass is not acceptance.

---

## 6. Conformance

- **Frame-only / no-hardcode**: grepping the host for a view name or a built-in tab yields zero; the rails render only registered providers.
- **Projection**: bind a declaring view → `ui.projection.state` shows the resolved slot `live` with the declared instanceKey; switch to another consumer of the same shared contract → instanceKey unchanged, no remount.
- **Projection-only left rail**: `ui.projection.pin` rejects both sides; unpinning a stale absorbed ref flips its slot from `satisfied-by-pin` back to `live`.
- **Degradation**: disable the provider → slot degrades in place; re-enable → promotes with state intact.
- **Restore**: compose binding+pins+structure → restart → `ui.projection.state` isomorphic + snapshot visual match → repeat warm.

---

Version: 0.0.3
Status: AUTHORITATIVE
Parent: `docs/ARCHITECTURE.md` (inherited, not restated) · Decision record: `plans/sidebar-projection-spec.md`
Single source of truth: `@soksak-ai/plugin-spec` (`packages/plugin-spec/src/spec.ts`), `src/state/projection.ts`, `src/state/projectionWiring.ts`, `src/plugins/viewRegistry.ts`, `src/commands/catalogProjection.ts`
This document adds only the advice those schemas cannot enforce.
