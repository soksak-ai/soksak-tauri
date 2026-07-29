# Repository layout

## The law: a folder name declares its **owner**

What sits in a folder belongs to whatever that folder names. When the name and the contents disagree,
the disagreement never surfaces as an error — a reader concludes "it lives here, so it must be part of
this", and the next coupling is built on that misreading.

Four words are used here, and their meanings are fixed (a gate enforces them).

| Word | Meaning | Examples |
| --- | --- | --- |
| framework | supplies windows, the event loop, the bundle | Tauri · Electron |
| platform | the operating system | macOS · Windows · Linux |
| engine | the webview engine | WKWebView · Chromium |
| shell | the user's shell | zsh · bash |

So the folder that holds `tauri` and `electron` is `frameworks`. Not `platform`.

## Current state (migration complete, 2026-07-29)

```
core/
├── Cargo.toml          the workspace root — not a package at all
├── src/                app UI (framework-agnostic)
├── frameworks/         frameworks are siblings
│   ├── tauri/              the Tauri adapter (src · capabilities · icons · gen · conf)
│   └── electron/           the Electron adapter
├── crates/             eleven framework-free Rust crates
│   ├── soksak-core/        rules (no dependencies) + assets/shell-integration.zsh
│   ├── soksak-cored/ store/ watch/ ptyd/ seal/ spec-*/ cli/
├── platform/           the OS axis
├── packages/ worker/ scripts/ docs/ plans/ public/ examples/ secret/
```

## What changed

**① Code that had become framework-free moved out of the framework.** `src-tauri/crates/*` →
`crates/*`, `src-tauri/cli` → `crates/soksak-cli`. None of the eleven crates depends on tauri. One of
them, `soksak-cored`, carries a gate banning `tauri`, `wry`, `tao`, `objc2`, `libloading`,
`windows-sys`, and `tokio` **by name** — code whose job is to refuse a framework by name had been
living inside that framework's folder.

**② The workspace root shed its framework.** `src-tauri/Cargo.toml` used to be both the `[workspace]`
and the Tauri app package. The root is now at the top level and is not a package at all.

What only works at the root came with it — `[patch.crates-io]` and `[profile.release]`. In a member
manifest cargo **warns and ignores them** (measured): the upstream wry leak patch would silently come
unpatched while the build still succeeds, and the difference shows only at runtime. A virtual manifest
silently defaults to `resolver = "1"`, so `resolver = "2"` is now explicit.

**③ The two frameworks became siblings.** `frameworks/{tauri,electron}`. The layout no longer says
"Tauri is the product and Electron is a guest."

**④ The name `src-tauri` is gone.** It was the Tauri CLI's convention, and shared code had no reason
to live beneath it.

## The law of the layout

Three rules.

1. **Framework-free code does not live under a framework's name.**
2. **Frameworks are siblings** — neither is the other's parent.
3. **The workspace root is not a framework** — if shared crates belong to one framework's build unit,
   deleting that framework takes the rest down with it.

## Inside soksak-core

Today `src/` holds 38 files, flat. Unlike things sit side by side: identity and paths, store rules,
processes and PTY, window and surface specs, plugin rules, the control plane.

Five test files (`activity_recent_tests.rs`, `control_tests.rs`, `plugin_data_tests.rs`,
`pty_delivery_tests.rs`, `skillgen_tests.rs`) are split out as siblings while every other module keeps
its tests inline as `#[cfg(test)] mod tests`. Two conventions coexist and the files alone do not say
which one is the rule.

Group by **what the rule is about** — not by size, not alphabetically.

```
soksak-core/src/
├── lib.rs
├── identity/     identity · pathx · unit_dev · unit_target
├── store/        kv · store_open · store_lock · seal_keys
├── proc/         proc · ptyd · pty_delivery · shell_env · shellq · session
├── surface/      window_spec · window_traces · surface_spec · geometry
├── plugin/       plugin_data · plugin_dir · skillgen · themes · probe
└── wire/         control · stream · stream_sink · activity · activity_sink · udp · secret_env
```

Settle on one convention for tests. Inline `#[cfg(test)] mod tests` is the majority, so it is the
standard; the five that were split out either carry a stated reason or move back inline.

## What the move touched

**136 files** of external references (gates, tests, docs, plans, manifests, CI, config). The places
that could have broken silently were handled on their own terms.

- Two `include_str!` paths that crossed a crate boundary. `shell-integration.zsh` moved next to its
  consumer (`crates/soksak-core/assets/`), removing the cross-tree include entirely.
- Gate **scan roots**. With `["src","src-tauri"]`, a vanished root drops all Rust out of the scan and
  the gate reports zero violations — a pass that guards nothing. Those gates now fail when no root
  exists (fixed in a preceding commit, before the move).
- **Sealed baselines** keyed by path (`baseline-unwrap.txt`, `baseline-file-length.txt`). A mismatched
  key breaks the seal, and a file that passed only because it was sealed becomes an instant violation.
- `.github/fixtures` — with the root at the top level, that fixture package falls inside the workspace
  directory. It is now excluded.
- A path inside a regular expression (`framework-binding.mjs`) — the slash escaping has to change with it.
- The npm package name `electron/…` is not the repository folder. A blanket rewrite that catches it
  breaks module resolution.


## Gates

A layout that lives only in a document gets violated by the next person. Three checks:

1. No Rust crate outside `frameworks/*` depends on a framework crate (today `no_framework` guards only
   cored; widen it into a layout rule).
2. The workspace root package is not a framework app.
3. Names under `frameworks/` use framework vocabulary only (no `platform`, `engine`, or `shell`).

---

This document is the **standard**, and the tree stands as it describes. The three gates above catch a departure from it.
