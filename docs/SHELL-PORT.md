# Shell port

How the app is decoupled from the desktop shell it runs on, and what a second shell costs. Facet of [ARCHITECTURE.md](ARCHITECTURE.md); Korean copy: [SHELL-PORT.ko.md](SHELL-PORT.ko.md). The English text is canonical.

The shell is the thing that owns the window, the webview, and the bridge to native code — Tauri today. It is an adapter, not a premise.

## The seam

`src/platform/host.ts` declares `ShellHost`. `src/platform/tauri.ts` implements it. `src/platform/index.ts` resolves the active adapter and re-exports named functions. Every other file imports from `../platform` and never learns which shell is underneath.

- **Only what is used.** The contract carries `invoke`, streams, global listen, the current/labelled window (logical and physical axes, theme, drag-drop), app, path, dialog, notification, deep link — because those are the capabilities the app actually calls. Declaring a capability nobody uses leaves a blank every adapter must fake, and fakes get filled by reaching around the seam.
- **Vendor defects are absorbed by the adapter.** Tauri's unlisten rejects a promise when a listener was already released; the contract says "release is idempotent", so the adapter swallows it and records why. Absorption belongs to the adapter — policy and state do not, because a policy that differs per shell is itself shell coupling.
- **The gate enforces it.** `src/platform/shellSeam.test.ts` fails if any file outside `src/platform/` imports a shell vendor. Tests obey the same rule: they mock `../platform`, never the vendor. A test that knows the vendor makes swapping the shell a test rewrite too.

Adding a shell is one adapter file plus one row in the resolution table. No app file changes.

## The stream exit

The seam above covers the app side. The exit that high-volume output takes on its way out of the process is a second one, and it is what pinned native handlers in place.

A classification of all 160 native commands (2026-07-27) found that state ownership was not the bottleneck — most state is window-agnostic, or a label string is the key. The bottleneck is that webview IPC monopolises the streaming exit: `tauri::ipc::Channel` is a handle produced by deserialization inside the calling webview's IPC context, so it is not `Serialize`, cannot be reconstructed from a label, and does not cross a process boundary. While that type sits in a signature, its handler cannot leave the app process — 3 of the 7 handlers that a label alone would have moved were held by that and nothing else.

- **The contract is two lines.** `src-tauri/src/stream_sink.rs` declares `StreamSink::deliver(&self, bytes: Vec<u8>) -> Delivered`: hand over one batch, and if the consumer is gone report it as a value (`Delivered::Gone`). An exit that drops silently leaves the producing side reading forever. `impl StreamSink for tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>` in the same file is the current canonical implementation — one implementation per crossing.
- **The delivery-unit owner no longer names the vendor.** `spawn_delivery` in `src-tauri/src/pty_delivery.rs` is generic over `S: StreamSink`, and both PTY backends end at that one crossing — the in-process reader thread in `src-tauri/src/pty.rs` and the daemon relay `spawn_via_daemon`. The vendor type survives only at the `#[tauri::command]` entry (`spawn_terminal`), where the channel arrives from the caller and is handed in as the sink.
- **Backpressure is not in the contract.** The watermarks (`soksak_spec_pty::HIGH_WATERMARK` / `LOW_WATERMARK`) and the ack belong to the session: the reader thread counts unacked bytes and pauses at the high mark, `ack_terminal` subtracts and resumes at the low mark. That accounting is on bytes read, so it is the same whenever a batch actually leaves. An exit that also held backpressure would fork the policy per implementation, and a forked policy is an unbounded buffer.
- **The test is the proof.** `stream_sink.rs` implements a sink containing no Tauri type (`a_sink_needs_no_shell_type`, `a_departed_consumer_is_reported_not_swallowed`). That those compile is the statement that the exit is no longer a vendor type.

The PTY output crossing is the one converted so far. The other channel holders — process stdout/stderr and exit (`src-tauri/src/process.rs`), websocket message and close (`src-tauri/src/ws.rs`), sidecar events (`src-tauri/src/sidecar.rs`) — still name the vendor in their signatures, and the rule above applies to them unchanged.

## The other three seams

The same shape recurs. Each one takes a fact the shell owned and turns it into a value or a contract; each is enforced by a test that implements it without any vendor type — that those tests compile is the proof.

| Contract | File | What left the vendor |
| --- | --- | --- |
| `WindowOracle` | `src-tauri/src/window_oracle.rs` | Which windows are alive, and delivery to one by label |
| `ActivitySink` | `src-tauri/src/activity_sink.rs` | Publishing to the activity ledger |
| `Identity` | `src-tauri/src/identity.rs` | Which build this is and which home it uses |

- **`WindowOracle` states facts, not choices.** Which window to pick — the fallback ladder — stays with the caller. An oracle that also chose would fork the ladder per implementation, and a forked ladder is per-window routing. Delivery returns success as a value: swallowing a failed emit leaves the caller believing it sent and waiting forever for a reply.
- **`ActivitySink` exists because a function that only wants to write a ledger line was taking an `AppHandle`.** `activity::publish` pulls the hub out of managed state, emits to windows, and persists — three jobs behind one signature, at 22 call sites. Note what this did *not* unlock: an adversarial audit of all 160 native commands found that publish alone frees zero handlers, because every site that touches it also holds an `AppHandle` signature or a native object. It is a real coupling and a poor lever; both facts are worth keeping.
- **`Identity` carries home and identifier together.** They were read separately — `app_environment` read ambient state five times — which makes a mismatched pair ("A's home with B's identifier") representable, and no identity has that shape. `ambient()` is the near end of the seam: it reads the global once, and below it the value flows. `Identity::path` always lands under the home, because `Path::join` discards its base on an absolute argument and a contract that lies about containment becomes the reason a caller skips its own check.

The audit named the ambient home the single largest lever: 28 handlers touch it and breaking it frees 15. No other pattern frees any on its own.

## The portable crate

`src-tauri/crates/soksak-portable` holds command logic with no shell in it. Anything there gives the same answer in the app process or in a helper, which requires three things: it touches no window, app handle, or managed state; it reads no process environment, working directory, or executable path; and it does not treat its own compile target or build profile as evidence.

The third is the quiet one. A function whose answer changes with `cfg!(target_os)` is describing the binary it was compiled into, not answering what the caller asked. Platform branching belongs in an argument.

Modules so far: `udp` (datagram send and request/response), `integrity` (hash verification, install observation, whitelisted stale removal), `session` (agent session parsing and lookup), `pathx` (tilde expansion, project-root verdict). Core keeps `#[tauri::command]` wrappers that delegate and decide nothing — a decision in the wrapper is a decision the helper process would lose.

`tests/no_shell.rs` enforces this in two layers: a symbol scan for direct references, and `cargo tree` for anything a dependency dragged in. Each forbidden symbol carries the reason it blocks a move; a prohibition without a reason becomes something to route around.

Two further gates sit in core. `src-tauri/src/ambient_gate.rs` requires every `env::var` site to be registered with two answers — why it must be this process's environment, and what arrives instead once processes split; an empty answer fails, so the table cannot be used as a way through. It found three sites a manual sweep had missed. The registration gate in `src-tauri/src/lib.rs` checks that every registered handler has a body on every platform it compiles on, which the compiler only checks on the platform being built.

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
