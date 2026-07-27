# Shell port

How the app is decoupled from the desktop shell it runs on, and what a second shell costs. Facet of [ARCHITECTURE.md](ARCHITECTURE.md); Korean copy: [SHELL-PORT.ko.md](SHELL-PORT.ko.md). The English text is canonical.

The shell is the thing that owns the window, the webview, and the bridge to native code — Tauri today. It is an adapter, not a premise.

## The seam

`src/platform/host.ts` declares `ShellHost`. `src/platform/tauri.ts` implements it. `src/platform/index.ts` resolves the active adapter and re-exports named functions. Every other file imports from `../platform` and never learns which shell is underneath.

- **Only what is used.** The contract carries `invoke`, streams, global listen, the current/labelled window (logical and physical axes, theme, drag-drop), app, path, dialog, notification, deep link — because those are the capabilities the app actually calls. Declaring a capability nobody uses leaves a blank every adapter must fake, and fakes get filled by reaching around the seam.
- **Vendor defects are absorbed by the adapter.** Tauri's unlisten rejects a promise when a listener was already released; the contract says "release is idempotent", so the adapter swallows it and records why. Absorption belongs to the adapter — policy and state do not, because a policy that differs per shell is itself shell coupling.
- **The gate enforces it.** `src/platform/shellSeam.test.ts` fails if any file outside `src/platform/` imports a shell vendor. Tests obey the same rule: they mock `../platform`, never the vendor. A test that knows the vendor makes swapping the shell a test rewrite too.

Adding a shell is one adapter file plus one row in the resolution table. No app file changes.

## What a second shell actually costs

Measured on this repo (2026-07-27):

| Bucket | Size | Effect |
| --- | --- | --- |
| Standalone Rust crates (`soksak-ptyd`, `soksak-spec-*`, `soksak-seal`) | 5,686 lines | none — platform agnostic |
| Sidecars (browser, terminal engines, db-studio) | separate processes | none — socket protocol unchanged |
| Installed plugins | all | none — zero vendor imports |
| TS command registry | 10,909 lines | none — sits behind the seam |
| App code touching the shell | 1 adapter | the whole surface |
| `src-tauri/src` | 24,758 lines, 160 commands | 37 native commands are the hard part |

The deep coupling is not spread out; it is concentrated in the native surface layer — child webviews, the hit-test swizzle that lets a transparent DOM region pass the mouse to the native view beneath, and window capture that composites those native children. A shell without region-level hit-test passthrough cannot reproduce the hole contract as written, and a capture that only sees the page cannot drive the pixel oracles. That is the part to prototype first, not the part to assume.

## Spike shape

Run the browser through the offscreen CEF sidecar (frames streamed into an `<img>`) and leave native child webviews out of the first pass. That removes holes, swizzling, and composited capture from the critical path, and leaves the questions a spike should answer: command latency over the new bridge, terminal stream throughput, multi-window and focus parity, and what replaces pixel verification.

Because every capability is already exposed as a socket command, a second shell that speaks the same control plane inherits the existing e2e harnesses as its judge — pixel oracles excepted.
