# Identity — entities, names, ids, references

This document is the canon for what exists in soksak, what each thing is called,
how it is identified, and how it is referred to. It is the *result* of the
2026-07 identity standardization, not a summary of the plan that produced it —
the plan is disposable, this document is not.

Korean twin: `IDENTITY.ko.md`. The two are committed together.

## 1. The entities

Five exposed entities, one hierarchy:

```
w-<uuid4>            window   — the OS window; it IS the workspace
 └ pjt-xxxxxx        project  — one root folder of work
    └ spc-xxxxxx     space    — one arrangement of panes inside a project
       ├ pan-xxxxxx  pane     — a rectangular cell where tabs live
       │   └ tab-xxxxxx  tab  — one switchable instance inside a pane
       └ pan-xxxxxx
```

| entity | definition | id | issued by |
|---|---|---|---|
| window | the OS window | `w-<uuid4>` (unchanged) | Rust (`window.rs`) |
| project | work bound to one root folder | `pjt-<base32·6>` | `src/state/ids.ts` |
| space | one layout of panes | `spc-<base32·6>` | `src/state/ids.ts` |
| pane | the cell tabs live in | `pan-<base32·6>` | `src/state/ids.ts` |
| tab | one instance of a view | `tab-<base32·6>` | `src/state/ids.ts` |

One more prefixed id lives outside layout: the **shell session** (`sh-<base32·6>`),
issued when a PTY session is created. It exists so the PTY reattach key is bound
to the session itself, never to tab identity — renaming tabs must never be able
to orphan a live shell.

**Invariants**

- A pane holds **zero or more** tabs. An empty pane is valid
  (`emptyPanelContext.test.ts` guards this; do not "strengthen" it away).
- Tabs live **only** in panes.
- The layout tree's interior nodes (row/col splits) are **not entities**: no
  name, no exposed id, no appearance in addresses, commands, or replies. Proof
  and rationale in §4.

## 2. Kinds, positions, facets — the rest of the vocabulary

| axis | word | meaning |
|---|---|---|
| kind | **program** | what a person picks in the (+) menu — `contributes.programs` |
| kind | **view** | the surface kind a program opens — `contributes.views` |
| position | **region** | `left \| content \| right` |
| position | **placement** | `content \| rail \| rail-footer` |
| position | **rail** | the projection rail; instances there are *not* tabs |
| boundary | **gutter** | the draggable seam between siblings |
| facet | **`-body`** · **`-border`** · **`-title`** · **`-status`** | parts named for what they are — a part name never hides its entity |

`program → view → tab` is a fixed chain: a program (menu item) opens a view
(surface kind), and the opened instance is a tab. All three stand alone and
name different things.

Rail projections use natural keys (`project|ref|viewId` composite) — their
identity is a pure derivation (`instanceKey`), recomputed per resolve, so they
issue no ids.

## 3. Deleted words and their replacements

Old code and docs used up to four names for one thing. Enforcement is honest
about its coverage: the CSS gate guards `App.css` names and the vocabulary gate
guards `pane`/`panel` identifiers. The `view`(instance)·`group` axes are
renamed on the exposed surfaces (commands, addresses, CSS) but internal
identifiers migrate incrementally under NAMING's table — no gate counts them
yet, so do not read this table as "a gate proves zero survivors" for those two
rows.

| deleted | was | now |
|---|---|---|
| `panel` | the cell tabs live in | **pane** |
| `group` / `egroup` | same cell, state/CSS layer | **pane** |
| `content` (as an entity) | the space | **space** (the region enum value `content` survives) |
| `pane` *(old meaning)* | a tab instance | **tab** — `pane` now means one terminal cell |
| `cell` | pane's render alias | `.pane` |
| `slot` (as tab wrapper) | tab body element | `.tab-body` — `slot` survives only as the rail projection's *derived-key concept* (`instanceKey`); it is banned in any DOM name (§5-1) |
| `grid` | space's render alias | `.space` |
| `bodywrap` | space body | `.space-body` |
| `divider` | the seam | **gutter** |
| `view` *(instance meaning)* | a tab | **tab** (`view` survives as the *kind*) |

The migration table for identifiers (`paneId`→`tabId` target axis vs
`callerTab` caller-context axis, `$SOKSAK_PANE`→`$SOKSAK_CALLER_TAB`, …) lives
in `docs/NAMING.md`.

## 4. Why interior nodes have no name

The layout tree is `leaf | { dir: row|col, sizes, children }`. The interior
node was a candidate entity three times (`split`, `container`, `frame`) and all
three failed the naming rules (§5): `split` cannot stand alone (*split
__view__*, *split __pane__*) and means four things in English; `container` begs
"container *of what?*" when everything here contains something; `frame` already
means a render frame throughout this repo.

Then the need itself was disproved:

> **Theorem.** Every gutter coincides with the right/bottom edge of some pane.
> **Proof.** Take the seam between children cᵢ and cᵢ₊₁ of node N (axis A). It
> equals cᵢ's trailing face. cᵢ's subtree always has a leaf touching that face:
> recurse into the last child when cᵢ shares N's axis, any child when
> perpendicular; recursion is finite. ∎

So every seam is addressable as `gutter/<pan-id>/<right|bottom>` (canonical:
the **first pane in document order** touching it; other pane edges are aliases,
replies always echo the canonical form; `left|top` accepted as aliases). The
reverse mapping is unique: nearest row/col ancestor where the pane's subtree is
not the last child. Interior nodes keep internal ids (`s<n>`, local counter,
regenerated on restore) and appear nowhere outside the data structure.

