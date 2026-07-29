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

## Current state (measured 2026-07-29)

```
core/
├── src/            app UI (framework-agnostic) — sees a framework only through the adapter seam
├── electron/       the Electron adapter
├── src-tauri/      the Tauri adapter  +  11 framework-free crates  +  the Cargo workspace root
│   ├── src/            Tauri adapter proper (59 files · 28,293 lines)
│   ├── cli/            the sok CLI (framework-free)
│   ├── capabilities/   Tauri capability declarations
│   ├── icons*/ gen/    Tauri bundle assets
│   └── crates/         soksak-core · cored · store · watch · ptyd · seal · spec-* (20,262 lines)
├── platform/       OS-axis assets
├── packages/       npm packages (plugin-api · plugin-spec)
├── worker/         Cloudflare Worker
├── scripts/        gates · e2e · tools
└── docs/ plans/ public/ examples/ secret/ dist/
```

## What disagrees

**① Code that became independent of a framework lives inside that framework.**

The ten crates under `crates/` and `crates/soksak-cli/` depend on tauri **not at all** (measured
across every Cargo.toml). One of them, `soksak-cored`, carries `tests/no_framework.rs`, which bans
`tauri`, `wry`, `tao`, `objc2`, `libloading`, `windows-sys`, `tokio`, `interprocess`, and
`portable-pty` **by name**. Code whose job is to refuse a framework by name sits inside a folder named
after that framework.

**② The workspace root is one framework's app.**

`src-tauri/Cargo.toml` is both the `[workspace]` and the Tauri app package
(`name = "soksak-tauri-dev"`). All eleven shared crates are members of that workspace — shared code
belongs to one framework's build unit.

**③ The two frameworks are not siblings.**

`electron/` sits at the top level while the Tauri adapter lives in `src-tauri/src/`, whose parent also
holds the shared code. The layout says "Tauri is the product, Electron is a guest." The port's premise
says the opposite: one core, two frameworks, equal standing.

**④ `src-tauri` is itself a framework convention.**

It is the Tauri CLI's default directory name. Following that convention is the Tauri adapter's own
business; there is no reason for shared code to live beneath it.

## Target layout

```
core/
├── src/                app UI — unchanged
├── frameworks/         frameworks are siblings
│   ├── tauri/              today's src-tauri/{src,capabilities,icons*,gen}
│   └── electron/           today's electron/
├── crates/             framework-free Rust — the workspace root lives here
│   ├── soksak-core/        rules (no dependencies)
│   ├── soksak-cored/       the serving process
│   ├── soksak-store/       the store resource
│   ├── soksak-watch/       the filesystem-watch resource
│   ├── soksak-ptyd/        the PTY daemon
│   ├── soksak-seal/        sealing
│   ├── soksak-spec-*/      contracts
│   └── soksak-cli/         the sok CLI (today's crates/soksak-cli)
├── platform/           the OS axis
├── packages/ worker/ scripts/ docs/ plans/ …
```

Three rules cover it.

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

## What the move costs

**63 files** outside `src-tauri` reference that path (gates, docs, plans, manifests, CI); ten of them
point at `crates` directly. Moving the tree changes all of them.

On the Rust side, `Cargo.toml` `members` and `path` dependencies move with it, as do
`include_str!("../fixtures/…")` relative paths. The frontend knows `src-tauri` only as a build-output
path, so its exposure is small.

## Gates

A layout that lives only in a document gets violated by the next person. Three checks:

1. No Rust crate outside `frameworks/*` depends on a framework crate (today `no_framework` guards only
   cored; widen it into a layout rule).
2. The workspace root package is not a framework app.
3. Names under `frameworks/` use framework vocabulary only (no `platform`, `engine`, or `shell`).

---

This document is the **standard**. Moving the tree is separate work, done after this is settled.
