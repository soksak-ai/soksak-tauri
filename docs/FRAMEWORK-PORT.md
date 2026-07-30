# Framework port

How the app is decoupled from the desktop framework it runs on, and what a second framework costs. Facet of [ARCHITECTURE.md](ARCHITECTURE.md); Korean copy: [FRAMEWORK-PORT.ko.md](FRAMEWORK-PORT.ko.md). The English text is canonical.

The framework is what gives the app its process model, window and webview creation, IPC, native API surface, and packaging — Tauri today. It is an adapter, not a premise.

This was once called the "shell." That word already belongs to the login shell (zsh, bash), and this repository handles PTY and terminals as core work, so the collision is real (`login_shell.rs`, `--login-shell`, `shell_which`). It is not `platform` either — that is the OS (macOS, Linux, Windows).

## Why two of them

The point is not to leave Tauri. It is to keep **both**, because what one cannot do the other can.

Tauri uses the OS webview — WKWebView on macOS, WebKitGTK on Linux. Thin, light, and the only candidate that reaches mobile ([multiplatform-engine-strategy.md](multiplatform-engine-strategy.md) §3). In exchange the content surface is **bound to that engine**: a site WKWebView cannot render, the app cannot render either. That is why the Chromium sidecar exists, and the sidecar dragged in a macOS-only subsystem — hole punching, hitTest swizzling, composited capture.

Electron is Chromium all the way down. The content problem does not exist **by definition** — what a browser does, the app does. In exchange it is heavy, has no mobile story, and cannot link Rust.

So the two are not competitors. They are two axes with different answers.

| | Tauri | Electron |
| --- | --- | --- |
| Engine | OS webview (macOS WKWebView · Win WebView2 · Linux WebKitGTK) | Chromium, fixed |
| Content grade | Varies per OS — macOS and Linux fall short | Always met |
| Rust backend | Linked directly | Impossible — talks over a socket (cored) |
| Bundle | Small | Large |
| Mobile | iOS/Android, first class | None |
| Child content | Native child webview | `<webview>` inside the DOM |
| Overlap (modals, indicators) | Z-order inversion + transparent holes + hitTest swizzle | **z-index** — no problem to solve |
| Window capture | OS compositor composites children in | Page capture suffices |

### What each characteristic solves for the other

The hard part of each axis disappears on the other. That is the practical reason to keep both.

| Problem | Tauri's answer | On Electron |
| --- | --- | --- |
| Sites WKWebView cannot render | Promote the surface to a Chromium sidecar | **Dissolves** — the framework is Chromium |
| Drawing modals above the browser | Holes + hitTest swizzle (macOS only) | **Dissolves** — `<webview>` is an HTMLElement, so z-index |
| Pixel verification | Capture plugin that composites children | `capturePage` |
| Reusing Rust logic | Linked into the same process | cored socket — same names, args, envelope |
| Mobile | The same code travels | Attaches as a remote web client |

What Electron pays instead: bundle weight, process count, and a socket round trip whenever it wants to **call** Rust.

Two things confirmed by measurement, not by claim:

- `<webview>` extends `HTMLElement` (`electron.d.ts`), and DOM placed over it **draws on top** — sampled from an offscreen capture (`scripts/electron/overlay-stacking.test.mjs`). The situation that needs holes and swizzles never arises.
- Conversely, imitating the Tauri model with `WebContentsView` gets stuck: `View` exposes no per-view hit delegation, and `setIgnoreMouseEvents` lives on the window (`scripts/electron/layer-model.test.mjs`). That reads as **do not imitate it**, not as *Electron cannot*.

### Plugins do not know the framework

What a surface requires is not a framework but an **engine grade**. So the manifest declares the need, not the vendor (`packages/plugin-spec/src/engineNeeds.ts`).

```
requiresEngine: "chromium"
  Tauri × macOS    → WKWebView falls short → promote to a sidecar
  Tauri × Windows  → WebView2 is Chromium → promotion is a no-op
  Electron × any   → the framework is Chromium → promotion is a no-op
```

Naming the vendor produces the wrong answer. astryx was the first surface promoted to Chromium because it does not work under macOS WKWebView; writing that as "exclude Electron" would **hide the thing that runs better on Electron.** Electron does not meet fewer requirements — it meets more. The axis runs the other way.

Provision is what each adapter states as its own fact.

| | `chromium` | `nativeChildWebview` |
| --- | --- | --- |
| Tauri | `false` | `true` |
| Electron | `true` | `false` |

Electron's `false` does not mean it cannot. In a single Chromium world one compositor composites UI and content, so the mechanism is **unnecessary**. Only surfaces that assume that mechanism drop out; surfaces that need the grade alone simply stand, with no sidecar.

## Three axes, three words

When one axis carries three words, every reader has to ask which meaning is in play. Here they name different things.

| Word | What it names | Values |
| --- | --- | --- |
| **framework** | What hosts the app — windows, IPC, native API, packaging | Tauri · Electron |
| **platform** | The operating system | macOS · Linux · Windows |
| **engine** | What draws the web | WKWebView · Chromium · WebKitGTK |
| **shell** | The command interpreter | zsh · bash |

`src/platform/` once held the framework adapter. Everything inside it said "shell" while only the folder said `platform` — not a settled convention but a single name out of step, and every argument built on it was legacy followed as if it were principle. It is `src/framework/` now.

## The seam

`src/framework/contract.ts` declares `AppFramework`. `src/framework/tauri.ts` implements it. `src/framework/index.ts` resolves the active adapter and re-exports named functions. Every other file imports from `../platform` and never learns which framework is underneath.

- **Only what is used.** The contract carries `invoke`, streams, global listen, the current/labelled window (logical and physical axes, theme, drag-drop), app, path, dialog, notification, deep link — because those are the capabilities the app actually calls. Declaring a capability nobody uses leaves a blank every adapter must fake, and fakes get filled by reaching around the seam.
- **Vendor defects are absorbed by the adapter.** Tauri's unlisten rejects a promise when a listener was already released; the contract says "release is idempotent", so the adapter swallows it and records why. Absorption belongs to the adapter — policy and state do not, because a policy that differs per framework is itself framework coupling.
- **The gate enforces it.** `src/framework/frameworkSeam.test.ts` fails if any file outside `src/framework/` imports a framework vendor. Tests obey the same rule: they mock `../platform`, never the vendor. A test that knows the vendor makes swapping the framework a test rewrite too.

Adding a framework is one adapter file plus one row in the resolution table. No app file changes.

## The stream exit

The seam above covers the app side. The exit that high-volume output takes on its way out of the process is a second one, and it is what pinned native handlers in place.

A classification of the whole native command surface (2026-07-27) found that state ownership was not the bottleneck — most state is window-agnostic, or a label string is the key. The bottleneck is that webview IPC monopolises the streaming exit: `tauri::ipc::Channel` is a handle produced by deserialization inside the calling webview's IPC context, so it is not `Serialize`, cannot be reconstructed from a label, and does not cross a process boundary. While that type sits in a signature, its handler cannot leave the app process — 3 of the 7 handlers that a label alone would have moved were held by that and nothing else.

