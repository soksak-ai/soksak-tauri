# soksak command reference (curated)

Every command: `sok <command> '{JSON}'`. Omit any target id to use the caller's
context (`$SOKSAK_CALLER_TAB`) → active chain. This file covers the commands you
need for developing-and-verifying. For the **full, live** catalog of every core
and plugin command with exact param schemas, returns, and errors, run:

```bash
sok command.docs     # structured JSON, single source of truth
sok docs             # rendered markdown
sok state.commands   # catalog with param schemas
```

## Table of contents
- [Discovery — find ids before you target](#discovery)
- [Projects & windows](#projects--windows)
- [Spaces](#spaces)
- [Panes (splits)](#panes-splits)
- [Tabs](#tabs)
- [Terminal](#terminal)
- [Visual verification](#visual-verification-the-core-of-this-skill)
- [Browser (open & inspect web output)](#browser)
- [UI automation (addressed nodes)](#ui-automation)
- [Files, git, misc](#files-git-misc)
- [Plugins & programs](#plugins--programs)

---

## Discovery
Run these constantly. Never invent an id.

| Command | Purpose |
|---|---|
| `state.tree` | Full address book: every project/space/pane/tab id + active state. Panes carry `rect` (%). Inner split nodes are not entities — they have no ids; gutters are addressed by pane edge. |
| `state.context` | Where the caller sits: `{projectId, spaceId, paneId, tabId?, callerTab?}`. |
| `window.list` | Open window labels. |
| `window.projects` | Which project each window hosts (`{root, name, window}`). Use before `--window`. |
| `window.monitors` | Monitors + window rects (physical px) for multi-monitor placement. |
| `project.list` / `project.recent` | Open projects / recent roots. |
| `space.list` | Spaces in a project: `{id,title,program,active}`. |
| `pane.list` | Panes in a space + layout + rects. |
| `tab.list` | Tabs in a pane. |
| `program.list` | Launchable programs for a tab (`terminal`, `claude`, `codex`, `browser`, plugin views). Nothing is built in — check here for valid `program` ids. |

## Projects & windows

| Command | Args (required ✓) | Notes |
|---|---|---|
| `project.open` | `root` ✓ (or `folder`), `program`, `alias`, `shell` | Opens/focuses a workspace for a folder. `program` sets the first tab. Home/`/` forbidden as root. |
| `project.activate` | `project` ✓ | Switch active project. |
| `project.close` | `project` ✓ | Refuses to close the last one. |
| `project.rename` / `project.color` | `project` ✓, `title`/`color` | Cosmetic. |
| `window.open` | `root` (or `mode:"orchestrator"`), `alias`, `shell` | New OS window for a root. Already-open root → focuses existing (`existingWindow`). `orchestrator` brings the control plane forward. |
| `window.focus` / `window.close` | `label` | Target a window from `window.list`. |
| `window.place` | `label` ✓,`x`✓,`y`✓,`w`✓,`h`✓ | Exact frame in physical px (`window.monitors` space). |
| `window.move` / `window.resize` | `x,y` / `w,h` | Automation/E2E of the native window. |
| `layout.suggest` | `strategy` (`spread`\|`grid`), `roles` | Pure strategy → feed placements to `window.place`. |

## Spaces

| Command | Args | Notes |
|---|---|---|
| `space.create` | `program`, `project` | New space. Returns `{projectId, spaceId, paneId, tabId?}`. |
| `space.activate` | `space` ✓ | Switch to a space. |
| `space.close` | `space` ✓ | Refuses to close the last space. |
| `space.rename` | `space` ✓,`title` ✓ | — |

## Panes (splits)

| Command | Args | Notes |
|---|---|---|
| `pane.split` | `side` ✓ (`left\|right\|top\|bottom`), `pane`, `program` | Add a pane beside the target, optionally running a program. This is how you go side-by-side. Returns `{paneId(new), tabId?}`. |
| `pane.resize` | `edge` ✓ (`right\|bottom\|left\|top`), `pane`, `ratio` ✓ (0..1) | Pull the gutter on that pane edge: `ratio` = the pane's share of the two adjacent areas. Inner splits have no ids — gutters are named by pane edge. |
| `pane.equalize` | `edge` ✓, `pane`, `all` | Halve at one gutter, or equalize all siblings. |
| `pane.merge` | `src` ✓,`dst` ✓ | Move all tabs from src into dst; empty src removed. |
| `pane.move` | `src` ✓,`dst` ✓,`zone` ✓ | Reposition a whole pane relative to dst. |
| `pane.activate` / `pane.close` | `pane` | Focus / close a pane. |

## Tabs

| Command | Args | Notes |
|---|---|---|
| `tab.open` | `program` ✓, `pane` | New tab (`terminal`/`claude`/`codex`/plugin). Answers after mount — the returned `tabId` is actionable immediately (`mounted:false` = it did not come up in time). |
| `tab.activate` | `tab` ✓ | Switch to a tab. |
| `tab.maximize` / `tab.restore` | `tab` / — | Fill the space / undo. Layout preserved. |
| `tab.move` | `tab` ✓,`dst` ✓,`zone` ✓ | Move a tab to another pane (center) or split off (other zones). |
| `tab.close` | `tab` ✓ | Closes the pane too if it was the last tab. |
| `tab.rename` | `tab` ✓,`title` ✓ | — |
| `ui.intent.open` | `path` ✓ (absolute) | Open a file through the binding context; reuses the existing tab for the same path. |

## Terminal

| Command | Args | Notes |
|---|---|---|
| `term.exec` | `cmd` ✓, `tab` | Types the command + Enter. Check output with `term.read`. |
| `term.read` | `lines`, `tab` | Screen + scrollback text. `lines` = last N. |
| `term.send` | `text` ✓, `tab` | Raw key injection for TUIs. Escapes: `\r`=Enter, ``=^C, `[A`=↑. |
| `term.cwd` | `tab` | Current dir (needs shell integration). |

## Visual verification (the core of this skill)

| Command | Args | Notes |
|---|---|---|
| `window.snapshot` | `path` \| `base64` \| `rect{x,y,w,h}` | Capture the window to PNG. File mode → **Read the PNG to see it.** `base64:true` returns it inline; `rect` (CSS px, `ui.measure` space) crops a region and implies base64. Captures even when occluded; includes the WebGL terminal. |
| `window.record` | `dir` ✓, `frames`(≤600), `intervalMs` | Sequence of PNGs `f0000.png…` for motion/animation review. |
| `space.switchScan` | `to` ✓, `from`, `frames` | Measures a space switch: `clean` vs `switchFrames` (jank spread) via per-frame pixel change. |
| `window.themeScan` | `theme`, `from`, `to`, `frames` | Is a dark/light toggle atomic or torn across regions. |
| `window.info` / `window.layers` | — | Window pos/size/scale / native view hierarchy (layer diagnostics). |
| `ui.measure` | `address` ✓ | Rect (px) + computed style of an exposed node. |
| `ui.slot` | `address` ✓ | A content tab's host-container rect + dpr (verify a tab's placement). |

**The verify loop:** capture → `Read` the PNG → describe what you actually see →
only then report. DOM presence ≠ visible; confirm with pixels.

## Browser
Open a browser tab (`tab.open '{"program":"browser"}'`) then drive/read it.
Driving lives in the enabled browser plugin — find `<id>` with `plugin.list`.
All commands take optional `viewId` (omit = active browser tab).

| Command | Args | Notes |
|---|---|---|
| `plugin.soksak-plugin-<id>.navigate` | `url` ✓ | Go to a URL in the active browser tab. |
| `…​.open` | `url` | Open a URL (new browser tab). |
| `…​.reload` / `.back` / `.forward` | — | History nav. |
| `…​.dom.text` | `selector`, `maxLength` | Visible text of page/element. |
| `…​.dom.html` | `selector`, `maxLength` | Markup of page/element. |
| `…​.dom.query` | `selector` ✓, `limit` | Summarize matching elements (tag/text/attrs) — understand structure. |
| `…​.dom.click` | `selector` ✓ | Click first match. |
| `…​.dom.fill` | `selector` ✓,`text` ✓ | Fill an input (fires input/change; React-safe). |
| `…​.dom.submit` | `selector` ✓ | Submit a form. |
| `…​.dom.wait-for` | `selector` ✓,`timeoutMs` | Wait for a dynamic element (MutationObserver). |
| `…​.eval` | `js` ✓ | Run JS, JSON-serialized return (macOS-only). |
| `…​.devtools` | `viewId` | Toggle the OS web inspector. |

(More than one browser engine plugin can be installed, and command sets can
differ by engine. Use whichever browser plugin is enabled — `plugin.list` for
the id, `state.commands` for its actual commands.)

## UI automation
Drive the app's own chrome/plugin views by structural address (not CSS).

| Command | Args | Notes |
|---|---|---|
| `ui.tree` | — | List exposed node addresses (`{address, nodePath}`). Start here. |
| `ui.input.click` | `address` ✓ | Real mousedown→mouseup→click on an exposed node. |
| `ui.input.dblclick` | `address` ✓ | Double-click (e.g. inline rename). |
| `ui.input.fill` | `address` ✓,`value` ✓ | Set an input/textarea value (React-safe). |
| `ui.input.drag` | `from` ✓, `to`\|`dx`/`dy`, `zone` | Drag a tab onto a target, or drag a gutter by px. |
| `ui.hit` | `x` ✓,`y` ✓ | Topmost element at a viewport point (hit-test). |
| `ui.expect` / `ui.validate` | `selector` / `rule` | Border-contract lookup / RED-GREEN validation. |

Unexposed address → `NOT_EXPOSED`. That means the node isn't addressable — don't
retry with a guessed string; use an address from `ui.tree`.

## Files, git, misc

| Command | Args | Notes |
|---|---|---|
| `explorer.list` | `path` | Directory children (file-tree view). Omit path → project root. |
| `explorer.git` | `path` | Git change status per file. |
| `git.diff` | `file`,`staged`,`commit`,`path` | Unified diff of working tree/index/commit. |
| `git.log` / `git.show` | `limit`/`commit` ✓ | History / one commit in full. |
| `git.init` | `path` | Idempotent init. |
| `clipboard.read` / `clipboard.write` | / `text` ✓ | Inspect or set the system clipboard. |
| `notify.show` | `title` ✓,`body` ✓ | OS notification (good for "build done" pings). |
| `theme.apply` / `theme.list` | `name` ✓,`mode` / — | Switch theme; list available. |
| `activity.recent` | `limit`,`since` | App-wide activity stream: command runs, terminal start/finish, turn ends. |

## Plugins & programs

| Command | Args | Notes |
|---|---|---|
| `plugin.catalog` | `refresh` | Installable registry merged with local install state. |
| `plugin.list` | — | Installed + dev plugins, runtime status, rejects. |
| `plugin.install` | `source` ✓,`ref` | From `user/repo`, git URL, or local path. |
| `plugin.enable` / `plugin.disable` | `id` ✓ | Enable needs recorded consent (UI modal). |
| `plugin.view.open` / `.close` | `viewKey` ✓ (`<pluginId>.<viewId>`), `placement` | Open a plugin view in a sidebar/content slot. |
| `plugin.settings.get` / `.set` | `id` ✓,`key`,`value`,`scope` | Read/write plugin settings. |
| `program.list` | — | Valid `program` ids for `space.create`/`pane.split`/`tab.open`. |

Plugin commands are also callable directly as
`plugin.<pluginId>.<command>` (e.g. the browser `dom.*` calls above). Run
`sok docs` for the full per-plugin schema.