Region seams (sidebar/rail resizers) are gutters too, addressed by owner:
`win/<l>/gutter/rail` (window-owned, px) and
`win/<l>/proj/<id>/gutter/<left|right>` (project-owned, px). Pane gutters are
ratio-valued and space-owned; the operation contracts differ and say so.

## 5. Naming rules

1. **Exposed entities own the bare names.** Parts derive by content
   (`-body`, `-border`, `-title`, `-status`) or from entity vocabulary
   (`-gutter`, `-tabs`); **wrapper role nouns are banned** — words that hide
   an entity behind an alias: slot · cell · grid · frame · container · leaf ·
   host · handle · group · panel. (Correction 2026-07-26: the first cut
   allow-listed two suffixes only, which under-enumerated real parts — a
   title band and a status bar are parts, not wrappers.)
2. **A name must stand alone.** If it only completes in a compound
   (*view split*), it cannot name an entity. Conversely, don't qualify a name
   that is already unambiguous.
3. **Containment context removes the need to qualify.** Addresses and typed
   fields don't repeat the parent (`Pane.tabs`, not `Pane.paneTabs`); flat
   namespaces (CSS classes) do qualify (`.tab-body`).
4. **CSS classes and custom properties use the same vocabulary** as the entity
   they style. A pane element never carries a `content-*` class.
5. **Semantic correctness beats familiarity.** `pane` was flipped (meant "tab
   instance" here, means "cell" everywhere else); we restored the real meaning
   and renamed the old uses, gate-enforced, rather than living with the flip.

## 6. Ids and references

- Form: `<prefix>-<base32·6>` (`[a-z2-7]`, RFC 4648 lowercase). Prefix table
  and the only issuance point: `src/state/ids.ts` (`ID_PREFIX`, `issueId`).
- **Scope rule**: prefixed ids apply to layout entities + shell sessions only.
  Axes where a natural key already carries meaning keep it — `schedule`
  (user-named id), `secret`/`data.kv` (`(ns,key)`), `daemon`/`theme` (name),
  `registry`, `webview` (`b-<win>-<tab>` derived label), `process` (pid),
  `ai.session` (a different "session" — AI lineage). Gate:
  `src/state/idScope.test.ts`.
- **References**: the full path is the principle, a single id is allowed.
  ```
  w-<uuid>/pjt-x/spc-x/pan-x/tab-x   # principle
  pan-x                              # allowed — globally unique
  ```
  A qualified path is *verified*, not resolved: mismatch → `TARGET_MISMATCH`.
  A single id resolving to more than one target → existing `AMBIGUOUS` with
  every candidate's full path in `data.candidates`. No third error code.
- **Replies name the resolved target.** The envelope carries
  `target: { window, project, space, pane, tab }` for whichever axes the
  command resolved. Omission of an axis in the *call* is allowed only as the
  explicit utterance `target:"active"` — silence is not a default (R-B2).

## 7. Ownership boundary

Coordinates are the core's; resources are the plugin's. The core resolves
"which tab is this command about" (`ctx.tab`, opt-in per command via
`target:"tab"`) because tab↔plugin attribution, activation, and mount are core
facts. The plugin maps that coordinate to its own resources (labels, engine
children, sessions) because those are plugin functionality the core must not
absorb. Headless plugin commands declare `target:"none"` (default) and are
never blocked by tab resolution.

## 8. Rejected candidates (do not reopen)

| candidate | rejected because |
|---|---|
| `win-` prefix | retired generation — burned by ba7c23fb, re-registration is test-blocked (`window.rs`), capability globs assume `w-*` |
| `wsp-` (workspace) | window *is* the workspace; a second name for a 1:1 concept re-creates ambiguity |
| `split`, `container`, `frame` as entity names | see §4 |
| `slt-` (rail slot ids) | `instanceKey` is a pure derivation, not issued; `degraded` slots have no key at all |
| `div-` | reads as the seam's abbreviation and collides with HTML `div` |
| per-axis prefixed ids (schedule etc.) | natural keys carry meaning; opaque ids there are a regression (C2) |

## 9. Enforcement

Eight gates pin this standard (each file's header states the rule, the RED
basis, and the shell query that produced its numbers):

`src/state/ids.test.ts` · `src/state/idScope.test.ts` ·
`src/state/vocabulary.test.ts` · `src/state/paneInvariant.test.ts` ·
`src/ui/cssVocabulary.test.ts` · `src/ui/domVocabulary.test.ts` ·
`src/commands/targetEcho.test.ts` ·
`src/commands/noArbitraryWait.test.ts` · `src/commands/noAlias.test.ts`

The banned-morpheme list itself is owned by `@soksak-ai/plugin-spec`
(`identityVocabulary.ts` — `BANNED_DOM_MORPHEMES`, `bannedDomName`): the full
§3+§5-1 vocabulary, token-judged so variants cannot slip through. Core gates
consume it; the publish gate (doctor) and plugin conformance consume the same
function so plugins cannot re-pollute what the core cleaned (rule, not list).

Names owned by external code are outside this vocabulary. A library that
ships its own DOM names (Tailwind's `grid`/`grid-cols-N` utilities, cmdk's
`cmdk-*` classes, shadcn/ui's `data-slot`) cannot be renamed by us, and
banning the name would ban the ecosystem. `EXTERNAL_DOM_NAMES` in the same
spec module records exactly those names — owner stated, each pattern covering
only that library's real grammar (never a broad prefix). It is an ownership
record, not an exemption channel: a name that aliases one of our entities
never qualifies, whoever ships it (§8 — do not reopen).