- **The contract is two lines.** `frameworks/tauri/src/stream_sink.rs` declares `StreamSink::deliver(&self, bytes: Vec<u8>) -> Delivered`: hand over one batch, and if the consumer is gone report it as a value (`Delivered::Gone`). An exit that drops silently leaves the producing side reading forever. `impl StreamSink for tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>` in the same file is the current canonical implementation — one implementation per crossing.
- **The delivery-unit owner no longer names the vendor.** `spawn_delivery` in `frameworks/tauri/src/pty_delivery.rs` is generic over `S: StreamSink`, and both PTY backends end at that one crossing — the in-process reader thread in `frameworks/tauri/src/pty.rs` and the daemon relay `spawn_via_daemon`. The vendor type survives only at the `#[tauri::command]` entry (`spawn_terminal`), where the channel arrives from the caller and is handed in as the sink.
- **Backpressure is not in the contract.** The watermarks (`soksak_spec_pty::HIGH_WATERMARK` / `LOW_WATERMARK`) and the ack belong to the session: the reader thread counts unacked bytes and pauses at the high mark, `ack_terminal` subtracts and resumes at the low mark. That accounting is on bytes read, so it is the same whenever a batch actually leaves. An exit that also held backpressure would fork the policy per implementation, and a forked policy is an unbounded buffer.
- **The test is the proof.** `stream_sink.rs` implements a sink containing no Tauri type (`a_sink_needs_no_shell_type`, `a_departed_consumer_is_reported_not_swallowed`). That those compile is the statement that the exit is no longer a vendor type.

The PTY output crossing is the one converted so far. The other channel holders — process stdout/stderr and exit (`frameworks/tauri/src/process.rs`), websocket message and close (`frameworks/tauri/src/ws.rs`), sidecar events (`frameworks/tauri/src/sidecar.rs`) — still name the vendor in their signatures, and the rule above applies to them unchanged.

## The other three seams

The same shape recurs. Each one takes a fact the framework owned and turns it into a value or a contract; each is enforced by a test that implements it without any vendor type — that those tests compile is the proof.

| Contract | File | What left the vendor |
| --- | --- | --- |
| `WindowOracle` | `frameworks/tauri/src/window_oracle.rs` | Which windows are alive, and delivery to one by label |
| `ActivitySink` | `frameworks/tauri/src/activity_sink.rs` | Publishing to the activity ledger |
| `Identity` | `frameworks/tauri/src/identity.rs` | Which build this is and which home it uses |

- **`WindowOracle` states facts, not choices.** Which window to pick — the fallback ladder — stays with the caller. An oracle that also chose would fork the ladder per implementation, and a forked ladder is per-window routing. Delivery returns success as a value: swallowing a failed emit leaves the caller believing it sent and waiting forever for a reply.
- **`ActivitySink` exists because a function that only wants to write a ledger line was taking an `AppHandle`.** `activity::publish` pulls the hub out of managed state, emits to windows, and persists — three jobs behind one signature, at 22 call sites. Note what this did *not* unlock: an adversarial audit of the whole native surface found that publish alone frees zero handlers, because every site that touches it also holds an `AppHandle` signature or a native object. It is a real coupling and a poor lever; both facts are worth keeping.
- **`Identity` carries home and identifier together.** They were read separately — `app_environment` read ambient state five times — which makes a mismatched pair ("A's home with B's identifier") representable, and no identity has that shape. `ambient()` is the near end of the seam: it reads the global once, and below it the value flows. `Identity::path` always lands under the home, because `Path::join` discards its base on an absolute argument and a contract that lies about containment becomes the reason a caller skips its own check.

The audit named the ambient home the single largest lever: 28 handlers touch it and breaking it frees 15. No other pattern frees any on its own.

## The core crate

`crates/soksak-core` holds command logic with no framework in it. Anything there gives the same answer in the app process or in cored, which requires three things: it touches no window, app handle, or managed state; it reads no process environment, working directory, or executable path; and it does not treat its own compile target or build profile as evidence.

The third is the quiet one. A function whose answer changes with `cfg!(target_os)` is describing the binary it was compiled into, not answering what the caller asked. Platform branching belongs in an argument.

**The name states what it is, not what it is not.** The crate is called core because both processes call this logic their own and neither answers a single command without it. A name built on the negative ("not tied to a framework") describes the boundary instead of the thing, and a boundary name goes stale the moment the boundary moves.

Modules: `activity`, `identity`, `integrity`, `kv`, `pathx`, `plugin_dir`, `session`, `themes`, `udp`, `unit_dev` — the list is declared in `crates/soksak-core/src/lib.rs`. Core keeps `#[tauri::command]` wrappers that delegate and decide nothing — a decision in the wrapper is a decision cored would lose.

**An absent directory is an empty list; an unreadable one is an error.** `plugin_dir::scan` and `themes::scan` used to treat both as failure, on the rule that "nothing installed" and "could not read the directory" must not collapse into one answer. That rule stands — only the line moved: `read_dir_or_empty` in each module splits `ErrorKind::NotFound` off as the empty case and lets permission denied or not-a-directory keep failing with a reason.

The split is needed because the two processes own the home differently. The app runs `create_dir_all` over its own home layout before it scans, so it never meets absence. cored only reads someone else's home and carries no such side effect — a read command does not create disk — so on a fresh home it meets absence immediately. Raising an error there made one command name answer differently per process (live measurement 2026-07-28: app `[]`, cored `os error 2`), which is exactly what the core crate exists to prevent. Two tests hold both halves at once, so the empty case cannot be widened into swallowing a real read failure.

`tests/no_framework.rs` enforces this in two layers: a symbol scan for direct references, and `cargo tree` for anything a dependency dragged in. Each forbidden symbol carries the reason it blocks a move; a prohibition without a reason becomes something to route around.

Two further gates sit in core. `crates/soksak-core/src/ambient_gate.rs` requires every environment read to be registered with two answers — why it must be this process's environment, and what arrives instead once processes split; an empty answer fails, so the table cannot be used as a way through. It found three sites a manual sweep had missed. The rule takes its scan roots as arguments and `crates/soksak-core/tests/ambient_gate.rs` feeds it every directory under `frameworks/`, so a rule that once lived under one framework's name now judges both — and the login-shell reader is counted per framework, because two processes each legitimately read it once. The registration gate in `frameworks/tauri/src/lib.rs` checks that every registered handler has a body on every platform it compiles on, which the compiler only checks on the platform being built.

## State that no longer assumes the app process

Three subsystems moved to injection. In each the meaning is unchanged — only where the value comes from.

- **The vault (`secrets.rs`)** had a silent wrong-answer generator. `vault_file()` fell back to `home::soksak_home()` when no path was injected, and that function answers `~/.soksak` even before `init` — so the fallback never fails. A `SecretsState` that forgot its path did not error; it pointed at the release user's vault. Moved into cored it would create a vault in someone else's home. The fallback is gone; an unconfigured path fails by name, because unconfigured means there is no value, not that there is a default. The keychain service name had the same shape: a wrong service name is not a refusal but an attempt to open a different machine's KEK. Both now derive from `Identity`. Crypto primitives and the seal format were not touched.

**Boot does not open the vault.** The setup tail used to call `is_unlocked()` — a "transparent open attempt" that reached the OS keychain, and an OS keychain fetch can raise a synchronous modal. Before a single window appears, the process waits for a human hand; every automated run stopped there.

Boot has nothing to open. Whoever actually needs a sealed value acquires the key — this is not deferred acquisition, it is that boot never had the requirement. `secrets::boot_wire` plants the path, the `expect_vault` flag, the KEK source and the announcement channel, and stops.

That also sharpened what `secrets-ready` means: not "boot went by" but "the vault just opened". Calling a locked vault ready sends the drain around empty and restarts services for nothing; if it never opens, the event never fires. `boot_wiring_never_touches_the_keychain` counts the touches — zero after boot, one at first use, none on reuse.
- **The installer (`unit_installer.rs`)** takes an `Identity` instead of a bare home, and its five transaction entries are callable with `&UnitInstallManager` — no `State` required. The ledger's single-writer meaning is unchanged.
- **The ledger (`activity.rs`)** split into three: `admit` (append and stamp a sequence — pure), `fan_out` (windows and socket subscribers, via `WindowOracle`), `persist` (a `Connection`, nothing more). `publish` keeps its signature and return value and stacks the three, so all 22 call sites behave as before. cored admits and leaves the fan-out to the framework.

