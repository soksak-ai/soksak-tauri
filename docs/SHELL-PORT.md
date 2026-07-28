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

## State that no longer assumes the app process

Three subsystems moved to injection. In each the meaning is unchanged — only where the value comes from.

- **The vault (`secrets.rs`)** had a silent wrong-answer generator. `vault_file()` fell back to `home::soksak_home()` when no path was injected, and that function answers `~/.soksak` even before `init` — so the fallback never fails. A `SecretsState` that forgot its path did not error; it pointed at the release user's vault. Moved into a helper it would create a vault in someone else's home. The fallback is gone; an unconfigured path fails by name, because unconfigured means there is no value, not that there is a default. The keychain service name had the same shape: a wrong service name is not a refusal but an attempt to open a different machine's KEK. Both now derive from `Identity`. Crypto primitives and the seal format were not touched.
- **The installer (`unit_installer.rs`)** takes an `Identity` instead of a bare home, and its five transaction entries are callable with `&UnitInstallManager` — no `State` required. The ledger's single-writer meaning is unchanged.
- **The ledger (`activity.rs`)** split into three: `admit` (append and stamp a sequence — pure), `fan_out` (windows and socket subscribers, via `WindowOracle`), `persist` (a `Connection`, nothing more). `publish` keeps its signature and return value and stacks the three, so all 22 call sites behave as before. A helper would admit and leave the fan-out to the shell.

`WindowOracle` gained `broadcast` for events with no addressee. The default walks every live window; Tauri overrides it with a single `emit`, because that one delivery also reaches child webviews and a label walk would silently reach fewer of them. A partial delivery is not reported as success.

## The child-process fleet

Terminals, processes, daemons, websockets, and services were the largest movable group — 32 handlers whose only window dependency was a label string. What had pinned them was `tauri::ipc::Channel`, and the stream-exit contract had already removed that.

- **Identity is a field, not an argument.** `Link` caches its control connection, and that connection was already made against one home's socket and token. Taking the home as a call argument makes "the cached connection is home A, this argument is home B" representable, and the reconnect path would then attach to B. The manager owns its identity because identity is a condition of its existence, not a parameter of a call.
- **Construction moved from the builder chain into `setup`.** `home::init` runs at the top of `setup`; the builder chain runs before it, so reading identity there picks up the `home.rs` fallback of `~/.soksak` — a dev build would aim at the release home's daemon.
- **An exit is not bytes.** `on_exit` carries one number, and `Channel<i32>` serializes it as a JSON number. Forcing it through the byte contract would change the payload the consumer receives, and that is a behaviour change wearing the clothes of a structural move. `ExitSink` sits beside `StreamSink` with the same shape — a departed consumer comes back as a value — and a different type.
- **The mediation origin left the shell adapter.** It is a stamp the core applies, not something a service reports about itself; inside an adapter a second shell would stamp it differently, and a differently stamped origin defeats the read-aloud exclusion.

One coupling was deliberately left. Seven of the eight `activity::publish` sites in `pty.rs` sit in functions that also use the handle for `state::<PtyManager>` / `state::<SecretsState>`. The remaining `AppHandle` there is held by those lookups, not by publishing; unpicking it means changing managed-state ownership, which is a behaviour change and belongs to its own pass.

## The remaining state

The last movable group: schedules, the command bridge, clipboard, watcher, and three registries.

- **A fifth contract.** `CommandDispatch` (`src-tauri/src/command_dispatch.rs`) covers calling one registry command and getting an answer. The scheduler only wants that, but the three functions providing it all take an `&AppHandle`, so the firing code held one too. None of the four existing contracts fit — forcing it into one would have made that contract moonlight, the same reason `ExitSink` sits beside `StreamSink` rather than inside it.
- **The dispatch contract knows nothing about windows.** Which window a command goes to stays with the fallback ladder in `ipc.rs`; the caller knows only the command and the answer. Putting routing here would fork the ladder per implementation.
- **Delivery collapsed to one point.** Two `emit_to` sites each duplicated sequence allocation, pending registration, and delivery. They are now one function — not to remove duplication, but so that "roll back the pending slot if delivery failed" is enforced in one place. A slot left behind waits for an answer that will never come.
- **The clipboard gave up the last handle-in-a-field.** `ClipboardState` was the only managed state holding an `AppHandle` directly; it used it to emit, and the watcher's existing `init`/`init_with` injection was already the shape for that. `lib.rs` did not change — `init` keeps its signature and only its body moved.
- **A ghost filter asks the oracle.** `project_owners` used `get_window(label).is_some()` to skip dead claims. What it needs is not a handle but whether a label is alive, which the contract already answers.

Two things were deliberately left. `native_reload` keeps its webview handle: a reload is neither a window fact nor a delivery, and folding it into the two-line oracle would put webview lifetime under it. `state::<T>()` lookups stay as they are — converting them means changing `manage` in `lib.rs` and every caller at once, and `service.rs` had already recorded the same judgement; a second convention for passing state would be worse than the coupling.

## The helper process

`src-tauri/crates/soksak-helper` is a process with no window, no webview, and no app handle. It listens on a unix socket and answers commands using `soksak-portable` logic. It follows `soksak-ptyd`, the standing precedent for an independent helper, with two deliberate differences.

- **It does not know its home.** `ptyd` reads `SOKSAK_HOME` and derives paths; the helper takes `--socket <path>` as an argument and, given none, fails by name rather than choosing a default. A helper that guesses its identity attaches somewhere else the moment homes diverge, and does it quietly.
- **Names and arguments are the app's.** The envelope follows the socket contract, and `data` carries exactly what the app's `invoke` returns. A shell that has to translate names introduces a new drift surface; the point is to ask the same question and get the same answer.

Each handler is one call into `soksak-portable`. Judgement does not live in the helper — if it did, the app path and the helper path could answer differently, and that difference is silent. Logic has a single owner, so the two processes agree structurally rather than by copy.

**A store is not a shell.** `rusqlite` is banned in `soksak-portable` and allowed in the helper. The ban list exists to keep out windows, webviews, and native runtimes; a database opens no window and holds no app handle, and reads the same file to the same answer from any process. But logic that knows the store only runs where the file is, and that premise is what the split removes — so the `KvRows` contract stays in portable and its SQLite implementation lives in the helper. The helper opens read-only: two processes writing the same file would break the single-writer contract.

**What the demand ledger taught.** The Electron shell records every backend call in order. Read by frequency, `activity_publish` (28) and `data_kv_get` (10) dominate; read *in order*, the boot stalls at call 5 (`app_environment`) and calls 7–14 (`data_kv_get`). Three commands wired first by frequency turned out to be calls 42, 48, and 50 — served, and irrelevant to whether the window paints. Frequency picks the wrong work; order picks the blocking work.

Still unserved: `activity_publish` (the shell owns fan-out, so where admission happens is a design question, not a port), `project_owners`, `net_http_request`, `process_reclaim_window`. And `webview_*`, `engine_*`, `titlebar_*`, `window_*` never move — those are the shell's, and an Electron adapter must implement them itself.

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