`WindowOracle` gained `broadcast` for events with no addressee. The default walks every live window; Tauri overrides it with a single `emit`, because that one delivery also reaches child webviews and a label walk would silently reach fewer of them. A partial delivery is not reported as success.

## The child-process fleet

Terminals, processes, daemons, websockets, and services were the largest movable group — 32 handlers whose only window dependency was a label string. What had pinned them was `tauri::ipc::Channel`, and the stream-exit contract had already removed that.

- **Identity is a field, not an argument.** `Link` caches its control connection, and that connection was already made against one home's socket and token. Taking the home as a call argument makes "the cached connection is home A, this argument is home B" representable, and the reconnect path would then attach to B. The manager owns its identity because identity is a condition of its existence, not a parameter of a call.
- **Construction moved from the builder chain into `setup`.** `home::init` runs at the top of `setup`; the builder chain runs before it, so reading identity there picks up the `home.rs` fallback of `~/.soksak` — a dev build would aim at the release home's daemon.
- **An exit is not bytes.** `on_exit` carries one number, and `Channel<i32>` serializes it as a JSON number. Forcing it through the byte contract would change the payload the consumer receives, and that is a behaviour change wearing the clothes of a structural move. `ExitSink` sits beside `StreamSink` with the same shape — a departed consumer comes back as a value — and a different type.
- **The mediation origin left the framework adapter.** It is a stamp the core applies, not something a service reports about itself; inside an adapter a second framework would stamp it differently, and a differently stamped origin defeats the read-aloud exclusion.

One coupling was deliberately left. Seven of the eight `activity::publish` sites in `pty.rs` sit in functions that also use the handle for `state::<PtyManager>` / `state::<SecretsState>`. The remaining `AppHandle` there is held by those lookups, not by publishing; unpicking it means changing managed-state ownership, which is a behaviour change and belongs to its own pass.

## The remaining state

The last movable group: schedules, the command bridge, clipboard, watcher, and three registries.

- **A fifth contract.** `CommandDispatch` (`frameworks/tauri/src/command_dispatch.rs`) covers calling one registry command and getting an answer. The scheduler only wants that, but the three functions providing it all take an `&AppHandle`, so the firing code held one too. None of the four existing contracts fit — forcing it into one would have made that contract moonlight, the same reason `ExitSink` sits beside `StreamSink` rather than inside it.
- **The dispatch contract knows nothing about windows.** Which window a command goes to stays with the fallback ladder in `ipc.rs`; the caller knows only the command and the answer. Putting routing here would fork the ladder per implementation.
- **Delivery collapsed to one point.** Two `emit_to` sites each duplicated sequence allocation, pending registration, and delivery. They are now one function — not to remove duplication, but so that "roll back the pending slot if delivery failed" is enforced in one place. A slot left behind waits for an answer that will never come.
- **The clipboard gave up the last handle-in-a-field.** `ClipboardState` was the only managed state holding an `AppHandle` directly; it used it to emit, and the watcher's existing `init`/`init_with` injection was already the shape for that. `lib.rs` did not change — `init` keeps its signature and only its body moved.
- **A ghost filter asks the oracle.** `project_owners` used `get_window(label).is_some()` to skip dead claims. What it needs is not a handle but whether a label is alive, which the contract already answers.

Two things were deliberately left. `native_reload` keeps its webview handle: a reload is neither a window fact nor a delivery, and folding it into the two-line oracle would put webview lifetime under it. `state::<T>()` lookups stay as they are — converting them means changing `manage` in `lib.rs` and every caller at once, and `service.rs` had already recorded the same judgement; a second convention for passing state would be worse than the coupling.

## The cored process

`crates/soksak-cored` is a process with no window, no webview, and no app handle. It listens on a unix socket and answers commands using `soksak-core` logic. It follows `soksak-ptyd`, the standing precedent for an independent daemon, with two deliberate differences.

**The name says what it is: core, running as a daemon.** It is the backend — the only one.

```
sok CLI            ──socket──┐
Tauri framework    ──socket──┼──> soksak-cored   (= soksak-core with a socket on it)
Electron framework ──socket──┘
headless           = cored, with no framework at all
```

This reverses an earlier rule, and the reversal is the point. That rule read: *"Not a bridge — the Tauri framework never talks to it. It links `soksak-core` directly and calls functions in its own process; a socket between them would be a round trip to itself."* Every word of that was true **while only one app ran at a time**. That premise is gone. Two frameworks now run against one home, and the moment they do, "the app is also a backend" stops being free:

- The store is single-writer by construction (`soksak_core::store_lock`). Two backend processes over one home means two writers, and SQLite does not stop them — it serialises them, which is exactly the silent case the lock exists to make loud.
- The same duplication shows up seven more times: two `seq` allocators writing one ledger row, a `data-change` notification that never leaves its own process, a project-claim ledger held in process memory (breaking P6 across frameworks), and fixed temp names in the install staging, service ledger, and backup ring.

None of those are seven problems. They are one problem seen seven times: **the rules had two implementations.** Measured — cored calls into `soksak_core` 68 times and is thin wiring over it; the Tauri app's `data/` layer spans 3132 lines and calls the shared crates 14 times in total. One is a backend seam; the other is a second copy.

So the line is drawn by **purpose**, and the code already states it — `crates/soksak-cored/tests/no_framework.rs` bans `tauri`, `wry`, `tao`, `objc2`, `block2`, `libloading`, `clipboard-rs`, `x11rb`, `windows-sys`, `tokio`, `interprocess`, `portable-pty`:

| | owns |
| --- | --- |
| **core** (cored) | rules, the store, ledgers, files, processes — cored already spawns (`registry.rs`, ptyd's `ensure_daemon`) |
| **front** (a framework) | windows, webviews, OS surfaces, native crates — and hosting delivery for commands whose *body* is a window |

Two frontends over one core is not a cost to be minimised; it is what keeps the seam a contract rather than a habit. Each is the other's oracle, and much of what this port found was found precisely because Electron could not do what Tauri did silently.

`soksak-cored` is a library as well as a binary, so "the backend" is a **role**: the process that builds a `Ctx`, claims the write lock, and serves `wire::answer`. Linking it without building a `Ctx` gives you nothing to call; building your own `Ctx` makes you a second writer. cored holds the role for determinism, not capability — choosing the host per boot would make the topology depend on start order.

- **It derives no identity of its own.** `ptyd` reads `SOKSAK_HOME` and derives paths; cored takes `--socket`, `--home`, and `--identifier` as arguments and, given none, fails by name rather than choosing a default. A daemon that guesses its identity attaches somewhere else the moment homes diverge, and does it quietly.
- **`--data-dir` is optional because relocation is the spawner's secret.** The store is normally derived from the home, but the app moves it in debug builds. Only whoever moved it knows, so whoever spawns cored passes it. cored deriving by rule alone would open a different file than the app, and that wrong answer arrives as an empty result rather than an error.
- **Names and arguments are the app's.** The envelope follows the socket contract, and `data` carries exactly what the app's `invoke` returns. A framework that has to translate names introduces a new drift surface; the point is to ask the same question and get the same answer.
- **The table answers for itself.** `cored.commands` returns `{ commands, unserved }` — what it serves with each argument's name, type and whether it is required, and what it does not serve with a `blockedBy` reason. A framework author who only gets `UNKNOWN_COMMAND` cannot tell "not moved yet" from "cannot be done here", and re-investigates the blocked thing or, worse, imitates it without investigating.

Each handler is one call into `soksak-core`. Judgement does not live in cored — if it did, the app path and the cored path could answer differently, and that difference is silent. Logic has a single owner, so the two processes agree structurally rather than by copy.

**A store is not a framework.** `rusqlite` is banned in `soksak-core` and allowed in cored. The ban list exists to keep out windows, webviews, and native runtimes; a database opens no window and holds no app handle, and reads the same file to the same answer from any process. But logic that knows the store only runs where the file is, and that premise is what the split removes — so the `KvRows` and `KvWrite` contracts stay in the core crate, along with the SQL itself (`SELECT_SQL`, `UPSERT_SQL`), and only the connection lives in cored. Two processes each writing their own statement would drift, and a drifted query is not an error — it is a different answer.

**Writing requires proving you are alone.** Single-writer was, until now, an argument about code layout: the app process holds one connection and a `Mutex` serialises it, so `unchecked_transaction` is safe. That argument holds only while there is one process. A second one opening the same file is not stopped by SQLite — it is merely serialised, and the premise quietly disappears.

So the premise becomes a value. `soksak_core::store_lock` takes an advisory lock beside the store (`soksak.db.writelock`); a process that fails to take it does not write. The kernel holds the lock against a file descriptor, so process death releases it — the stale-lock recovery that every PID-file scheme needs does not exist here. Reads are not locked: WAL is concurrent-read, single-write, and this lock guards only the write. Being unable to write and being unable to see are different facts.

cored claims the lock once at boot. Holding it, it serves `data_kv_set`; without it, that command is refused by name — the refusal names the store, because a silent write is exactly what the lock exists to prevent.

**One write is deliberately outside the lock: the activity ledger.** `activity_publish` persists its row (`crates/soksak-cored/src/ledger.rs`, `persist`) whether or not this process owns writes. That is a choice, not an oversight. Admitting without persisting is what the ledger used to do, and the measurement was 24 successful publishes against 0 rows in `records` — every answer was a success, and the absence only showed up as "nothing ever happened" on the next boot. Gating this path on the lock brings that silence back verbatim; refusing loudly instead would make the framework's fan-out half fail on a store it can read. So the cost is stated rather than hidden: in a topology where the app holds the lock and cored also runs, both processes write `records`. `crates/soksak-cored/tests/writes_outside_the_lock.rs` pins both halves — the guarded write is refused, the ledger write leaves a row — so neither can move without a failing test.

**What the demand ledger taught.** The Electron framework records every backend call in order. Read by frequency, `activity_publish` (28) and `data_kv_get` (10) dominate; read *in order*, the boot stalls at call 5 (`app_environment`) and calls 7–14 (`data_kv_get`). Three commands wired first by frequency turned out to be calls 42, 48, and 50 — served, and irrelevant to whether the window paints. Frequency picks the wrong work; order picks the blocking work.

**Arguments are the caller's; state is the process's.** A command served by cored must have the *same argument shape* as the app command of the same name. The UI does not know which process answers it: `invoke("app_environment")` is one call whether the app or cored replies.

The first version of cored broke this. Reasoning that "cored must not guess its identity", it demanded `identifier`, `home`, `dbPath`, `dir`, and `base` as per-call arguments — but the app commands of those names take **no arguments at all**, because those values are process state, not something a caller carries. Live measurement (Electron boot, 168 recorded calls) showed all five supposedly-served commands rejected with `INVALID_PARAMS`, and the rejection was one line in a framework log, so it was silent.

The premise was right and the conclusion was wrong: **receiving is not guessing.** The app does not guess its identity either — it receives it at boot from its framework config. cored receives it at boot from whoever spawned it. So the rule is two lines:

- values a caller sends are arguments (`ns`, `key`, `host`, `port`)
- values a process holds are boot state (identity, home, store path)

`frameworks/tauri/src/cored_shape_gate.rs` enforces this: it parses every `#[tauri::command]` signature in the app, drops framework-injected parameters (`State`, `AppHandle`, `Window`, `Channel`), and compares the argument-name set against cored's serving table for every name they share. Three planted violations — an extra argument, a dropped one, a renamed one — prove the gate catches drift rather than merely passing.

The socket test carries the same lesson: it now spawns cored against a fixture home, so argument-less commands are exercised *from outside the process*. The in-process tests could only ever prove "arguments are read as declared"; they could not see that the declaration itself disagreed with the app.

`activity_publish` is served: cored admits the entry, persists it, and returns it stamped. Only fan-out is split off — that needs windows and this process has none, so the framework does that half. The split is in the answer, not in a second copy of the rule.

Still unserved, each with what blocks it recorded beside its name in `crates/soksak-cored/src/registry.rs`: `project_owners` (the claim ledger is mutable state in the app process, and a ledger whose lifetime became cored's would keep dead windows' claims across a framework restart), `net_http_request` (the one transport drags in `tokio`, which this process's own gate blocks by name, and secret substitution reads the vault the app opened), `process_reclaim_window` (the handles to reclaim belong to whoever spawned the children; cored would always answer zero, and that zero is indistinguishable from "nothing to reclaim"). And `webview_*`, `engine_*`, `titlebar_*`, `window_*` never move — those are the framework's, and an Electron adapter must implement them itself.

## The framework stands up cored

The Electron framework no longer waits for a socket someone else prepared. It spawns its own backend (`frameworks/electron/cored.cjs`) and hands it the identity at boot.

- **The home is the framework's; cored is told.** The framework derives its home from its identifier alone — `app` gets `~/.soksak`, anything else gets the `-<last segment>` suffix — and passes it down as `--home` and `--identifier`. There is no runtime switch that swaps the home out: what gets pointed at is the identifier, and the home is the consequence.
- **The socket is `<home>/cored.sock`, not the app's name.** The app of that home binds `<home>/<identifier>.sock`. Taking that name would leave cored sitting where the app must bind, and the app would be turned away as "another instance already running" — a backend that works by making its own app unlaunchable. Keeping the name short also matters: unix socket paths have an OS length limit, and a deep tree crosses it silently.
- **An external socket is attached to, never reaped.** When `SOKSAK_SOCKET` (or `--soksak-socket=`) names one, that socket is someone else's: the framework connects and neither spawns nor stops anything. Only a cored the framework spawned itself is stopped on the way out. The same rule covers a cored that was already alive — it is adopted, and adopted is not owned.
- **The binary is never guessed.** A declared path (`SOKSAK_CORED_BIN` or `--soksak-cored=`) wins and, if it is not there, fails instead of falling through to discovery — falling through runs something other than what was named. With nothing declared, the repo's `debug` then `release` build locations are tried, and if neither holds it the failure names every place it looked. Spawning a made-up path leaves `ENOENT` as the only trace and loses what was searched for.
- **Readiness is cored's first stdout line, and that line must name the socket.** The framework blocks on that read rather than watching for the socket file to appear: a file existing is not a completed bind, and a blocking read surfaces a cored that died first as an immediate EOF. A readiness line naming a different socket fails too — it means what was launched is not this cored, or attached elsewhere, and both would otherwise pass as connected.
- **Nothing is left holding the socket.** Past the timeout the framework reaps the process it started before reporting, so the reason is the real one and no orphan keeps the path. cored has the matching half: if something already serves that path it withdraws rather than unlinking a live socket, and the framework confirms the path really is served before adopting it.

**Tauri now does the same** (`frameworks/tauri/src/cored_host.rs`). It probes the seat, adopts a live cored or spawns one with the identity it already holds, and then registers its windows over that connection with `control_host_attach` — cored has no window, so a command that arrives from outside reaches a screen only because a window owner made itself the delivery route. Until this, the call count from Tauri was zero, and the absence showed up only as `NO_HOST` at whoever called.

- **The seat is derived once, in the core** (`soksak_core::identity::cored_socket`). Both frameworks resolve `<home>/cored.sock` through that one rule; a second spelling drifts and the drift reads as "connection refused".
- **The seat carries no framework axis.** One home has one cored and many window owners. Splitting the seat per framework would stand one backend per framework, and the single-writer premise for the store would be gone without anything failing.
- **The app's own socket still stands.** This step attaches; it does not merge sockets. Withdrawing the app's bind has to overturn the `ipc_socket_path` contract and the oracle that pins it (`crates/soksak-cored/tests/serves_over_socket.rs`) in the same commit, and doing it here would leave a middle state where a harness aimed at the app loses its address.
- **Delivery does not re-pick the window.** cored resolved the target with the core's rule; `ipc::request_in_window` runs it in exactly that window. Picking again would make the targeting rule exist twice, and two copies stay quiet until they diverge — after which a command runs in a window the user is not looking at and answers success.
- **A label two frameworks claim is refused, not chosen.** Window restore reuses the stored `w-<uuid>`, and `main` is spelled the same by both, so a shared home makes collisions inevitable. cored answers `AMBIGUOUS_HOST` and delivers to neither; that label is also the PTY reattach key, so a quiet choice would reach someone else's shell.

`frameworks/tauri/tests/attaches_to_cored.rs` drives this over a real socket with the window facts and the executor injected, so it is exercised without a GUI: attach, delivery, the reply paired back by delivery id, a window that appears, a window that dies, the refused label, and a broadcast.

Fan-out is the framework's half of publishing (`frameworks/electron/activity.cjs`). cored admits and returns the stamped entry; the framework pushes it to every live window. Skipping that would starve `listen("activity")` subscribers without a single error line, because the front end discards the return value. An answer that is not a stamped entry is refused by name rather than pushed — pushing the wrong shape desynchronises subscribers silently, and reporting success would claim a delivery that never happened.

Neither file requires `electron`. Code that can only be exercised by launching a framework is in practice not exercised, so both are driven directly by `scripts/electron/cored-spawn.test.mjs` and `scripts/electron/framework-activity.test.mjs`.

## How the command surface divides

The port question for any one app command is not "what does it do" but **what is it holding a framework object for**. That axis splits the surface three ways:

- **A — held by an attribute only.** The handler touches the framework for one fact: an ambient home read, a window label used as a key. Turning that attribute into a value frees the handler; nothing about its logic has to change.
- **B — genuinely the window's.** Child webviews, engines, titlebars, windows. These never move. A second framework implements them itself, and that is the whole of what a second framework owes.
- **C — the `AppHandle` is there for managed state and for publishing.** `state::<T>()` lookups and `activity::publish` sit in the same functions. Unpicking these means changing who owns managed state, which is a behaviour change and belongs to its own pass rather than to a port.

The counts are deliberately not written here. They move with every commit, and a number frozen into prose goes stale without anything failing, while the reader that produced it stays right. Read the surface from `#[tauri::command]` signatures under `frameworks/tauri/src`, from the registration list in `frameworks/tauri/src/lib.rs` (`generate_handler!`), and from `cored_shape_gate::app_commands()`, which already parses those signatures into caller-argument sets for the shape gate.

Bucket B is why the cost below concentrates where it does, and bucket C is why `ActivitySink` was a real coupling and a poor lever at the same time.

## What a second framework actually costs

Measured on this repo (2026-07-27):

| Bucket | Size | Effect |
| --- | --- | --- |
| Standalone Rust crates (`soksak-ptyd`, `soksak-spec-*`, `soksak-seal`) | 5,686 lines | none — platform agnostic |
| Sidecars (browser, terminal engines, db-studio) | separate processes | none — socket protocol unchanged |
| Installed plugins | all | none — zero vendor imports |
| TS command registry | 10,909 lines | none — sits behind the seam |
| App code touching the framework | 1 adapter | the whole surface |
| `frameworks/tauri/src` | the whole native surface | bucket B is the hard part |

The line counts are that date's measurement. The command surface is not frozen into a number here for the reason given above — read it from the source.

The deep coupling is not spread out; it is concentrated in the native surface layer — child webviews, the hit-test swizzle that lets a transparent DOM region pass the mouse to the native view beneath, and window capture that composites those native children. A framework without region-level hit-test passthrough cannot reproduce the hole contract as written, and a capture that only sees the page cannot drive the pixel oracles. That is the part to prototype first, not the part to assume.

## Spike shape

The first version read: "run the browser only as an offscreen CEF sidecar (frame stream → `<img>`) and leave native child webviews out of the first pass."

**On Electron none of that is needed.** The CEF sidecar exists to draw what WKWebView cannot, and Electron is Chromium all the way down, so the problem does not exist. Content lives inside the page as `<webview>` — the process is still separate (crash isolation intact), the control surface is all there (`loadURL`, `goBack`, `goForward`, `canGoBack`, `reload`, `stop`, `setZoomLevel`, `executeJavaScript`, `openDevTools`, `getURL`, `getTitle`, `insertCSS`, `capturePage`, `printToPDF`), and overlap is z-index.

So what leaves the critical path is not just holes, swizzles, and composited capture, but **the sidecar itself**. With no frame encode, transfer, and decode, that performance question disappears with it.

Three questions remain: command latency across the new bridge, terminal stream throughput, and multi-window and focus equivalence.

Every feature is already exposed as a socket command, so a second framework speaking the same control plane **inherits the existing e2e harness as its judge.**

The pixel oracle is not an exception either. It was an adapter item all along — capture already lives in its own plugin (`tauri-plugin-webview-capture`) with per-OS files, and the only thing missing is that the capability is not in the `AppFramework` contract. Put it there and it behaves like every other capability. On Electron the implementation is `capturePage`.

## One socket is the control plane

A command arriving from outside — a harness, `sok`, an agent — has to reach a window. cored has no window, so it cannot execute those commands; but it is the only thing listening on a socket that a Node framework can reach.

So the socket became one surface with two answers. cored answers what it serves; everything else it **pushes to the window host**, and the framework delivers it. The caller does not need to know which happens, and the envelope is the same either way.

- **The target rule is core's** (`soksak_core::control::resolve_target`). Focused window → `main` → sole workspace → ambiguous. `plugin.` names go to the last focused workspace instead, because the control plane has no plugin host and a request sent there waits out its timeout — a silence indistinguishable from "no such command".
- **The framework registers as the host** (`control_host_attach`), and that connection becomes the delivery channel. It reports facts only — the live labels and which one is focused. What counts as "the last workspace" is a rule, and core's `FocusLedger` owns it: focusing the control plane must not erase the workspace memory, because the natural-language console types from `main` while the user's stage is elsewhere.
- **Nothing comes back through the relay.** The window's executor already calls `invoke("cmd_result", {id, result})`, and that call rides the ordinary bridge. Building a return path in the relay would give one command two ways to answer.
- **Facts that belong to no one are broadcast.** A file change has no addressee, so cored pushes `{"broadcast": {event, payload}}` and the framework fans it to every window. Deliveries and broadcasts use different keys: a delivery waits for a reply and a broadcast has none, and sharing a key would make the receiver hunt for an id that does not exist.

**A window's own bridge is never delivered back to.** The renderer asks cored for `pty_pane_alive` over the same socket. Serving-not-found used to mean "push it to a window", so it went to the very window that asked, whose executor has no such name, and the caller waited out ten seconds instead of reading a name. The axis that splits them is not spelling — it is *who asked*, and the connection knows. The bridge declares itself (`control_bridge_attach`), and unserved names on that connection answer `NOT_SERVED_HERE` at once. Boot demand fell from 1,181 calls to 100 with that one fix; the rest had been retries behind timeouts.

## Answers that do not fit in one reply

Terminal output and process stdout do not fit the request/response pair. The caller sends a place to receive: a token somewhere in the arguments, and frames arrive afterwards carrying that token.

What the token *is* differs per framework — Tauri has `Channel`, Electron has a preload-minted id — and neither crosses a process boundary as a function. Over a socket it is a token either way, so `soksak_core::stream` owns finding the token, framing, and stripping it from the arguments before the command body sees it. A body that knows about tokens forces every command to learn an ignore rule.

Frames go down **the connection that asked**. Any other connection belongs to someone who did not mint that token and will drop the frame — a loss with no error. Binding happens before execution, because a command can push its first frame immediately and a frame with nowhere to go is gone silently. When the connection ends its tokens end with it.

**A token has to survive serialization.** Attaching `onmessage` to the token as an *enumerable* accessor made `invoke` die at the boundary with `An object could not be cloned` — structured clone reads enumerable own properties, the getter returned a function, and functions do not clone. `spawn_terminal` never once reached the server; the only symptom was "the terminal does not come up", with no entry in the demand ledger because nothing was ever sent. The accessor is now non-enumerable. The test performs the clone rather than inspecting the shape: inspecting a shape would miss this again.

## The duplication that remains — the dev-dependency points at it

`frameworks/tauri/Cargo.toml` lists `soksak-cored` under `[dev-dependencies]`. That means exactly one
thing: **the shipped app binary contains no cored code at all.** The app carries a whole separate
backend, and the dev-dependency exists only so a test can compare the two tables
(`cored_shape_gate.rs`).

Having two tables to compare *is* the defect. So this is not a principle — it is a marker for work
left. One backend means one table, and the gate and the dev-dependency end together. Removing it
first only makes the drift it catches quiet again (measured 2026-07-28: five commands believed served
by cored were rejected `INVALID_PARAMS` on a live boot, and the rejection was one line in a framework
log).

## Two implementations, one fixture

Some rules cannot be centralised, because what they operate on is genuinely owned by the framework.

The project claim map is the clearest case: its lifetime *is* the window's lifetime. Held by cored, a dead window's claim would survive a framework restart and that project could never be opened again. So the map stays with whoever owns windows — and that means two implementations.

Two implementations of the *map* is correct. Two implementations of the *rule* is not: the same operation answering differently per framework does not surface as an error, it surfaces as "this project won't open on this one".

So a fixture binds them. `crates/soksak-core/fixtures/*.json` holds the cases; the Rust test and the JS test each read the same file. Change one side only and that side fails. A file does the binding, not anyone's attention.

| Fixture | Binds |
| --- | --- |
| `monitor-of.json` | which monitor holds a window (centre point, edges, truncation direction) |
| `project-claims.json` | claim, idempotent re-claim, refusal as a value, release by owner only, dead-window filtering |
| `window-rect.json` | rect validity, focus default, workspace-label shape |
| `surface-spec.json` | `#rrggbb` colour, openable URL schemes |

The round-trip alternative was tried and reverted for `window_monitors`: it costs a process hop per window, and a framework fact dies when the backend is down. The thin-binding gate records that measurement next to the entry rather than leaving a TODO — the price of a wrong call there is "declare it", not "fix it".

## A resource is not a framework

cored's dependency gate blocks frameworks and native runtimes by name. It already said out loud why `rusqlite` is exempt: a store opens no window, holds no app handle, and reads the same file to the same answer from any process.

`notify` meets the same test — filesystem events are a resource, and cored must hold those handles to serve `watch_dir`. Both crates stay banned in `soksak-core`, which keeps its no-dependency rule; the rule lives in a small crate beside it instead (`soksak-watch`, `soksak-store`).

`tokio` does not meet it, and `net_http_request`, `download_verify`, `sidecar_ensure`, and `media_proxy_info` stay unserved because of it. The one transport (`wreq`) drags the runtime in, and the gate names runtimes as well as frameworks. The standard is not lowered to close a gap.

Banned in those two crates is not banned everywhere, though, and the HTTP capability and the media proxy proved it. Their bodies open no window and hold no app handle — 892 lines that never named the framework they were filed under, which is how a second framework ends up rewriting the same transport rules. They live in `crates/soksak-net` now, which carries `tokio` and `wreq` alone and bans frameworks with its own dependency test. Each framework keeps the command wrapper and the handle this process holds.

Two process-wide globals died in that move. The proxy's port and token were a `OnceLock` pair, and that is a different thing from the shared client and runtime beside them: a client is a resource — any instance answers the same request the same way — while a port the OS assigned and a token drawn at startup are the **answer**, unrecoverable by rule. In one global slot the second `start()` was silently ignored and the first one's port went out as the answer, so a test could not stand up its own proxy. `start()` returns a `MediaProxy` handle now, and whoever holds it answers.

## What the terminal needed

The shell is owned by `soksak-ptyd` and survives app restarts. The client that attaches to it used to live in the app crate, so a second framework had no way to reach the same daemon — and two ways of attaching would let one session look alive on one side and dead on the other.

Moving that client to core took three couplings apart, each replaced by a contract: the vault (`SealKeys`), the session registry (`Link` carried as an `Arc`), and the ledger (`ActivitySink`). Shell env rules moved with it — an allow-list in two copies means a secret leaks differently per process, which is a silent hole, not an error.

cored serves the terminal with no local fallback. The app falls back to an in-process PTY when the daemon is unavailable; a helper doing that would kill, on its own exit, the very shell the app restart was meant to preserve. Unable to attach, it refuses by name.

## What the content view seam cost

Content lives in the page on this framework — a `<webview>` element, not a native sibling. The spike section above says the control surface is all there. Standing it up against the real harnesses found four defects, each silent in a different way (measured 2026-07-28):

| Defect | Symptom | Why it stayed hidden |
| --- | --- | --- |
| Tag events read as `CustomEvent.detail` | address bar frozen at `about:blank` while the page rendered | the unit test dispatched a `CustomEvent`, so reading `detail` passed |
| Global `listen` skipped the local bus | every `emitLocal` event missed subscribers that use the global subscription | the window-scoped `listen` already joined both sources; only the global one diverged |
| Guest script passed as a script, not a function body | `dom.text` and `eval` failed on `1+1` | the error text says "Script failed to execute", which reads like the page's fault |
| Closed windows kept their persistence traces | reloading the control plane resurrected 15 closed windows | the Tauri path prunes on `Destroyed`; this framework had no such place |

The contract each one restores is the same shape: the rule belongs to neither framework, so it moves to a place both call. Trace pruning is now `soksak_core::window_traces`, called by the app with its own connection and by this framework through cored's `window_traces_prune`. Guest scripting keeps the WKWebView contract (`callAsyncJavaScript` takes an async function body), and the adapter wraps rather than redefining.

What the harnesses judge today, against this framework: `p0-contracts` 24/0, `multiwindow` 16/0, `tab-switch-ghost` 13/0, `rail-border` 5/0, `window-traces` 4/0, `motion-slow` 11/0, `surface-park` 8/0, `slot-freeze` fully green, plus `ui-verify` and `gutter-hover`.

## Saying how it differs

`surface-park`, `slot-freeze`, and `gutter-drag` read **native child surfaces** — `webview_list`, engine surface stats, the rect of a composited child. On this framework those are empty by construction, and cored answers `FRAMEWORK_CONCEPT_ABSENT` rather than inventing a number. What the judging side lacked was a place to *ask*.

`framework.provision` is that place: `chromium`, `nativeChildWebview`. It is a capability declaration, not a name switch — `name` goes to ledgers and diagnostics, while verification branches on the axes. The standard stays; only the place it is measured moves. Whether the active browser actually stands is either a native surface list or the rect of an in-page body (`webview.surfaces` now reports position as well — a rect carrying only size cannot answer "did it land exactly on the folded slot"). The slot-landing gate becomes non-applicable, with its reason printed, when the surface model is `dom` — an axis that previously read the engine alone and now reads the framework too.

That work surfaced a false green. `gutter-drag`'s axis-isolation check was vacuous twice over: it drove only through native input, so on a framework without that command it dragged nothing, and its height oracle read a tree that carries no rect, comparing `-1` to `-1`. Fixing where it measures made a real failure appear immediately.

## What "done" was hiding

The port could be called done because nothing counted what was missing. The app invokes 177 backend names; 67 of them are answered by nobody on this framework, and 64 of those exist on Tauri. At runtime each came back as `FRAMEWORK_CONCEPT_ABSENT` — a code that carries two very different facts: *this framework has no such concept* (native child surfaces) and *this was never ported* (scheduler, secrets, clipboard, websockets, the whole `data_*` store surface). Merged, the second wears the face of the first and stays forever.

`scripts/gates/command-ownership.mjs` reads the classification from source — cored's table, each framework's table, Tauri's registration — and the ledger beside it holds only the reason and the **destination** (`core` | `framework` | `renderer` | `unserved`) for each gap, so the next person does not re-decide where a command belongs. `cap` is a ratchet: growing the surface without porting fails, and a gap that someone now answers must be removed from the ledger or the count becomes a lie.

### A reason is not an answer (re-legislated 2026-07-30)

That ratchet had a hole. `cap` counted only the **undeclared** gaps; a name cored refused with a written reason (`refused`) left the count entirely. Writing the reason made the name disappear from the ledger, and it could go unanswered forever while the gate passed.

From the caller's seat, "declared refusal" and "undeclared gap" are the same fact: **no value comes back.** Measured — `sidecar_open` sat in the refused bucket and passed the gate while the second framework's renderer called it 139 times and was refused 139 times. The browser engine never started; the screen said only "engine surface creation failed".

So there are two ratchets. `cap` = undeclared gaps (so that writing a reason still reads as progress), `unansweredCap` = **every name that goes unanswered** (refused + gap). The second does not shrink when you write a reason; it shrinks only when somebody actually answers. Declared absence (`absent`) is not in it — a proven absence is a definite answer.

Today: answered 114 (`core` 77 · `framework` 15 · `renderer` 13 · declared-absent 9) · **unanswered 62** (refused 35 · undeclared gaps 27).

### A signature is not evidence of ownership

The port ledger (`cored_ledger.rs`) carried the same kind of lie. `lane_of` counted a command as `framework` whenever its signature took an injected `Window` — but the second framework picks its share by **name prefix** (`BRANCHES` in `native/index.cjs`). A name outside those families never lands in that table, leaks to the socket, and cored does not serve it either — while the ledger counted it as "the framework's to answer" and dropped it from the port list. **Commands nobody owned were counted as already ported.** Four of them: `sidecar_open`, `sidecar_send`, `process_reclaim_window`, `daemon_start`.

Taking a window does not make something a window concept. A sidecar is an OS process; the window is only the address its events return to. Injection is evidence of coupling, not of ownership, so those names go to `state-bound` — undoing that coupling is what porting them means. `framework` 48 → 42 · `state-bound` 51 → 57. A gate now holds the two family lists to one (`FRAMEWORK_FAMILIES` ≡ `BRANCHES`).

### First repayment: `download_verify`

Once the count was honest, something was visibly payable. `download_verify` is ten lines that touch no window, no app handle, no vault — and the only wall was the **name** `tokio`, which does not meet the ban list's own criterion (does it open a window; does it hold an app handle; does the answer differ per process). `soksak-net` had already written, under that same criterion, that tokio is a resource. One repository was judging one crate by two rules.

So the name is released in the very commit that serves the command — opening it without a consumer would be hiding a decision. Verification and writing are owned by one function in core (`verify_and_write`); the Tauri entry point calls the same one, because a copy would give two processes different rules under one name, and that difference shows up not as an error but as **a different file**. This process's concurrency model is unchanged: `soksak-net` exposes only a sync surface and keeps the runtime inside itself.

`unansweredCap` 62. The three remaining `unserved` are `ws_*`.

## Observation is part of the port

A gutter drag died on the first move. The gesture armed correctly and the pane rect never changed, and the investigation stalled at "no way to see inside" — which is not a diagnosis, it is a missing surface. `ui.input.observe` records which input events actually reach the window, in the capture phase, so a failed injection splits into *the event never arrived* versus *it arrived and nothing moved*.

It answered in one run: a `mouseup` landed on the gutter at the same instant and coordinates as the first move. The core's pointer-order repair synthesises exactly that when a mousemove arrives with `buttons === 0` while a mousedown is held — a correct guard against macOS window-activation clicks losing their up. The injected events carried no `buttons`, so the value defaulted to 0 and **the injected drag killed itself**. Two contracts, each right, and the feature dead between them. Tauri drove gutters through the native bridge, so this path was never walked there.

That bridge is itself a surface that had to be ported: `webview_emit_native` publishes the same `native-mouse*` events the native monitor emits, and without it there is no way to drive that gesture without a real mouse.

All twelve harnesses are green on this framework.

## A framework folder holds no core (proposition, 2026-07-30)

**No operating core stays in a framework folder — whether it touches the framework or not, no exceptions.** Tauri and Electron sit at the same level; the core moves to the common crates.

Contact with the framework (`tauri::`) — its presence or its density — cannot measure this law. A file with 22 framework-calling lines out of 671 is not a framework file; it is **core living in that folder**, and it looks normal to an eye that counts contacts (`framework-free-tenant`). So we count the **body**: the `framework-body` metric in `baseline-gate` seals per-file code lines (comments and blanks excluded), and the seal only goes down. Raising it takes an explicit re-legislation commit that states whether the growth is wiring or core.

Measured at the start: `frameworks/tauri/src` 53 files **17,567 lines** vs `frameworks/electron` 15 files **1,598 lines**. The same job, done at 11× the size — and that difference is the amount to move.

### What legitimately stays

Three things, each because it **cannot cross a process boundary**.

| Stays | Why |
|---|---|
| The native parent surface | A parent view is process-local — no other process can hand it over |
| Main-thread execution | It is that process's run loop |
| The event sink | Events must reach that window's subscribers |

Everything else is common. The split is by **what a command touches**, not by name family: `sidecar_open/send/close` host an in-process engine and belong to the framework, while their same-prefix siblings `sidecar_ensure` (fetch + hash) and `sidecar_dev_new` (file scaffold) belong to the core.

### The first two extractions

**`sidecar.rs` 671 → 166 lines.** dlopen, symbol resolution, the ABI handshake, the module and client registries, message relay, notification and shutdown all moved to `soksak-sidecar-host`. The framework supplies only the three duties above, through a `Framework` trait. The client registry now holds handles alone — what carries an event is the framework's business, so the body need not know. Verified live: the engine loads, `framesPresented` climbs, the page paints.

**`ws.rs` 365 → 68 lines.** The session registry, the read loop and the connect path moved to `soksak-net` (which already bears the runtime). And **cored serves the same body through its own outlet** — pushing frames over a stream token instead of a webview channel. The wall on record ("the transport drags a runtime in, and the dependency gate bans runtimes by name") became false twice in one day: tokio was released because it never met that list's own criterion, and cored already carried the stream path.

### The dials

| | At start | Now |
|---|---|---|
| Unanswered names | 63 | **49** |
| Framework-folder body | 19,165 | **16,510** |
| Unanswered state-bound | 30 | **27** |

Lane `framework` 42 · `served` 81. Of the remaining 58: core 16 · framework 8 · declared refusals 34.

### Paid down since (same day)

- **`notify_show`** — Electron answers. All this seat knows is one fact about itself (is it supported); it does not judge what makes a valid notification. A first draft rejected empty title/body and `framework-thin-binding` caught it — a rule living in the framework gives two shells different standards under one name.
- **`clipboard_read` / `clipboard_write`** — answered. **`clipboard_watch_*` is a proven absence**: this framework emits no clipboard-change event, and polling it would be periodic querying, not watching.
- **`webview_debug_hierarchy`** — absence declared with its reason. There is no native view tree here; the hierarchy is the DOM, and `webview.surfaces`'s bodies already answer it with node paths and rects.
- **`ai_session_active` / `untrack` / `lineage`** — cored carries them. The snapshot ledger is held by **exactly one process** (per-process ledgers would give the same directory two different "previous" states). The lineage query moved into one place in `soksak-store`.

### Reasons corrected

Releasing tokio falsified every refusal that named it as the wall at once: `media_proxy_info` (what remains is one decision — who starts the proxy), the five `unit_install_*` (four walls became three), and `ipc_hello_info`'s destination (core → framework: pid and role belong to the process that answers).

**A wrong reason is worse than none** — writing that something cannot move, when it can, means that name is never examined again.

### Three more bodies moved out

| File | Before | After | Body moved to |
|---|---|---|---|
| `sidecar.rs` | 671 | 166 | `soksak-sidecar-host` |
| `ws.rs` | 365 | 47 | `soksak-net` |
| `service.rs` | 1,066 | 208 | `soksak-service` |
| `schedule.rs` | 1,294 | 156 | `soksak-schedule` |

`service` and `schedule` had already written the answer in their own headers — "what stays in the app is assembly only". That a thousand lines sat in that folder anyway was history, not a decision.

**One shared type can hold two bodies hostage.** The schedule spec (`Trigger`, `Retry`, `JobSpec`) lived in the scheduler's framework file, so the service ledger that also uses that shape depended on that file and was bound to the same process with it. The command-dispatch contract was the same case — the contract moved to core and the implementation stayed behind a thin `AppDispatch` wrapper (, because the orphan rule forbids implementing a core trait on a vendor type).

**Tests follow the body.** 1,296 lines for service and 33 cases for schedule moved with it — neither launches a framework; both measure every rule behind the seam. And each move must widen the **ledgers' scan roots**: a destination outside the roots means the debt you moved is never counted again.

### Nine more bodies, and the walls that were not walls

| File | Before | After | Body moved to |
|---|---|---|---|
| `unit_installer.rs` | 1,310 | 55 | `soksak-install` |
| `runtime_dep.rs` | 584 | 162 | `soksak-install` (archive rules) |
| `daemon.rs` | 567 | 72 | `soksak-daemon` |
| `ai_session.rs` | 375 | 45 | `soksak-core` (tests followed) |
| `data/commands.rs` | 748 | 610 | `soksak-store` (sealing, write policy) |
| `os_key.rs` | 42 | 1 | `soksak-vault` (with the `keyring` dep) |
| `secrets.rs` | 67 | 38 | `soksak-vault` |

**Most walls were not walls.** Each refusal in `unserved.rs` names what blocks it, and re-reading those reasons against the code found them stale far more often than true:

- **The vault** blocked twelve names. Two reasons were written; neither held. "`new_key` does not return the secret, so no recovery code can be issued" — the same contract's `secret(key_id)` already returns the bytes. "This process's only key seam is `NoSealKeys`" — the vault body was already outside the framework; what was actually missing was the **OS-keychain adapter**, which sat in the framework folder. A keychain is a *platform* resource, not a framework one: the vault file lives in the home, so binding its key to the framework puts the file and its key on different axes, and a second framework sharing that home cannot open it. `keyring` moved into the vault crate, and the twelve stood up.
- **Resident services** blocked four. "The manager needs host capabilities the core has no contract for" — the contract (`ServiceHost`) was in the crate, and four of its five are things cored already carries (activity publish, schedule poke, two secrets). The fifth, mediation, *is* cored's single dispatch path.
- **`service_ledger_sync`**'s reason ("the file write and the binding fix-up must be one hand") was not a reason it could not move; it was **the list of what had to move with it**.
- **Unit install** blocked five, with three walls. One was a genuine **defect**, not a wall: the manager's constructor cleared the staging directory, so a second process creating one would erase another's in-flight transaction before the command arrived. Creation and clearing are now separate acts (`clear_staging`, called once at boot). Another — "the ledger is process memory, so `begin` and `commit` on different processes leaves only failure" — was an argument against splitting the five, not against moving them.
- **`unit_dev_*`**'s wall was an **in-process `Mutex`**, which cannot serialize two processes: each takes its own, neither sees the other, and the overlapping read-modify-write erases the other's declaration *while answering success*. That loss never looks like an error — the file is intact and the contents simply went backwards. It is now a kernel advisory file lock (`soksak_core::file_lock`).

**Divergences found by moving, not by testing.** Two commands answered differently depending on which process took them, and neither difference could surface as an error:

1. Write retry and failure evidence lived only in the framework folder. Once cored served writes, that path handed the user a busy-machine failure that the app path survives four times over.
2. The backup ring's only trigger hung off that folder's writes. Writes through cored **never once** turned the ring — a debt that is only collected when something goes wrong.

**Ordering is a contract too.** One flaky test had a real cause: a connection's frames each get their own thread (one request = one thread), so a connection *declaration* could be queued before the first command and still take effect after it — and that request, arriving on a window's own bridge, was delivered to that window, which had nowhere to reply. The comment asserting the ordering was written when one connection meant one thread. Declarations now take effect where they are read.

| | At start | Now |
|---|---|---|
| Unanswered names | 63 | **17** |
| Framework-folder body | 19,165 | **14,083** |
| Unanswered state-bound | 45 | **13** |

Of the remaining 17: declared refusals 12 · undeclared gaps 5. The largest single item is `sidecar_open` — the browser engine on the second framework — which needs a native addon because JS has no FFI, and that is a decision, not a debt.

### Four more: the walls that fell after that

`update_check` / `update_apply` — replacing the app binary is something only the side that knows that binary can do, so **this framework answers**. The channel gate comes first: on dev and debug homes the body is a local build, so a remote check does not even apply, and that `available:false` means *"this channel does not look remotely"*, not *"there is no new version"*. Both facts in one shape would leave the caller unable to tell them apart, so the channel rides along. The release channel is refused **by name**: the signed-bundle installer is not wired here, and answering `available:false` for a missing device is the lie *"you are up to date"* — the user then waits forever for an update that will never come.

`unit_dev_set` / `unit_dev_remove` — the wall was an in-process `Mutex` and the body's location, and both are gone. Moving it surfaced something else: **four things lived in two places, character for character** (`CONFIG_FILE`, `CONFIG_VERSION`, `UnitDevConfig`, `config_path`). Reads were owned by core, writes by the framework folder, and each held its own copy of the same definitions while touching the same file. Two copies stay silent until they diverge.

**Window labels.** Delivery already refused an overlapping label by name (`AMBIGUOUS_HOST`), but the *listing* merged them into one entry. Window restore does not mint a new label — it deliberately reuses the stored `w-<uuid>` — so one home seen by two frameworks revives the same slot twice. A caller reading one entry believes there is one window and builds on it. `window_census` reports, per label, how many hosts hold it: **being unable to choose which window and there being only one window are different facts**, and the overlap should not have to be learned from a failure that arrives after the command was already sent.

`plugin_dev_*` keeps its wall, and half its reason was deleted. The write half is gone; what remains is the git spawn, and that is a rule standing today — `core-git-scan` seals git matches to zero across core and crates, with exactly one explicit allowlist file. **A wrong reason is worse than none**: leaving a wall that has fallen means that name is never examined again.

| | At start | Now |
|---|---|---|
| Unanswered names | 63 | **13** |
| Framework-folder body | 19,165 | **13,773** |
| Unanswered state-bound | 45 | **13** |

Of the remaining 13: declared refusals 10 · undeclared gaps 3. The one large item is `sidecar_open` — the browser engine on the second framework. JS has no FFI, so it needs a native addon: a decision, not a debt.
