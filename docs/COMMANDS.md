# soksak 명령 레퍼런스

> 자동 생성 문서 — 원천은 `command.docs`(앱 Command Registry + 레지스트리 카탈로그).

모든 명령: `sok-dev <command> [값 | '{JSON}']` — 값 하나는 유일한 필수 매개변수로 전달(기본형). 대상 id 생략 시 호출 컨텍스트($SOKSAK_CALLER_TAB) 기본.

코어 명령만 수록한다(--core — 리포지토리 문서용, 설치본 무관). 전체는 `sok-dev docs`.

## `activity.recent`

Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub). | 활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number |  | Maximum entries to return (default 200) [default 200] |
| `since` | number |  | Return entries with seq greater than this (backfill cursor). Omit for latest. |

**Returns**: { entries: [{ seq, ts, kind, source, payload }] }

```bash
sok-dev activity.recent '{"limit":20}'
sok-dev activity.recent '{"since":1234}'
```

## `ai.session.detect`

Detect whether a shell command launches a tracked AI agent (claude or codex). Returns the agent kind or null. Used to tag terminal command blocks with agentKind. | 에이전트탐지 세션탐지 ai탐지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | The shell command line to classify |

**Returns**: { kind }
**Errors**: INVALID_PARAMS

```bash
sok-dev ai.session.detect '{"command":"claude --resume"}'
```

## `ai.session.find`

Find the most recent claude session for a working directory by reading its session folder (~/.claude/projects/<encoded-cwd>/). Returns sessionId and cwd, or null. Used to tag a terminal's command block with the session it launched (on-demand, no live watch). codex uses date folders and is resolved later. | 세션찾기 세션조회 현세션

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | ✓ | Working directory the agent ran in |

**Returns**: { session }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev ai.session.find '{"cwd":"/Users/me/proj"}'
```

## `ai.session.inspect`

Read a claude/codex session jsonl file's header and return its sessionId and cwd. Only paths under ~/.claude/projects or ~/.codex/sessions are allowed; arbitrary file reads are rejected. The sessionId is validated against a UUID whitelist. | 세션점검 세션식별 세션정보

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Path to the session .jsonl file |

**Returns**: { session }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev ai.session.inspect '{"path":"~/.claude/projects/-Users-me-proj/<id>.jsonl"}'
```

## `ai.session.lineage`

Read the session-transition history for a working directory (and optionally one tab), oldest first. Each row is the stored transition record {viewId (stored key for the tab), fromSession, toSession, kind, time} — the time-ordered from→to chain is the flow, and one fromSession branching to several toSession is a fork. This is what we observe via watch since claude doesn't record /clear·/resume branches itself. | 세션계보 세션흐름 세션분기 lineage

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | ✓ | Working directory (scope) to read lineage for |
| `tabId` | string |  | Limit to one terminal tab; omit for all in this cwd |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev ai.session.lineage '{"cwd":"/Users/me/proj"}'
```

## `app.environment`

Read this app's compile-time core identity, isolated home, matching CLI name, build profile, updater channel, and explicitly selected development units. | 앱 환경 코어 빌드 홈 CLI 개발 유닛 모드

**Returns**: { coreBuild, identity, cli, home, buildProfile, updaterEnabled, unitMode, developmentUnits[] }

```bash
sok-dev app.environment
```

## `app.quit` (danger: destructive)

Quit the app this window lives in. The other framework on the same home keeps running. | 앱 종료 끄기 quit

**Returns**: { ok }

```bash
sok-dev app.quit
```

## `bookmark.add`

Add a URL to browser bookmarks. | 즐겨찾기 추가 북마크 저장

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string |  | Display name (omit = hostname) |
| `url` | string | ✓ | URL |

**Returns**: {}

```bash
sok-dev bookmark.add '{"url":"https://example.com"}'
```

## `bookmark.list`

List saved browser bookmarks. | 즐겨찾기 목록 북마크

**Returns**: { bookmarks: [{url,title}] }

```bash
sok-dev bookmark.list
```

## `bookmark.remove`

Remove a URL from browser bookmarks. | 즐겨찾기 삭제 북마크 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✓ | URL |

**Returns**: {}

```bash
sok-dev bookmark.remove '{"url":"https://example.com"}'
```

## `clipboard.read`

Read the current text from the system clipboard. Returns an empty string when the clipboard holds non-text content. Use to inspect a command result or the last copied value. | 클립보드 읽기 복사내용 붙여넣기확인

**Returns**: { text }
**Errors**: INTERNAL

```bash
sok-dev clipboard.read
```

## `clipboard.write` (danger: inject)

Write text to the system clipboard, overwriting existing content. The core suppresses the self-write echo event once to prevent feedback loops. | 클립보드 쓰기 복사 클립보드저장

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to place in the clipboard |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev clipboard.write '{"text":"복사할 내용"}'
```

## `command.docs`

The whole executable command surface in one call: core command specs, installed plugin command specs, and authenticated release references for units that are not installed. A registry never supplies unit command declarations. | 전체 명령 문서 레퍼런스 매뉴얼 한눈에 코어 플러그인 미설치

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lang` | string |  | Language for human-facing text (default: en) (en|ko) |
| `refresh` | boolean |  | Refetch signed live registries before answering |

**Returns**: { core: [spec], plugins: { [pluginId]: [spec] }, registry: [{registryId,unitId,id,kind,version,manifest,reports,installed}] }

```bash
sok-dev command.docs
sok-dev docs
sok-dev command.docs '{"lang":"ko"}'
```

## `daemon.add`

Register a long-running project process (dev server, watcher, database) as a daemon — appends a standard `name: command` line to the project's Procfile. If your project has such a process, register it: with autostart allowed it starts whenever the project opens. Container stacks work too (a foreground `docker compose up` cleans itself up on stop). | 데몬 등록 추가 서버 자동 시작

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmd` | string | ✓ | Shell command to run from the project root |
| `name` | string | ✓ | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, name, cmd }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev daemon.add '{"name":"dev","cmd":"npm run dev"}'
```

## `daemon.autostart`

Allow or revoke automatic start when this project opens (omit name = every declared daemon). This is a local, per-machine consent stored outside the repository — a cloned Procfile never runs anything by itself. | 데몬 자동 시작 허용

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | Daemon name from the Procfile |
| `on` | boolean | ✓ | true = start when the project opens |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, autostart: Record<name, boolean> }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev daemon.autostart '{"name":"dev","on":true}'
sok-dev daemon.autostart '{"on":true}'
```

## `daemon.list`

List the project's daemons — Procfile declarations merged with runtime state (running/stopped, pid, uptime) and local policy (autostart, managed stop command). A Procfile found in the project is only discovered, never auto-run, until the user allows it with daemon.autostart. | 데몬 목록 상시 프로세스 서버

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, daemons: [{ name, cmd, running, pid?, uptimeMs?, autostart, managed, exitCode? }] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev daemon.list
```

## `daemon.logs`

Read a daemon's recent output from the in-memory ring buffer (last 500 lines at most; nothing is written to disk — redirect inside your command if you need persistence). | 데몬 로그 출력 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lines` | number |  | How many recent lines (default 100) |
| `name` | string | ✓ | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, name, lines: [string] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev daemon.logs dev
sok-dev daemon.logs '{"name":"dev","lines":300}'
```

## `daemon.remove` (danger: destructive)

Remove a daemon declaration from the project's Procfile. A running instance is stopped first. | 데몬 제거 삭제

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, name, removed }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev daemon.remove dev
```

## `daemon.restart`

Restart a daemon — stop (tree kill or managed stop command) and start again. | 데몬 재시작

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, name, pid }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok-dev daemon.restart dev
```

## `daemon.set`

Set per-daemon local options — currently the stop command for detached tools whose start and stop differ (e.g. start `docker compose up -d`, stop `docker compose down`). Stored locally, never in the Procfile. | 데몬 설정 종료 명령

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |
| `stop` | string |  | Command that shuts the daemon down (empty string clears it) |

**Returns**: { projectId, name, stop? }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev daemon.set '{"name":"db","stop":"docker compose down"}'
```

## `daemon.start`

Start a declared daemon (omit name = every declared daemon that is not running). Output goes to an in-memory ring buffer — read it with daemon.logs. | 데몬 시작 서버 기동

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, started: [{ name, pid }] }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok-dev daemon.start dev
sok-dev daemon.start
```

## `daemon.stop`

Stop a running daemon (omit name = all). The whole process tree is terminated — SIGTERM first, SIGKILL after a grace period. A managed daemon (one with a stop command set via daemon.set) runs its stop command instead. | 데몬 정지 서버 중지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | Daemon name from the Procfile |
| `project` | string |  | Project id (omit = active project) |

**Returns**: { projectId, stopped: [name] }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok-dev daemon.stop dev
sok-dev daemon.stop
```

## `data.backup`

Snapshot the entire data store to a single .db file via VACUUM INTO (absorbs WAL). Omit path to write a timestamped file under ~/.soksak/backups/. | 백업 스냅샷 데이터백업

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Destination path; defaults to backup folder |

**Returns**: { path }
**Errors**: INTERNAL

```bash
sok-dev data.backup
sok-dev data.backup '{"path":"/tmp/soksak.db"}'
```

## `data.canary`

Check whether the store can actually be written: inserts one row and rolls it back, leaving nothing. The integrity check only reads, so a store that reads fine and fails every write passes it — this is the surface that catches that. Failures carry the diagnosis and the process's memory figures. | 데이터 쓰기 확인 저장 가능

**Returns**: { writable }
**Errors**: INTERNAL

```bash
sok-dev data.canary
```

## `data.count`

Count records in a collection (read-only). Narrow the count with an optional where filter. | 카운트 개수 레코드수 건수

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `scope` | string |  | Scope partition key |
| `where` | json |  | Filter condition (same shape as data.query where) |

**Returns**: { count }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.count '{"ns":"soksak-plugin-<id>","coll":"messages"}'
```

## `data.encrypt.changeRecovery` (danger: destructive)

Change a scope's recovery code WITHOUT re-encrypting data: re-wrap the active private key under a fresh recovery code and return it once. Use when the old code is lost or exposed. Requires this device's OS-keychain KEK. The previous code stops working; store the new one. Cheaper than rotate — the key and sealed records are untouched, only the recovery blob is replaced. | 복구코드변경 복구코드재발급 복구코드교체

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key |

**Returns**: { recoveryCode }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.changeRecovery '{"scope":"projA"}'
```

## `data.encrypt.convert` (danger: destructive)

Seal records already stored plaintext in a scope under the active key (one transaction per record, idempotent, resumable). Run after data.encrypt.enable to protect pre-existing data. | 암호화변환 봉인변환 기존암호화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `scope` | string | ✓ | Scope partition key to convert |

**Returns**: { converted }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.convert '{"ns":"soksak-plugin-<id>","coll":"command_blocks","scope":"projA"}'
```

## `data.encrypt.enable` (danger: destructive)

Enable encryption for a scope: generate an X25519 keypair, wrap the private key in the vault (requires the vault to be unlocked first) AND under a one-time recovery code, then register the public key so every subsequent write is sealed. Returns the recovery code ONCE — store it safely; it is the only way to recover the data if the passphrase is lost, and it is never retrievable again. Run data.encrypt.convert afterward to seal records already stored. | 암호화활성 암호화켜기 봉인활성

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key to encrypt |

**Returns**: { keyId, recoveryCode }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.enable '{"scope":"projA"}'
```

## `data.encrypt.recover` (danger: destructive)

Recover a scope's encryption private key from its one-time recovery code on a machine that lacks it — a fresh install, a different OS, or a lost keychain. Re-stores the key under this device's OS-keychain KEK, which must be reachable. The recovered key must match the registered public key or recovery is refused. After success the scope's sealed records decrypt again on this machine. | 암호화복구 키복구 복구코드

| Parameter | Type | Required | Description |
|---|---|---|---|
| `recoveryCode` | string | ✓ | The recovery code issued at enable |
| `scope` | string | ✓ | Scope partition key to recover |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.recover '{"scope":"projA","recoveryCode":"XXXX-XXXX-..."}'
```

## `data.encrypt.rotate` (danger: destructive)

Rotate a scope's encryption key: generate a new keypair, re-seal every record from the old key to the new one (one transaction each, resumable), re-issue the recovery blob under a NEW recovery code, then dispose the old key only once nothing references it. Requires this device's OS-keychain KEK. Returns the new recovery code ONCE — store it; the previous code no longer opens the data. | 키회전 키교체 암호화회전

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key to rotate |

**Returns**: { oldKeyId, newKeyId, rekeyed, oldDisposed, recoveryCode }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.rotate '{"scope":"projA"}'
```

## `data.encrypt.status`

Report encryption state for a scope: enabled (an active key = sealing trigger), keyId, algo, whether the vault is unlocked (decryption possible), tampered (publicKey no longer matches the vault private key), and keyMissing (the public key exists but its private key is gone from the vault — sealed records are unrecoverable). | 암호화상태 암호화확인 봉인상태

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key (e.g. projectId) |

**Returns**: { enabled, keyId, algo, unlocked, tampered, keyMissing }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.encrypt.status '{"scope":"projA"}'
```

## `data.export`

Export data as JSONL (meta + record + kv rows). Scope by ns/coll; omit both for a full export. Use for partial backups or migrating data between instances. | 내보내기 익스포트 데이터이식

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string |  | Limit to this collection; omit for all |
| `ns` | string |  | Limit to this namespace; omit for all |

**Returns**: { jsonl }
**Errors**: INTERNAL

```bash
sok-dev data.export '{"ns":"soksak-plugin-<id>"}'
```

## `data.import` (danger: destructive)

Import JSONL produced by data.export: meta rows call define, record rows upsert, kv rows set. Existing ids are overwritten. | 가져오기 임포트 데이터이식 복구

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jsonl` | string | ✓ | JSONL string output from data.export |

**Returns**: { applied }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.import '{"jsonl":"..."}'
```

## `data.kv.delete` (danger: destructive)

Delete one kv row from a namespace. Deleting an absent key reports deleted:false. | 키값 삭제

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Key |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |

**Returns**: { ns, key, deleted }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.kv.delete '{"ns":"soksak-plugin-<id>","key":"team:t1"}'
```

## `data.kv.get`

Read one kv value from a namespace. Returns null when absent. | 키값 조회

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Key |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |

**Returns**: { ns, key, value }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.kv.get '{"ns":"soksak-plugin-<id>","key":"team:t1"}'
```

## `data.kv.keys`

List kv keys in a namespace, optionally filtered by prefix. | 키 목록

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `prefix` | string |  | Key prefix filter |

**Returns**: { ns, keys }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.kv.keys '{"ns":"soksak-plugin-<id>","prefix":"team:"}'
```

## `data.kv.set`

Write one kv value (JSON) into a namespace. The store is a core SQLite singleton — the row survives app restart and window close. | 키값 저장

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Key |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `value` | json | ✓ | JSON value to store |

**Returns**: { ns, key }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.kv.set '{"ns":"soksak-plugin-<id>","key":"team:t1","value":{"agents":[]}}'
```

## `data.ns.remove` (danger: destructive)

Remove a data namespace and everything it made: its records, kv rows, collection definitions, FTS tables and expression indexes. Other namespaces are untouched. Removing a namespace that does not exist is not a failure — it reports zeros. | 데이터 네임스페이스 삭제 회수

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ns` | string | ✓ | Namespace to remove |

**Returns**: { ns, collections, records, kv }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.ns.remove '{"ns":"plugin:probe-lane"}'
```

## `data.query`

Query a collection (read-only). Filter fields must be declared as indexes in define. Use to read or filter stored records. | 데이터 조회 쿼리 검색 목록

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `desc` | boolean |  | Sort descending (default true) |
| `limit` | number |  | Max rows to return (default 200) |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `offset` | number |  | Rows to skip |
| `order` | string |  | Sort field: created, updated, or any index field |
| `scope` | string |  | Scope partition key (e.g. projectId) |
| `where` | json |  | {field: value} or {field: {op, value}} |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.query '{"ns":"soksak-plugin-<id>","coll":"messages","scope":"projA"}'
```

## `data.repair` (danger: destructive)

Rebuild the data store's indexes from the table rows (REINDEX) and report the problems before and after. Rows are neither created nor deleted. Use when data.verify reports index problems — a store whose indexes are broken reads fine and fails on write. Healing is attempted even when the diagnosis itself fails; reindexError carries the reason when the rebuild could not run. | 데이터 복구 인덱스 재생성 치유

**Returns**: { before: string[], after: string[], healed, reindexError? }
**Errors**: INTERNAL

```bash
sok-dev data.repair
```

## `data.restore` (danger: destructive)

Restore the entire data store from a backup .db file: validates, safely copies the current store, then atomically swaps. Irreversible — use with caution. | 복원 데이터복원 되돌리기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Path to the backup .db file to restore from |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.restore '{"path":"/tmp/soksak.db"}'
```

## `data.search`

Full-text search a collection using FTS5 trigram (CJK-aware). Queries shorter than 3 code points fall back to LIKE. | 검색 전문검색 찾기 텍스트검색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `limit` | number |  | Max rows to return (default 50) |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `query` | string | ✓ | Search query string |
| `scope` | string |  | Scope partition key |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev data.search '{"ns":"soksak-plugin-<id>","coll":"messages","query":"빌드 실패"}'
```

## `data.stats`

Report the data store as the app's own SQLite sees it: the boot write-gate verdict, version, heap limits, memory used and highwater, page cache settings, page/freelist counts, and how many indexes sit on the shared records table. Read-only. Use this when a store call answers out of memory — bootGate says whether writes worked at startup, and the limits and memory figures say what starved it. | 데이터 저장소 상태 통계 메모리 한도

**Returns**: { bootGate, sqliteVersion, softHeapLimit, hardHeapLimit, memoryUsed, memoryHighwater, cacheSize, pageSize, pageCount, freelistCount, recordsIndexes }
**Errors**: INTERNAL

```bash
sok-dev data.stats
```

## `data.verify`

Check the data store for corruption (full integrity check — it cross-checks every index against the table, which the boot check does not). Read-only. Returns the problems SQLite reports; an empty list means the store is sound. | 데이터 무결성 점검 손상 확인

**Returns**: { ok, problems: string[] }
**Errors**: INTERNAL

```bash
sok-dev data.verify
```

## `debug.sleep` (danger: inject)

DEV-ONLY: hold the reply for `ms` then return (ok by default; ok:false when fail=true). Simulates a held-reply process (exec-one onExit) so the scheduler's process_lease lease — no-kill while running, single in-flight, cancel-wakes-wait — can be e2e-tested without a real LLM. Absent in production builds. | 디버그 슬립 대기 보류 테스트 lease 스케줄러

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fail` | boolean |  | Return ok:false instead of ok:true (exercises backoff/crash path). |
| `ms` | number |  | Milliseconds to hold the reply before returning (default 3000). |

**Returns**: { slept } (ok:true) | { ok:false } when fail
**Errors**: INTERNAL

```bash
sok-dev debug.sleep '{"ms":5000}'
sok-dev debug.sleep '{"ms":2000,"fail":true}'
```

## `dev.remoteConfirmMock` (danger: inject)

DEV-ONLY: emit a mock remote destructive confirm request so the desktop RemoteConfirmModal renders without a paired phone. For visual verification and headless E2E only; does not touch the Rust confirm authority. Absent in production builds. | 원격 confirm mock 데스크톱 테스트 모달

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string |  | Command summary to show (default pane.close). |
| `device_id` | string |  | Requesting device label to show (default iPhone-mock). |
| `params` | string |  | Optional params summary string to show. |
| `ttl_secs` | number |  | Countdown seconds to show (default 120). |

**Returns**: { request_id }

```bash
sok-dev dev.remoteConfirmMock
sok-dev dev.remoteConfirmMock '{"command":"terminal.clear","device_id":"Pixel-9"}'
```

## `explorer.list`

List direct children of a directory (same view as the file tree). Omit path to use the project root (falls back to HOME). | 파일 목록 디렉토리 폴더 내용 탐색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Absolute directory path |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId|null, root, children: [{name,dir}] }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok-dev explorer.list
sok-dev explorer.list '{"path":"/tmp"}'
```

## `framework.info`

Read which app framework this window actually runs on (the resolved adapter, e.g. tauri or electron) and which contract capabilities that adapter exposes. Capability names are reported by presence only — nothing is invoked, because an unimplemented capability throws when called. Use when diagnosing an incident, driving a harness, or stamping a ledger entry with the framework it came from. | 프레임워크 어댑터 플랫폼 활성 런타임 진단 능력 어느프레임워크

**Returns**: { framework, capabilities[] } — the active adapter name and the contract capability names it exposes (nested groups flattened as group.member).

```bash
sok-dev framework.info
```

## `framework.provision`

Read what this window's framework provides: adapter name, whether the engine is Chromium, and whether content views are native child webviews (as opposed to elements inside the page). Branch verification on these axes, never on the adapter name. | 프레임워크 능력 제공 축 네이티브 자식 웹뷰 엔진

**Returns**: { name, chromium, nativeChildWebview }

```bash
sok-dev framework.provision
```

## `fs.unwatch`

Release one fs.watch subscription for a directory. The OS watch is removed only when the last subscription is released; unwatching a path that is not watched is a no-op. | 디렉토리 감시 해제 폴더 변경 감지 중지 언워치

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute directory path to stop watching |

**Returns**: { path, watchers: remaining subscription count for the path }
**Errors**: INTERNAL

```bash
sok-dev fs.unwatch '{"path":"/Users/me/work"}'
```

## `fs.watch`

Watch a directory for changes using OS-native file events (non-recursive, no polling). Changes emit the fs-change event with the changed directory. Watches are reference-counted per path — pair every fs.watch with a matching fs.unwatch. | 디렉토리 감시 폴더 변경 감지 워치 파일 구독

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute directory path to watch |

**Returns**: { path, watchers: subscription count for the path after registration }
**Errors**: INTERNAL

```bash
sok-dev fs.watch '{"path":"/Users/me/work"}'
```

## `layout.apply`

Apply a layout by building fresh spaces — never destroys existing spaces. Hierarchy: first-level spaces are independent switchable screens; second-level panes are the splits inside each space. preset dev = a terminal plus a browser side by side (if no browser program is installed, that pane is skipped and reported in skipped). preset facets = build the named spaces you pass in (spaces required). Verify by switching to a space with space.activate, then capturing with window.snapshot. | 화면 구성 레이아웃 적용 스페이스 배치 개발 나란히 dev facets

| Parameter | Type | Required | Description |
|---|---|---|---|
| `preset` | string | ✓ | dev = a terminal plus a browser side by side; facets = build the named spaces passed in spaces (dev|facets) |
| `project` | string |  | Target project id (omit = caller's context project) |
| `spaces` | json |  | Named spaces to build (required for facets): [{ title, panes?: [{ program, side? }] }] |

**Returns**: { projectId, spaces: [{ spaceId, title, panes: [{ paneId, program }] }], skipped? } — skipped lists panes dropped because their program is missing
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev layout.apply dev
sok-dev layout.apply '{"preset":"facets","spaces":[{"title":"docs","panes":[{"program":"browser"}]}]}'
```

## `layout.arrangement`

The solved arrangement of the active space: the rail station, whether the focused pane was switched to the front (row-mismatch rule), the displayed cell rects, and the move list a focus change would produce. Read-only — the arrangement is a function of the split tree and the focus, so pane.*/sidebar.left.position are the ways to change it. | 배치 해 레일 스테이션 이동량 스위칭 정렬 계산 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, spaceId, station, cleanLines[], switched, betweenIds[] (panes stranded between the rail and the focused pane when the rail could not reach it — they do not move, they dim), cells[].{id,rect,railSide}, movesFrom:{focusId, moves[].{id,dLeftPct,dRailUnits}} }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev layout.arrangement
```

## `layout.suggest`

Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a monitor free of project windows whole (or the right third alongside on a single monitor); project windows fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute. | 창 배치 제안 전략 모니터 분배 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `roles` | json |  | Optional label→role map, e.g. {"main":"orchestrator"} — unlisted windows count as project windows |
| `strategy` | string |  | Placement strategy (spread|grid) [default "spread"] |

**Returns**: { placements: [{label,monitor,x,y,w,h}] }

```bash
sok-dev layout.suggest '{"strategy":"spread","roles":{"main":"orchestrator"}}'
```

## `media.proxy.info` (danger: inject)

Return the local media-stream proxy endpoint { base, port, token }. The proxy fetches Referer/CORS-protected media (HLS .m3u8/.ts, ranged .mp4) the webview cannot fetch cross-origin: it injects caller-supplied headers, streams binary with Range support, rewrites m3u8 segment/key URLs, and sets permissive CORS for hls.js / <video>. Build URLs as {base}/m3u8?url=&referer=&ua= or {base}/stream?url=&referer=&ua=. | 미디어 프록시 스트리밍 엔드포인트 HLS 재생 Referer CORS

**Returns**: { base, port, token }
**Errors**: INTERNAL

```bash
sok-dev media.proxy.info
```

## `media.proxy.playlist` (danger: inject)

Build a proxied URL for an HLS playlist (.m3u8). The proxy fetches the playlist with the given Referer/User-Agent and rewrites every segment/key URL back through the proxy so hls.js can play it. Returns { url }. Generic: no site knowledge. | 미디어 프록시 HLS 플레이리스트 m3u8 URL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `referer` | string |  | Referer header to inject (origin is derived from it) |
| `url` | string | ✓ | Upstream .m3u8 playlist URL to proxy |
| `userAgent` | string |  | User-Agent header to inject (defaults to a browser UA) |

**Returns**: { url }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev media.proxy.playlist '{"url":"https://cdn.example/play.m3u8","referer":"https://page.example/"}'
```

## `media.proxy.stream` (danger: inject)

Build a proxied URL for a single binary media resource (a .ts/fMP4 segment, key, or ranged .mp4). The proxy forwards Range and injects the given Referer/User-Agent. Returns { url } for use as a <video> src or hls.js segment. Generic: no site knowledge. | 미디어 프록시 세그먼트 바이너리 스트림 URL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `referer` | string |  | Referer header to inject (origin is derived from it) |
| `url` | string | ✓ | Upstream media URL to proxy |
| `userAgent` | string |  | User-Agent header to inject (defaults to a browser UA) |

**Returns**: { url }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev media.proxy.stream '{"url":"https://cdn.example/seg0.ts","referer":"https://page.example/"}'
```

## `net.http.request` (danger: inject)

Send an arbitrary-origin HTTP request (method/url/headers/query/body) → {status,headers,body}. Core handles cross-origin requests that webview fetch cannot. Secrets are substituted at the Rust boundary from the ns vault (secretSubst: placeholder→secretKey, plaintext never exposed). ns must be explicit from CLI/E2E; plugin runtime uses app.network.http which injects ns automatically. impersonate:"chrome" routes the request through the browser-fingerprint (JA3/JA4) backend; "off" (default) uses the plain native-tls backend. Authorization requests never follow redirects and are rejected with chrome impersonation because that shared client cannot guarantee a per-request no-redirect policy. | HTTP 요청 API호출 웹요청 GET POST 임퍼소네이션 핑거프린트

| Parameter | Type | Required | Description |
|---|---|---|---|
| `body` | string |  | Request body as a string |
| `contentType` | string |  | Content-Type header value |
| `headers` | json |  | Request headers map |
| `impersonate` | string |  | Transport backend: "off" (default, plain native-tls) or "chrome" (browser JA3/JA4 fingerprint via the wreq backend, to pass fingerprint-blocking CDNs). Same response shape, secret/ns/danger gates either way. |
| `method` | string | ✓ | HTTP method: GET, POST, PUT, DELETE, PATCH, etc. |
| `ns` | string |  | Secret resolution namespace (required when secretSubst is provided) |
| `query` | json |  | Query parameter map |
| `secretSubst` | json |  | placeholder→secretKey map; values are resolved from the ns vault at the Rust boundary, never exposed as plaintext |
| `url` | string | ✓ | Request URL |

**Returns**: { status, headers, body }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev net.http.request '{"method":"GET","url":"https://api.example.com/v1/ping"}'
sok-dev net.http.request '{"method":"GET","url":"https://blocked.example.com","impersonate":"chrome"}'
```

## `net.udp.request` (danger: inject)

UDP request-response on a single socket: send data (hex) to host:port, then collect replies for timeoutMs (SSDP discover, mDNS, DNS, etc.). Unicast replies return to the sending port. Each packet includes hex and decoded text. | UDP 요청 SSDP mDNS 디스커버리 네트워크검색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `data` | string | ✓ | Bytes to send as a hex string |
| `host` | string | ✓ | Target host (e.g. 239.255.255.250 for SSDP) |
| `maxPackets` | number |  | Max packets to collect (default 64) |
| `port` | number | ✓ | Target port (e.g. 1900 for SSDP) |
| `timeoutMs` | number |  | Response collection window in ms (default 3000) |

**Returns**: { packets: [{ address, port, data(hex), text }] }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev net.udp.request '{"host":"239.255.255.250","port":1900,"data":"...","timeoutMs":3000}'
```

## `net.udp.send` (danger: inject)

Send a UDP datagram to any host:port, including broadcast addresses (e.g. Wake-on-LAN). data must be a hex string. Core handles raw UDP that webview JS cannot perform. | UDP 전송 네트워크 브로드캐스트 WOL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `broadcast` | boolean |  | Allow broadcast addresses (255.255.255.255 etc.) |
| `data` | string | ✓ | Bytes to send as a hex string (e.g. ffffffffffff...) |
| `host` | string | ✓ | Target host or broadcast address (e.g. 255.255.255.255) |
| `port` | number | ✓ | Target UDP port (e.g. 9) |

**Returns**: { bytesSent }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev net.udp.send '{"host":"255.255.255.255","port":9,"data":"ffffffffffff","broadcast":true}'
```

## `notify.activate`

Activate a notification previously shown by `notify.show`, using its `handle`. Runs exactly what an OS click runs. | 알림 누르기 알림 활성화 클릭 | 알림 누르기 활성화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `handle` | number | ✓ | Handle returned by notify.show |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev notify.activate '{"handle":1}'
```

## `notify.show`

Show an OS desktop notification (title + body). Behaves like a push notification when the window is not focused. Clicking runs the deep link this notification carries — pass it as `deepLink` (soksak[-env]://cmd/<name>?<query>). | 알림 보내기 푸시 통지 데스크톱알림

| Parameter | Type | Required | Description |
|---|---|---|---|
| `body` | string | ✓ | Notification body text |
| `deepLink` | string |  | Deep link to run when the notification is clicked (soksak[-env]://cmd/<name>) |
| `title` | string | ✓ | Notification title |

**Returns**: { ok, handle }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev notify.show '{"title":"배포 완료","body":"prod 배포가 끝났습니다"}'
```

## `orchestrator.ask`

Run one natural-language turn: spawns the configured agent CLI (settings orchestratorAgent) which drives the app through single `sok` commands. Every execution born from the turn carries payload.parentId=turnId, and the turn itself is recorded as chat.prompt → command.progress deltas → chat.answer — one conversation set in the activity stream. Long-running: pass a large timeoutMs when calling over the socket. | 자연어 명령 대화 실행 오케스트레이터 물어보기 시켜줘

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Natural-language instruction |
| `window` | string |  | Stage window label for the turn (SOKSAK_WINDOW for the agent — its sok commands default there). Omit = no stage; the agent discovers windows itself. |

**Returns**: { turnId, answer } — message is the agent's final answer
**Errors**: INTERNAL, TIMEOUT

```bash
sok-dev --window main orchestrator.ask '{"text":"열린 창을 알려줘","timeoutMs":300000}'
```

## `orchestrator.stop`

Cancel the in-flight natural-language turn (kills the agent process; the set closes as CANCELLED). | 중단 멈춰 취소 턴 중지

**Returns**: { stopped }

```bash
sok-dev --window main orchestrator.stop
```

## `pane.activate`

Activate a pane, making it the focused one. | 칸 포커스 활성화 선택

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string | ✓ | Target pane id (omit = caller's context pane) |

**Returns**: { paneId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev pane.activate '{"pane":"pan-p2q3r4"}'
```

## `pane.close` (danger: destructive)

Close a pane and all its tabs. Refuses to close the last pane. | 칸 닫기 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string | ✓ | Target pane id (omit = caller's context pane) |

**Returns**: { paneId(closed), activePaneId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev pane.close '{"pane":"pan-p2q3r4"}'
```

## `pane.equalize`

Even out a gutter — halves the two areas the seam divides (what double-clicking it does). Pass all:true to give every area along that seam's axis the same share instead of just the two neighbours. | 칸 균등 같은 크기 반반 균등화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `all` | boolean |  | Equalize every area along that seam's axis, not just the two neighbours |
| `edge` | string | ✓ | Which of the pane's edges the gutter sits on — right|bottom are canonical, left|top name the same gutter from the neighbour's side (right|bottom|left|top) |
| `pane` | string |  | Target pane id (omit = caller's context pane) |

**Returns**: { paneId, gutter:{pane,edge}(canonical), sizes }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev pane.equalize '{"edge":"right"}'
sok-dev pane.equalize '{"pane":"pan-g2h3j4","edge":"bottom","all":true}'
```

## `pane.list`

List displayed panes in a space, including rect (%), displayed layout, immutable canonical layout, and projection provenance.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `space` | string |  | Target space tab id |

**Returns**: { projectId, spaceId, activePaneId, layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,connected}?, panes[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev pane.list
```

## `pane.merge`

Merge panes — move all tabs from src into dst; empty src pane is removed automatically. | 칸 합치기 병합 탭 이동 합병

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination pane id |
| `project` | string |  | Target project id (omit = caller's context project) |
| `src` | string | ✓ | Source pane id |

**Returns**: { projectId, paneId(merged pane) }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev pane.merge '{"src":"pan-p2q3r4","dst":"pan-g2h3j4"}'
```

## `pane.move`

Reposition a pane — move the entire src pane to the zone position relative to dst. | 칸 이동 재배치 위치 옮기기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination pane id |
| `project` | string |  | Target project id (omit = caller's context project) |
| `src` | string | ✓ | Source pane id |
| `zone` | string | ✓ | Drop zone (center = move/merge; others = split in that direction) (center|left|right|top|bottom) |

**Returns**: { projectId, paneId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev pane.move '{"src":"pan-p2q3r4","dst":"pan-g2h3j4","zone":"left"}'
```

## `pane.resize`

Move one gutter — the seam on the given edge of a pane. ratio is the new share of the area on that pane's side of the seam; the neighbour on the other side takes the rest, and the panes further along keep their sizes. Every seam is some pane's right or bottom edge (left/top name the same seam from the neighbour's side), so no interior layout id is ever needed. | 칸 크기 조절 비율 골 조정 바꾸기 경계 끌기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `edge` | string | ✓ | Which of the pane's edges the gutter sits on — right|bottom are canonical, left|top name the same gutter from the neighbour's side (right|bottom|left|top) |
| `pane` | string |  | Target pane id (omit = caller's context pane) |
| `ratio` | number | ✓ | New share (0..1, exclusive) of the two adjacent areas for the side the pane sits on |

**Returns**: { paneId, gutter:{pane,edge}(canonical), sizes }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev pane.resize '{"edge":"right","ratio":0.7}'
sok-dev pane.resize '{"pane":"pan-g2h3j4","edge":"bottom","ratio":0.35}'
```

## `pane.split`

Split a pane — add a new pane beside the target on a given side (optionally running a program). Use when arranging the layout or opening something side by side. | 칸 나누기 분할 화면 옆에 열기 나란히

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string |  | Target pane id (omit = caller's context pane) |
| `program` | string |  | Program id — plugin-registered only (see program.list; no built-in default). Omitted or unregistered id opens a blank pane |
| `project` | string |  | Target project id (omit = caller's context project) |
| `side` | string | ✓ | Split direction (left|right|top|bottom) |

**Returns**: { projectId, paneId(new pane), tabId?, arrangement:{station,switched,cleanLines[],cells[]} }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev pane.split '{"side":"right"}'
sok-dev pane.split '{"side":"bottom","program":"browser"}'
```

## `plugin.catalog`

List authenticated plugin release references from configured registries, merged with local install state. Unit-owned display metadata and commands become available only after release verification. | 플러그인 카탈로그 레지스트리 설치 가능 목록 마켓 검색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `refresh` | boolean |  | Refetch the signed live registry before listing (default: certified session state) |
| `registryId` | string |  | Limit results and refresh to one registry id |

**Returns**: { status, registries, plugins: [{registryId,unitId,id,kind,version,manifest,reports,installed,runtimeStatus?}] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.catalog
sok-dev plugin.catalog '{"refresh":true}'
```

## `plugin.conformance`

Report a plugin's declared-vs-actual conformance: manifest declarations vs what is actually registered/exposed at runtime, across every register-gated contribution (commands/views/fileViewers/iconSets) plus DOM nodes. Read-only diagnosis. The publish-time schema gate is soksak-validate (headless, @soksak-ai/plugin-spec); this is the in-app runtime surface. | 플러그인 정합성 선언 실제 conformance

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | 플러그인 id |

**Returns**: { id, commands/views/fileViewers/iconSets: { declared, registered, missing }, nodes: { declared, wired, missing, orphan }, implements: { declared, violations }, c2: { violations: [{ rule, detail }], viewStatus: { mounted, reported, unreported, undeclared: [{ viewId, view, code }] } }, calls: { literals, dynamic, unresolved } }

```bash
sok-dev plugin.conformance soksak-plugin-<id>
```

## `plugin.consent.chain`

Return the ordered list of plugins still needing consent before the target plugin can be activated (dependencies first). Dev-sourced and already-consented plugins are excluded. An empty pending array means the plugin can be activated immediately. | 동의 체인 미동의 순서 활성화 전

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, pending }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.consent.chain '{"id":"soksak-plugin-<id>"}'
```

## `plugin.consent.grant` (danger: destructive)

Grant consent for a plugin's requested permissions — the CLI/headless equivalent of approving the consent modal. Records consent (manifest version + permissions) so the plugin can then be enabled without opening the webview. Review first with plugin.consent.summary. Dev-sourced plugins bypass consent and do not need this. Danger-gated: granting permissions is a deliberate, security-sensitive act. | 동의 승인 허가 grant 권한 부여

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, granted }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.consent.grant '{"id":"soksak-plugin-<id>"}'
```

## `plugin.consent.preview`

Open the consent modal for inspection without activating the plugin. Use when a human wants to review permissions, contributions, and dependencies before deciding to consent. Idempotent — call again or pass an empty id to close. | 동의 모달 미리보기 확인 권한 검사

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id. Empty string or omit to close the modal. |

**Returns**: { id, shown }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.consent.preview '{"id":"soksak-plugin-<id>"}'
sok-dev plugin.consent.preview '{"id":""}'  # 닫기
```

## `plugin.consent.revoke` (danger: destructive)

Revoke a recorded consent, putting the plugin back into a re-consent-required state. If active, the plugin and all transitive dependents are disabled first. Safe because it only reduces permissions. | 동의 철회 취소 revoke 권한 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.consent.revoke '{"id":"soksak-plugin-<id>"}'
```

## `plugin.consent.summary`

Fetch the consent display data for a plugin — permissions, contribution counts, and dependency tree (plugins + libraries). Same single source used by the consent modal. Use to inspect what the user will be asked to consent to. | 플러그인 동의 요약 권한 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, version, permissions, contributes, dependencies:{plugins,libraries} }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.consent.summary '{"id":"soksak-plugin-<id>"}'
```

## `plugin.deps`

Inspect the plugin dependency graph. With an id, returns that plugin's dependencies, dependents, reference count, and cascade impact. Without an id, returns all version integrity issues across installed plugins. | 플러그인 의존성 의존 그래프

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id. Omit to list all version integrity issues. |

**Returns**: { summary?, issues? }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.deps
sok-dev plugin.deps '{"id":"soksak-plugin-<id>"}'
```

## `plugin.dev.create` (danger: inject)

Scaffold a new plugin in the current identity home's workspaces/plugins/<id> directory, register that absolute directory as its development source, initialize Git, and reload plugins. Available in every build, not only development builds. | 플러그인 개발 새로 만들기 스캐폴드 scaffold 생성

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id (must match ^[a-z0-9][a-z0-9-]*$) |

**Returns**: { ok, dir, pluginId }
**Errors**: INVALID_PARAMS

```bash
sok-dev plugin.dev.create '{"id":"soksak-plugin-<id>"}'
```

## `plugin.dev.load` (danger: inject)

Select an existing absolute plugin workspace as this identity home's development source, validate its plugin.json, and load it without replacing a separate official installation. Development (dev) identity only — debug and release homes verify published installs (home-lane rule). Dev-sourced plugins bypass the consent gate (spec §0-5 exception). | 플러그인 개발 로드 dev 임시 적재

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute path to the plugin directory |

**Returns**: { id, dir }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev plugin.dev.load '{"path":"/path/to/my-plugin"}'
```

## `plugin.disable` (danger: destructive)

Deactivate a plugin and revoke all of its registered commands, views, and extensions (spec §0-4). Use when you want to stop a plugin without removing it. | 플러그인 비활성화 끄기 disable

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, status }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.disable '{"id":"soksak-plugin-<id>"}'
```

## `plugin.enable` (danger: inject)

Activate a plugin so its code begins executing. Returns CONSENT_REQUIRED if the user has not yet consented via the UI consent modal — remote enable without recorded consent is always blocked. | 플러그인 활성화 켜기 enable

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, status }
**Errors**: TARGET_NOT_FOUND, CONSENT_REQUIRED, INTERNAL

```bash
sok-dev plugin.enable <name>
sok-dev plugin.enable '{"id":"soksak-plugin-<id>"}'
```

## `plugin.implementers`

Find plugins whose exact {id, version} provider declaration implements a domain contract. Pass id alone to discover every implementer regardless of version; add range to filter by SemVer. Omit both to list exact provider evidence. Domain ids never embed a version. | 플러그인 계약 구현체 발견 구현 스펙 컨트랙트

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Version-free public domain contract id. |
| `range` | string |  | Supported SemVer range. Optional — omit to discover every version. |

**Returns**: { contract, implementers: [{id, version, status}] } (contract given) | { contracts: [{contract, implementers}] } (omitted)
**Errors**: INVALID_PARAMS

```bash
sok-dev plugin.implementers
sok-dev plugin.implementers '{"id":"soksak-spec-plugin-git","range":"0.0.1"}'
```

## `plugin.install` (danger: destructive)

Install one authenticated plugin release and its complete plugin/sidecar/kit dependency closure from one registry. Git URLs, branches, package registries, and local paths are not installation sources. | 플러그인 설치 추가 install

| Parameter | Type | Required | Description |
|---|---|---|---|
| `registryId` | string |  | Registry id for a qualified catalog install |
| `source` | string |  | Official registry short name (for example "activity") |
| `unitId` | string |  | Unit id for a qualified catalog install |

**Returns**: { id, generation }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND, AMBIGUOUS_TARGET, INTERNAL

```bash
sok-dev plugin.install activity
sok-dev plugin.install '{"registryId":"community","unitId":"soksak-plugin-<id>"}'
```

## `plugin.list`

List all installed and dev plugins with their runtime status, permissions, and rejection reasons. rejected holds one entry per directory whose manifest failed validation (dir = plugin folder, errors = the specific validation failures). Use to check which plugins exist and whether any failed to load. | 플러그인 목록 설치된 확장 상태

**Returns**: { plugins: [{id, name, version, status, permissions, …}], rejected: [{dir, errors}] }

```bash
sok-dev plugin.list
```

## `plugin.new`

Scaffold a new releasable plugin under the plugins workspace: package.json (soksakRelease block + private product boundary) + plugin.json (a content view + a wired <id>-root node + a hello command) + the tracked main.js entry, release-files.json (the declared shipped set + single-source discovery marker), src/conformance.test.ts (declared≡wired nodes), tsconfig.json, and the THIN release.yml/test.yml that check out the pinned soksak-spec and run the single-source plugin build-release/publish — it vendors ZERO release scripts. git-inits + registers it as a dev unit. name is unprefixed (id = soksak-plugin-<name>). | 플러그인 생성 새 스캐폴드 scaffold

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Unprefixed name; id becomes soksak-plugin-<name> |

**Returns**: { ok, dir, id }

```bash
sok-dev plugin.new '{"name":"widget"}'
```

## `plugin.reload`

Rescan the plugins directory and reactivate every plugin whose consent is still valid; the response reports which manifests were rejected during the rescan and why. With id, reload only that one plugin instead: its plugin.json is read from disk again and re-validated, then the plugin is disabled and re-enabled (same consent gate as plugin.enable) without rescanning the directory or touching any other plugin. A manifest that no longer validates is refused with its reason instead of activating fresh code against a stale declaration. Use after manually editing plugin files or adding new plugin folders. | 플러그인 재적재 리로드 새로고침

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id to reload individually. Omit to rescan the plugins directory and reactivate every plugin. |

**Returns**: { reloaded, rejected: [{id, reason}] } (id omitted — full rescan; rejected lists directories whose manifest failed validation) | { id, status } (id given — that plugin only; a failure reason is in the response message)
**Errors**: TARGET_NOT_FOUND, CONSENT_REQUIRED

```bash
sok-dev plugin.reload
sok-dev plugin.reload '{"id":"soksak-plugin-<id>"}'
```

## `plugin.remove` (danger: destructive)

Remove a plugin and its directory. Plugin-owned data (plugins-data) is preserved. Blocked with CASCADE_REQUIRED if dependents exist unless cascade:true is passed to remove them transitively. | 플러그인 제거 삭제 uninstall

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cascade` | boolean |  | When true, also removes all transitive dependents. Omit to block if any dependents exist. |
| `id` | string | ✓ | Plugin id |

**Returns**: { id, removed: [removed ids …] }
**Errors**: TARGET_NOT_FOUND, CASCADE_REQUIRED, INTERNAL

```bash
sok-dev plugin.remove '{"id":"soksak-plugin-<id>"}'
sok-dev plugin.remove '{"id":"soksak-plugin-<id>","cascade":true}'
```

## `plugin.settings.get`

Read plugin setting values at a given scope. Scope 'effective' (default) merges global defaults with project overrides. Omit key to retrieve all settings at once. | 플러그인 설정 조회 읽기 값 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string |  | Setting key. Omit to return all settings. |
| `project` | string |  | Project id. Defaults to active project. Applies to project and effective scopes. |
| `scope` | string |  | effective (default, merges global+project) | global | project (effective|global|project) |

**Returns**: { id, scope, projectId, values } or { id, scope, projectId, key, value }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev plugin.settings.get '{"id":"soksak-plugin-<id>"}'
sok-dev plugin.settings.get '{"id":"soksak-plugin-<id>","key":"defaultAgent","scope":"global"}'
```

## `plugin.settings.open`

Open the unified settings modal. With a plugin id, navigates directly to that plugin's settings section. Omit id for the general preferences section. Pass an empty string to close the modal. Idempotent. | 설정 열기 환경설정 모달 플러그인 패널

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id (omit for general preferences, empty string to close) |

**Returns**: { section }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.settings.open
sok-dev plugin.settings.open '{"id":"soksak-plugin-<id>"}'
```

## `plugin.settings.reset`

Remove a setting override and restore the default value. Scope defaults to global. Omit key to reset all settings at once. | 플러그인 설정 초기화 리셋 기본값

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string |  | Setting key. Omit to reset all settings. |
| `project` | string |  | Project id. Defaults to active project. Applies when scope=project. |
| `scope` | string |  | global (default) | project (global|project) |

**Returns**: { id, scope, key, projectId?, projectRoot? }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev plugin.settings.reset '{"id":"soksak-plugin-<id>","key":"defaultAgent"}'
```

## `plugin.settings.schema`

Return the plugin's settings schema from its manifest configuration block. This is the single source of truth from which both UI and CLI derive setting fields and validation rules. | 플러그인 설정 스키마 구성 항목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, configuration: ConfigSetting[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.settings.schema '{"id":"soksak-plugin-<id>"}'
```

## `plugin.settings.set`

Write a plugin setting value after schema validation. Scope defaults to global; use project to override per-project. Validation failures are rejected without saving. | 플러그인 설정 변경 저장 set 값 지정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string | ✓ | Setting key |
| `project` | string |  | Project id. Defaults to active project. Applies when scope=project. |
| `scope` | string |  | global (default) | project (global|project) |
| `value` | json | ✓ | Value to set (boolean | number | string — must match schema type) |

**Returns**: { id, scope, key, value, projectId?, projectRoot? }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev plugin.settings.set '{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"codex"}'
sok-dev plugin.settings.set '{"id":"soksak-plugin-<id>","key":"defaultAgent","value":"gemini","scope":"project"}'
```

## `plugin.update` (danger: destructive)

Replace an installed plugin and its complete dependency closure with the greatest authenticated release from its registry. Re-consent is required when the verified manifest changes permissions. | 플러그인 업데이트 갱신 최신화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `registryId` | string |  | Origin registry id when the unit id exists in multiple registries |

**Returns**: { id, version, generation }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS, INTERNAL

```bash
sok-dev plugin.update '{"id":"soksak-plugin-<id>"}'
```

## `plugin.view.close`

Close a plugin view. Sidebar placements are deselected and revert to the file tree. Content placements close the tab in every pane where the view is open. | 플러그인 뷰 닫기 사이드바 탭 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id. Defaults to the active project. |
| `viewKey` | string | ✓ | Global view key in the form "<pluginId>.<viewId>" |

**Returns**: { viewKey, projectId, closed: [placement list], tabIds: [closed content tab ids] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev plugin.view.close '{"viewKey":"soksak-plugin-<id>.<view>"}'
```

## `plugin.view.open`

Open a plugin view in the specified placement. Defaults to the view's declared defaultPlacement when placement is omitted. View implementation and placement are orthogonal (spec §0-6). | 플러그인 뷰 열기 사이드바 칸 탭 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `placement` | string |  | Where to place the view. Defaults to the view's defaultPlacement. (content|rail|rail-footer) |
| `project` | string |  | Project id. Defaults to the active project. |
| `viewKey` | string | ✓ | Global view key in the form "<pluginId>.<viewId>" |

**Returns**: { viewKey, placement, projectId } (sidebar placements) | { viewKey, placement, projectId, paneId, tabId, existing } (content placement)
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev plugin.view.open '{"viewKey":"soksak-plugin-<id>.<view>"}'
sok-dev plugin.view.open '{"viewKey":"soksak-plugin-<id>.<view>","placement":"content"}'
```

## `process.list`

List the child processes the app spawned for plugins: handle id, OS pid, the window that spawned it, the command, and whether it is still alive. The handle id is a small counter and is not an OS pid — ask liveness with pid. An entry that is no longer alive but still listed is an orphan its owner failed to reclaim. Read-only. | 프로세스 목록 자식 고아 좀비 사이드카 스폰 생존

| Parameter | Type | Required | Description |
|---|---|---|---|
| `alive` | boolean |  | Only entries that are still running |
| `window` | string |  | Only entries spawned by this window label |

**Returns**: { processes: [{id, pid, window, cmd, group, detached, alive}], count }

```bash
sok-dev process.list
sok-dev process.list '{"alive":true}'
```

## `program.list`

List all programs available in the new-tab menu. Every entry is plugin-registered; nothing is built-in. Use to discover launchable programs and their menu category paths. | 프로그램 목록 앱 메뉴 새탭

**Returns**: { programs: [{ id, title, path?, kind, pluginId }] }

```bash
sok-dev program.list
```

## `project.activate`

Switch to a different project, making it active. | 프로젝트 전환 바꾸기 이동

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.activate '{"project":"t2"}'
```

## `project.close` (danger: destructive)

Close a project. Refuses to close the last remaining project. | 프로젝트 닫기 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: { activeProjectId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev project.close '{"project":"t2"}'
```

## `project.color`

Set the accent color for a project (rail chip and tab highlight). Omit color to remove. | 프로젝트 색 색상 탭 색깔

| Parameter | Type | Required | Description |
|---|---|---|---|
| `color` | string |  | CSS color (e.g. #4a8fe8). Omit to revert to default. |
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: { projectId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.color '{"project":"pjt-a2b3c4","color":"#4a8fe8"}'
```

## `project.list`

List all projects with id, title, root path, and active state. | 프로젝트 목록 리스트 열린

**Returns**: { projects: [{id,title,root,active}] }

```bash
sok-dev project.list
```

## `project.open`

Open a project (creates it if it doesn't exist yet). When root is omitted, folder (slug) is required — creates and uses ~/.soksak/projects/<folder>. Home (~) and root (/) are forbidden as root. Duplicate root activates the existing project instead. | 프로젝트 만들기 새 생성 열기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `alias` | string |  | Tab alias (omit = folder name) |
| `folder` | string |  | Required when root is omitted — ^[a-z0-9][a-z0-9-]*$, used as ~/.soksak/projects/<folder> |
| `program` | string |  | Initial view program (omit = empty space tab) |
| `root` | string |  | Project root directory (absolute path — home/root forbidden) |
| `shell` | string |  | Terminal shell path (omit = global setting → $SHELL) |

**Returns**: { projectId, spaceId, paneId, tabId, existing? } | { existingWindow } (already open in another window — focused instead) | { routedWindow } (called on the control-plane window — opened in a new project window instead)
**Errors**: INVALID_PARAMS

```bash
sok-dev project.open '{"root":"/Users/me/work","program":"claude"}'
sok-dev project.open '{"folder":"my-project"}'
```

## `project.recent`

List recent projects (the cross-window recents feeding the control-plane project map and the project rail): root, alias, last-opened timestamp. Same list from any window (core kv). | 최근 프로젝트 목록 연 픽커 레일

**Returns**: { recents: [{root, alias, lastOpenedAt}] }

```bash
sok-dev project.recent
```

## `project.recent.remove`

Remove a project from the recents list (project map/rail). Does not touch the project on disk — only the recents entry. Idempotent (missing root is a no-op). | 최근 프로젝트 제거 목록에서 지우기 잊기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `root` | string | ✓ | Project root to forget |

**Returns**: { ok }

```bash
sok-dev project.recent.remove '{"root":"/Users/me/old"}'
```

## `project.rename`

Rename a project tab. | 프로젝트 이름 바꾸기 변경 제목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |
| `title` | string | ✓ | New project name |

**Returns**: { projectId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.rename '{"project":"pjt-a1b2c3","title":"백엔드"}'
```

## `project.rightbar.toggle`

Toggle the right plugin sidebar (⌥⌘B). Provide open to set state explicitly (idempotent). | 우측 사이드바 오른쪽 패널 플러그인 바 열기 닫기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `open` | boolean |  | When provided, force open or closed |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, rightOpen }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.rightbar.toggle
sok-dev project.rightbar.toggle '{"open":true}'
```

## `project.sidebar.toggle`

Toggle the file-tree sidebar for a project. | 사이드바 파일트리 열기 닫기 토글

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, sidebarOpen }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.sidebar.toggle
```

## `project.update`

Batch-update project settings. Omitted fields are preserved; "" removes the override. root is immutable.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `color` | string |  | Accent color ("" = remove) |
| `project` | string | ✓ | Target project id (omit = caller's context project) |
| `shell` | string |  | Terminal shell path ("" = default) |
| `title` | string |  | Alias (empty string is ignored) |

**Returns**: { projectId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev project.update '{"project":"pjt-a2b3c4","title":"백엔드","shell":"/bin/zsh"}'
```

## `pty.daemon.restart` (danger: destructive)

Restart the PTY session daemon. Destructive: every daemon-owned shell and its child processes are killed before a fresh daemon is staged and started — open terminals lose their sessions and respawn fresh shells. | pty데몬 재시작 터미널 데몬

**Returns**: { killed, pid }
**Errors**: INTERNAL

```bash
sok-dev pty.daemon.restart
```

## `pty.daemon.status`

Report the PTY session daemon (soksak-ptyd): whether it is running, its pid and protocol generation, how many shell sessions it owns, and whether the staged binary exists in the identity home. A dead daemon here means terminals fall back to in-process PTYs on their next spawn. | pty데몬 상태 터미널 데몬 세션

**Returns**: { running, pid?, sessions?, protocol, staged, stagedPath }
**Errors**: INTERNAL

```bash
sok-dev pty.daemon.status
```

## `pty.daemon.upgrade`

Hot-upgrade the PTY session daemon in place — no restart, no lost sessions. The running daemon stages the new binary, hands each live shell's master fd to a new daemon by fd inheritance (the shell never sees a SIGHUP), then exits. Distinct from pty.daemon.restart, which kills every shell. Use it to roll a new ptyd generation without disturbing open terminals. | pty데몬 판올림 무중단 업그레이드 데몬 핫스왑

**Returns**: { upgraded, pid, sessions }
**Errors**: INTERNAL

```bash
sok-dev pty.daemon.upgrade
```

## `pty.session.alive`

Report whether the PTY daemon still holds a live shell for this session id — true even across an app restart before anything reattaches. Distinct from being attached in this window (see pty.session.list). | 헤드리스 세션 생존 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | ✓ | Session id |

**Returns**: { session, alive, attached }
**Errors**: INVALID_PARAMS

```bash
sok-dev pty.session.alive '{"session":"agent-k3f9a2-1"}'
```

## `pty.session.kill` (danger: destructive)

Close a headless PTY session and its daemon shell. | 헤드리스 세션 종료

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | ✓ | Session id |

**Returns**: { session }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev pty.session.kill '{"session":"agent-k3f9a2-1"}'
```

## `pty.session.list`

List headless PTY sessions attached in this window. | 헤드리스 세션 목록

**Returns**: { sessions: [{session, bytesSeen, spawnedAt}] }

```bash
sok-dev pty.session.list
```

## `pty.session.read`

Read the raw output tail of a headless PTY session (bounded ring, ANSI included — the reader interprets). Returns the tail joined and the total bytes seen as a resume cursor. | 헤드리스 세션 출력 읽기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lines` | number |  | Trailing lines to keep (default all buffered) |
| `session` | string | ✓ | Session id |

**Returns**: { session, tail, bytesSeen }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev pty.session.read '{"session":"agent-k3f9a2-1","lines":200}'
```

## `pty.session.spawn` (danger: inject)

Spawn (or warm-reattach) a headless daemon-backed PTY session under a caller-chosen session id. No tab is created; the core drains and acks output into a bounded raw tail readable via pty.session.read. Respawning the same session id reattaches to the still-running shell; pass replayFromSeq to skip ring replay up to a sequence already consumed. | 헤드리스 터미널 세션 생성 재부착

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cols` | number |  | Columns (default 200) |
| `cwd` | string |  | Working directory |
| `replayFromSeq` | number |  | Warm-reattach: attach the daemon ring from this sequence |
| `rows` | number |  | Rows (default 50) |
| `session` | string | ✓ | Caller-owned session id |
| `shell` | string |  | Shell binary (default: user shell) |

**Returns**: { session, attached }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev pty.session.spawn '{"session":"agent-k3f9a2-1","cwd":"/tmp"}'
```

## `pty.session.write` (danger: inject)

Write raw bytes (text) to a headless PTY session created by pty.session.spawn. | 헤드리스 세션 입력 쓰기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `data` | string | ✓ | Raw text to write |
| `session` | string | ✓ | Session id |

**Returns**: { session, bytes }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev pty.session.write '{"session":"agent-k3f9a2-1","data":"ls\r"}'
```

## `registry.add`

Add a public or private registry descriptor. The descriptor is strict: a credential-free HTTPS index URL and pinned Ed25519 public key. For private registries the core derives one vault credential slot from registry id; descriptors cannot select a namespace/key, and raw tokens, headers, passwords, URL userinfo, queries, and fragments are rejected. | 레지스트리 추가 공개 비공개 신뢰키 vault

| Parameter | Type | Required | Description |
|---|---|---|---|
| `descriptor` | json | ✓ | {id,name,indexUrl,visibility:'public'|'private',trustedPublicKey:{algorithm:'ed25519',keyId,value}}; private credentialRef is core-derived read-only metadata |

**Returns**: { registryId }
**Errors**: INVALID_PARAMS, ALREADY_EXISTS

```bash
sok-dev registry.add '{"descriptor":{"id":"community","name":"Community","indexUrl":"https://registry.example/index.json","visibility":"public","trustedPublicKey":{"algorithm":"ed25519","keyId":"publisher-1","value":"<base64-32-byte-public-key>"}}}'
```

## `registry.list`

List configured official, public, and private registry descriptors with pinned public-key metadata and per-registry status. A private credential is represented only by its core-derived opaque slot reference; secret values are never returned. | 레지스트리 목록 공개 비공개 신뢰키 상태

**Returns**: { registries: [{id,name,indexUrl,visibility,trustedPublicKey,credentialRef?,status,unitCount,lastFetchedAt,error}] }

```bash
sok-dev registry.list
```

## `registry.refresh`

Fetch and verify one registry or all registries. Only an index signed by the descriptor-pinned Ed25519 key becomes live; unsigned or mismatched indexes remain uncertified and cached units are not replaced. | 레지스트리 새로고침 서명 검증 인증

| Parameter | Type | Required | Description |
|---|---|---|---|
| `force` | boolean |  | Refetch even when this session already fetched [default true] |
| `registryId` | string |  | Registry id; omit to refresh all |

**Returns**: { results: [{registryId,status,error?,skipped?}] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev registry.refresh
sok-dev registry.refresh '{"registryId":"community"}'
```

## `registry.remove` (danger: destructive)

Remove a user-added registry descriptor and its cached units. The built-in official registry is immutable and cannot be removed. | 레지스트리 제거 삭제

| Parameter | Type | Required | Description |
|---|---|---|---|
| `registryId` | string | ✓ | Registry descriptor id |

**Returns**: { registryId }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev registry.remove '{"registryId":"community"}'
```

## `registry.status`

Read per-registry fetch, certification, error, last-fetch, and recent lifecycle-event state without performing network I/O. | 레지스트리 상태 오류 이벤트 인증

| Parameter | Type | Required | Description |
|---|---|---|---|
| `registryId` | string |  | Registry id; omit for all |

**Returns**: { registries: [descriptor+status], events: [{seq,at,type,registryId,detail?}] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev registry.status
sok-dev registry.status '{"registryId":"official"}'
```

## `release.build`

Build the owner release manifest (release.json) + 3 conformance reports for a unit from an artifacts dir holding exactly the 5-target archive set + their .sha256 sidecars. Runs the single-source release-template builder with --emit-summary and returns the parsed manifest + per-target digests. Every invariant (checksum match, exact matrix, version/tag lockstep) is enforced by the builder. Chain into release.validate. | 릴리즈 빌드 build 매니페스트 발행

| Parameter | Type | Required | Description |
|---|---|---|---|
| `artifacts` | string | ✓ | Dir with the 5 .tar.gz + 5 .sha256 |
| `commit` | string | ✓ | Source commit — exact lowercase 40-char git SHA |
| `out` | string | ✓ | Empty output dir for release.json + conformance reports |
| `specRoot` | string | ✓ | soksak-ai/soksak-spec checkout providing the release-template |
| `tag` | string | ✓ | Release tag, must equal v<version> |
| `unitRoot` | string | ✓ | The unit repo root (cwd; holds Cargo.toml + release/) |

**Returns**: { ok, releaseJson, manifestSha256, matrix }

```bash
sok-dev release.build '{"unitRoot":"…","specRoot":".pipeline","commit":"<40hex>","tag":"v0.0.1","artifacts":"dist","out":"dist-release"}'
```

## `release.publish` (danger: destructive)

Cut the immutable GitHub release for a unit: require owner-enforced immutable releases, require EXACTLY the 5 platform archives + 5 checksums + release.json + 3 conformance reports, then create the release. IRREVERSIBLE — an immutable tag cannot be recut, only bumped. Requires confirm:true. gh auth comes from the token param (injected as GH_TOKEN into the child) or the operator's ambient gh. In CI the per-unit workflow's own gh step publishes; this command is for operator-with-gh use. | 릴리즈 발행 publish immutable 생성

| Parameter | Type | Required | Description |
|---|---|---|---|
| `artifactsDir` | string | ✓ | Dir with the 5 .tar.gz + 5 .sha256 |
| `commit` | string | ✓ | Target commit SHA for the release |
| `confirm` | boolean | ✓ | Must be true — this cuts an immutable, unrecuttable release |
| `releaseDir` | string | ✓ | Dir with release.json + 3 conformance reports |
| `repo` | string | ✓ | owner/name, e.g. soksak-ai/soksak-sidecar-db-studio |
| `tag` | string | ✓ | Release tag (v<version>) |
| `token` | string |  | GitHub token; injected as GH_TOKEN (else ambient gh) |

**Returns**: { ok, url }

```bash
sok-dev release.publish '{"repo":"soksak-ai/soksak-sidecar-db-studio","tag":"v0.0.1","commit":"<sha>","artifactsDir":"dist","releaseDir":"dist-release","confirm":true}'
```

## `release.validate`

Validate a built release directory (release.json + 3 conformance reports) against the pinned public soksak-spec validator. Read-only. specRoot MUST be a checkout of soksak-ai/soksak-spec at the pinned commit — validate-with-spec.mjs refuses any other checkout (the consumer-contract drift guard). Runs the single-source release-template logic; no algorithm lives in the command. | 릴리즈 검증 validate 발행 검증기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `releaseDir` | string | ✓ | Dir holding release.json + 3 conformance reports |
| `specRoot` | string | ✓ | Pinned soksak-ai/soksak-spec checkout root |
| `unitRoot` | string | ✓ | The unit repo root (cwd for the script) |

**Returns**: { ok, stdout }

```bash
sok-dev release.validate '{"unitRoot":"…","specRoot":".pipeline","releaseDir":"dist-release"}'
```

## `remote.confirm` (danger: destructive)

Show the desktop human confirm modal for a destructive remote action and await the decision (approve/deny). Called by the remote-iroh sidecar over the socket: the sidecar owns the confirm authority (parking, TTL, token issuance) and delegates only the human decision here. The phone cannot self-approve — the decision comes only from this desktop modal. Returns { approve }. | 원격 destructive 데스크톱 사람 confirm 모달 승인 거부

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | Human-readable command summary to show (e.g. pane.close). |
| `danger` | boolean |  | Always true on this path (destructive only). |
| `device_id` | string | ✓ | Requesting remote device label to show. |
| `params` | string |  | Optional params summary string to show. |
| `request_id` | number | ✓ | Sidecar-issued confirm id (the sidecar resolves its PendingConfirms with this). |
| `ttl_secs` | number |  | Countdown seconds before auto-deny (mirrors sidecar TTL). |

**Returns**: { approve }

```bash
sok-dev remote.confirm '{"request_id":42,"device_id":"iphone-15","command":"pane.close","danger":true,"ttl_secs":30}'
```

## `schedule.cancel`

Cancel a pending schedule by id. Returns removed=true if the schedule existed. | 스케줄 취소 삭제 예약취소 cancel

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Schedule id issued by schedule.set |

**Returns**: { removed }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev schedule.cancel '{"id":"sch-3"}'
```

## `schedule.list`

List all jobs sorted by next fire time ascending. Each: { id, trigger, command, params, next_at, running, concurrency }. next_at=null means waiting (reconcile/event) or running. running=true means a fire is in flight (lease held). | 스케줄 목록 예약 리스트 조회

**Returns**: { schedules: [{ id, trigger, command, params, next_at, running, concurrency }] }
**Errors**: INTERNAL

```bash
sok-dev schedule.list
```

## `schedule.poke` (danger: inject)

Fire a job immediately (completion trigger / external change). id given = that job; omitted = all reconcile jobs. Running jobs coalesce (re-fire once after completion). | 스케줄 깨우기 poke 재평가 reconcile 틱

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Job id (omit = all reconcile jobs) |

**Returns**: { ok }
**Errors**: INTERNAL

```bash
sok-dev schedule.poke
sok-dev schedule.poke '{"id":"sch-3"}'
```

## `schedule.register` (danger: inject)

Register a scheduler job (trigger + registry command to fire). trigger = { kind:'at', at } | { kind:'every', every_ms, anchor? } | { kind:'cron', expr } | { kind:'reconcile' }. process_lease=true holds the lease until the fired command's process exits (no kill while running, zombie_backstop_ms cap, default 3h). retry = { max, base_ms, max_ms } for ok:false backoff. Returns the assigned id. Generalizes schedule.set. | 스케줄 등록 register 트리거 reconcile cron every 프로세스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | Registry command name to fire |
| `concurrency` | number |  | Reserved (per-job lease is always single) |
| `id` | string |  | Existing job id to replace (new id issued when omitted) |
| `params` | json |  | Command parameters (fired with the command) |
| `process_lease` | boolean |  | Hold lease until fired process exits (exec-one) |
| `retry` | json |  | { max, base_ms, max_ms } — backoff on ok:false |
| `timeout_ms` | number |  | Non-process wait cap (ms). Ignored when process_lease. |
| `trigger` | json | ✓ | { kind:'at'|'every'|'cron'|'reconcile', ... } |
| `zombie_backstop_ms` | number |  | Process-lease zombie cap (ms). null=infinite, default 3h |

**Returns**: { jobId }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev schedule.register '{"trigger":{"kind":"every","every_ms":60000},"command":"notify.show","params":{"title":"틱","body":"1분"}}'
sok-dev schedule.register '{"trigger":{"kind":"reconcile"},"command":"plugin.soksak-plugin-<id>.<command>","process_lease":true,"retry":{"max":5,"base_ms":2000,"max_ms":60000}}'
```

## `schedule.set` (danger: inject)

Schedule a registry command to fire once at an absolute epoch-ms timestamp. Generates a new id if omitted; replaces an existing schedule when id is supplied. For recurrence, re-arm after the command fires; compose with notify.show for reminders. | 스케줄 예약 타이머 알람 일정 등록

| Parameter | Type | Required | Description |
|---|---|---|---|
| `at` | number | ✓ | Fire time as epoch milliseconds |
| `command` | string | ✓ | Registry command name to fire |
| `id` | string |  | Existing schedule id to replace (a new id is issued when omitted) |
| `params` | json |  | Command parameters (defaults to empty object when omitted) |

**Returns**: { scheduleId }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev schedule.set '{"at":1750000000000,"command":"notify.show","params":{"title":"알림","body":"시간!"}}'
```

## `secret.backend`

Query the KEK backend label and whether sealing is available (compat shim over secret.status; unlocked = seal_available). Prefer secret.status. | 시크릿 볼트 상태 백엔드 봉인가능

**Returns**: { backend, unlocked }
**Errors**: INTERNAL

```bash
sok-dev secret.backend
```

## `secret.has`

Check whether ns/key exists in the vault without exposing the value (plaintext readback is blocked by the core). | 시크릿 존재 확인 있는지 has 체크

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { has }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev secret.has '{"ns":"soksak-plugin-<id>","key":"anthropicKey"}'
```

## `secret.keys`

List the secret key names stored under a namespace (values are never returned). Use to audit what is stored in a namespace. | 시크릿 목록 키 리스트 조회

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { keys: string[] }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev secret.keys '{"ns":"soksak-plugin-<id>"}'
```

## `secret.remove` (danger: destructive)

Remove ns/key from the vault (removed=true if the key existed). Rejected when the OS key store is unavailable (no secret service). | 시크릿 삭제 제거 지우기 delete

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { removed }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev secret.remove '{"ns":"soksak-plugin-<id>","key":"anthropicKey"}'
```

## `secret.set` (danger: inject)

Store a sensitive value under ns/key using envelope encryption (per-item DEK wrapped by the device KEK). Overwrites the existing value if the key already exists. Rejected when the OS key store is unavailable (no secret service). | 시크릿 저장 설정 키 값 set 보관

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |
| `value` | string | ✓ | Sensitive value to store |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev secret.set '{"ns":"soksak-plugin-<id>","key":"anthropicKey","value":"sk-ant-..."}'
```

## `secret.status`

Query the transparent-unlock status: KEK backend label, seal_available (whether the OS key store is reachable, so sealing/opening works), expect_vault (app.data envelope keys registered), and the stored app.data key ids. Use to check whether secrets can be sealed before performing operations. | 시크릿 볼트 상태 백엔드 봉인가능 status

**Returns**: { backend, seal_available, expect_vault, data_key_ids }
**Errors**: INTERNAL

```bash
sok-dev secret.status
```

## `service.status`

Report resident plugin services and their live status. Without `plugin`: { services: [{ plugin, status, ops, inflight, generation, secretDependent }] }. With `plugin`: { plugin, status } for that one. status is one of spawning|ready|draining|backoff:<n>|error:<reason>|stopped. Use to confirm a service is up, catch a crash/backoff loop, or watch a drain restart. | 상주 서비스 상태 조회 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `plugin` | string |  | Plugin id to query one service; omit for all. |

**Returns**: { services: [{ plugin, status, ops, inflight, generation, secretDependent }] } or { plugin, status }
**Errors**: INTERNAL

```bash
sok-dev service.status
sok-dev service.status '{"plugin":"<plugin-id>"}'
```

## `settings.get`

Retrieve all application settings. | 설정 확인 앱 조회 환경설정

**Returns**: { <every persisted setting>, iconSets[], theme, themeMode }

```bash
sok-dev settings.get
```

## `settings.set`

Change an application setting. key: language|projectTabPosition|iconSet|iconBox|focusIndicator|railRelation|railFill|focusDim|railSeamStyle|railPullFocused|railSolidColor|dimIdle|dimBlocked|appFontFamily|windowZoom|orchestratorAgent|orchestratorModel | 설정 변경 바꾸기 환경설정 폰트 크기 언어

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Setting key (language|projectTabPosition|iconSet|iconBox|focusIndicator|railRelation|railFill|focusDim|railSeamStyle|railPullFocused|railSolidColor|dimIdle|dimBlocked|appFontFamily|windowZoom|orchestratorAgent|orchestratorModel) |
| `value` | json | ✓ | Value — language:ko|en, projectTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, railRelation:tint|moment|stroke (rail-pane relation surface — tint fill only, moment flash on rebind, stroke outline+label), railFill:none|faint (bound-pane background in stroke mode — none is the default, faint is a 1% accent tint), focusDim:boolean (spotlight — every pane dims except the active one), railSeamStyle:seam|edge (how a manufactured adjacency is marked: seam dashes the inner shared edge, edge dashes the outer right edge), railPullFocused:boolean (how the focused pane ends up next to the rail — true pulls the pane to the rail and the rail holds still, so the adjacency is manufactured and marked dashed; false leaves the pane where it is and the rail travels to it, so the adjacency is real and the seam is solid. Both move something; enabling both would move two things), railSolidColor:string (CSS color for the solid seam, i.e. the real adjacency drawn when railPullFocused is false — empty leaves it to the theme), dimIdle:number (0-1 — how far a pane that is not focused sinks), dimBlocked:number (0-1 — how far a pane stranded between the rail and the focused pane sinks; deeper than dimIdle, or being covered is invisible), appFontFamily:string (CSS font-family stack), windowZoom:number (0.5-2.0 — whole-window zoom factor applied to the main webview and every child webview), orchestratorAgent:string (agent CLI command or path the natural-language console spawns), orchestratorModel:string (--model alias for the agent; empty = CLI default) |

**Returns**: { key, value }
**Errors**: INVALID_PARAMS

```bash
sok-dev settings.set '{"key":"projectTabPosition","value":"left"}'
sok-dev settings.set '{"key":"iconBox","value":true}'
```

## `sidebar.left.move`

Drag-merge a left sidebar view — into=merge as a tab, left/right=horizontal split, top/bottom=vertical split (same 4 directions as the content area). viewKeys/targets come from sidebar.left.tree. | 좌측 사이드바 탭 이동 합치기 분할 드래그 머지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `target` | string | ✓ | target viewKey (a view in the target group) |
| `viewKey` | string | ✓ | viewKey to move |
| `zone` | string | ✓ | into | left | right | top | bottom (4-direction, same as content area) (into|left|right|top|bottom) |

**Returns**: { projectId }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev sidebar.left.move '{"viewKey":"soksak-plugin-<id>.<view>","target":"soksak-plugin-<other-id>.<view>","zone":"right"}'
```

## `sidebar.left.position`

Read or set the project left rail position mode. Omit mode to query. flow (default) stands the rail at the focused pane's clean left line and travels with focus; pin without station freezes the current effective line; pin with station snaps to the nearest clean full-height grid line. The solved arrangement is what state.tree reports. | 좌측 사이드바 레일 위치 플로우 포커스 추종 핀 고정 그립 스냅

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | flow | pin; omit to query current position (flow|pin) |
| `project` | string |  | Target project id (omit = caller's context project) |
| `station` | number |  | Requested logical station in 0..100 for pin; omitted pin freezes the current effective station |

**Returns**: { projectId, leftRailPosition:{ mode, station?(persisted), effectiveStation, cleanLines[] } }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev sidebar.left.position
sok-dev sidebar.left.position '{"mode":"pin"}'
sok-dev sidebar.left.position '{"mode":"pin","station":50}'
sok-dev sidebar.left.position '{"mode":"flow"}'
```

## `sidebar.left.resize`

Resize the left sidebar split that holds a view — sizes are parallel to that split's children (sum 1). The tree's interior nodes have no name, so the split is named by one of the views inside it (viewKeys from sidebar.left.tree). | 좌측 사이드바 분할 비율 크기 조절

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `sizes` | number[] | ✓ | Ratio per child, sum 1 |
| `viewKey` | string | ✓ | A viewKey inside the split to resize (its own tab group's split) |

**Returns**: { projectId, sizes }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok-dev sidebar.left.resize '{"viewKey":"soksak-plugin-<id>.<view>","sizes":[0.6,0.4]}'
```

## `sidebar.left.tree`

Return the left sidebar layout tree (SplitTree of tab groups) — direction, sizes, each leaf's viewKeys + active. Source for sidebar.left.move/resize targets, which name a viewKey (the tree's interior nodes have no name). | 좌측 사이드바 레이아웃 트리 탭 분할 구조

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, layout }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev sidebar.left.tree
```

## `sidebar.right.mode`

Right sidebar layout mode — overlay (floats over content) or push (occupies area like the left sidebar). Global setting; omit mode to query current. | 우측 사이드바 밀기 영역차지 오버레이 모드 도킹

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | overlay | push — omit to query current |

**Returns**: { mode }
**Errors**: INVALID_PARAMS

```bash
sok-dev sidebar.right.mode
sok-dev sidebar.right.mode '{"mode":"push"}'
```

## `sidecar.new`

Scaffold a new releasable service sidecar under the sidecars workspace: Cargo.toml + release/unit.json (identity), the STATIC targets.json + spec-validator.json pins (byte-verbatim), a serve skeleton (src/{main,lib,service}.rs + tests/wire.rs), stage.sh, and the THIN release.yml that references the single-source pipeline in soksak-spec — it vendors ZERO release scripts. git-inits + registers it as a dev unit. name is unprefixed (id = soksak-sidecar-<name>). | 사이드카 생성 새 스캐폴드 scaffold

| Parameter | Type | Required | Description |
|---|---|---|---|
| `interface` | string |  | Interface id (default soksak-spec-sidecar-<name>) |
| `name` | string | ✓ | Unprefixed name; id becomes soksak-sidecar-<name> |

**Returns**: { ok, dir, id }

```bash
sok-dev sidecar.new '{"name":"widget"}'
```

## `space.activate`

Switch to a specific space tab, making it active. | 탭 이동 전환 바꾸기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `space` | string | ✓ | Target space tab id |

**Returns**: { projectId, spaceId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev space.activate '{"space":"spc-d5e6f7"}'
```

## `space.close` (danger: destructive)

Close a space tab. Refuses to close the last remaining space. | 탭 닫기 스페이스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `space` | string | ✓ | Target space tab id |

**Returns**: { projectId, spaceId(closed), activeSpaceId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev space.close '{"space":"spc-d5e6f7"}'
```

## `space.create`

Create a new space tab. Program priority: explicit > project setting > global setting. | 새 탭 스페이스 추가 새로 열기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `program` | string |  | Program id — plugin-registered only (see program.list; no built-in default). Omitted or unregistered id opens a blank pane |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, spaceId, paneId, tabId? }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev space.create '{"program":"browser"}'
```

## `space.list`

List space tabs in a project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, spaces: [{id,title,active}] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev space.list
```

## `space.rename`

Rename a space tab.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `space` | string | ✓ | Target space tab id |
| `title` | string | ✓ | New name |

**Returns**: { projectId, spaceId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev space.rename '{"space":"spc-d5e6f7","title":"빌드"}'
```

## `space.switchScan`

Measure a space-tab switch as the user sees it: record the switch and report whether the new space lands in a single clean frame or smears across several (jank), via per-frame pixel change in the content area. Detects same-color switches that brightness can't. Restores the original tab. Replaces ad-hoc capture scripts. | 탭 전환 측정 깜빡임 jank 스페이스 검사 단일프레임

| Parameter | Type | Required | Description |
|---|---|---|---|
| `applyAtMs` | number |  | Delay after recording starts before switching (default 250) |
| `frames` | number |  | Frames to capture (default 30) |
| `from` | string |  | Space id to start on (default: current active) |
| `intervalMs` | number |  | Frame interval ms (default 16) |
| `project` | string |  | Target project id (omit = caller's context project) |
| `region` | json |  | Content area fractional rect {x0,y0,x1,y1} (0..1). Default covers the space's content area. |
| `settleMs` | number |  | Settle wait on the start space (default 600) |
| `threshold` | number |  | Noise floor (changed-pixel fraction) below which no switch is reported (default 0.003). Detection above the floor is peak-relative, so it adapts to the switch's magnitude. |
| `to` | string | ✓ | Target space tab id |

**Returns**: { projectId, spaceId(measured), frames, frameMs, switchFrame, switchFrames (consecutive changed = jank spread), clean, diffsPct }

```bash
sok-dev space.switchScan '{"from":"spc-d5e6f7","to":"spc-h2j3k4"}'
sok-dev space.switchScan '{"to":"spc-h2j3k4","frames":40}'
```

## `state.commands`

Full command catalog with parameter schemas, returns, errors, and examples — the source of truth for all available commands.

**Returns**: { commands: [{name,description,params,returns,errors,examples}] }

```bash
sok-dev commands
```

## `state.context`

Resolve the caller's position: project/space/pane/tab that $SOKSAK_CALLER_TAB belongs to (falls back to active chain when called outside a terminal).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string |  | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |

**Returns**: { projectId, spaceId, paneId, tabId?, callerTab? } — tabId is absent when the pane is empty; callerTab is the terminal tab this call came from
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev state.context
```

## `state.health`

Report the liveness of the core's observation wiring: command registry size, execution trace sink, and activity hub publishing (attempts/ok/failed/consecutive/lastError/lastStampAt). Use this when responses look fine but nothing is being recorded. | 상태 진단 건강 관측 배선

**Returns**: { ready, commands{registered,traceSinkInstalled,emitted,lastEmitAt}, activity{...}, persist{...}, degradedAxes, ledger{minSeq,maxSeq,gaps,timeRegressions,singleWriter,persist} — ledger 는 cored 가 답한다(저장소를 쓰는 프로세스가 둘이라 한쪽만으로는 판정할 수 없다) }

```bash
sok-dev state.health
```

## `state.tree`

Full layout snapshot (address book): all ids and active state across project → space → pane (display rect %) → tab. Each space exposes displayed and canonical stored layouts plus projection provenance; each project exposes its effective left-rail position and clean grid lines.

**Returns**: { activeProjectId, projects[].{ leftRailPosition, spaces[].{ layout, canonicalLayout, projection, railRelation:{boundTabId,boundPaneId,connected}?, panes[] } } } — layout/panes are displayed state; canonicalLayout is the stored SplitTree

```bash
sok-dev state.tree
```

## `status.query`

Query the status each view reports (R8 회신) — what setStatus / file dirty / terminal running pushed. Omit tab to list every reporting tab. | 상태 조회 뷰 status 무엇이 도는지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string |  | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |

**Returns**: { statuses: Array<{ tabId, code, message? }> }

```bash
sok-dev status.query
sok-dev status.query '{"tab":"tab-k5m6n7"}'
```

## `system.hello`

Greet the app and read the socket protocol version, the oldest client protocol still served, and app identity (version, pid, start time, capabilities). A client sends this first to detect version skew before issuing commands. Also answered at the transport, so it replies even when the front is wedged. | 협상 핸드셰이크 헬로 인사 프로토콜 버전 스큐 호환 접속

**Returns**: { protocol, minClientProtocol, appVersion, identity, pid, startedAt, capabilities[] } — the socket protocol version, the oldest client protocol still served, and app identity.

```bash
sok-dev hello
```

## `tab.activate`

Activate (switch to) a specific tab. | 탭 전환 선택 활성화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string | ✓ | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |

**Returns**: { tabId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev tab.activate '{"tab":"tab-k5m6n7"}'
```

## `tab.close` (danger: destructive)

Close a tab — if it was the last tab in a pane, the pane is also removed. Refuses to close the last tab in a space. | 탭 닫기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string | ✓ | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |

**Returns**: { tabId(closed), activePaneId, activeTabId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev tab.close '{"tab":"tab-k5m6n7"}'
```

## `tab.label.get`

Get the custom tab label override for a sidebar view (empty = none, caller falls back to manifest title). Omit viewKey to list all overrides. | 사이드바 탭 라벨 조회 뷰 제목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `viewKey` | string |  | viewKey; omit to list all overrides |

**Returns**: { labels } or { viewKey, label }

```bash
sok-dev tab.label.get
sok-dev tab.label.get '{"viewKey":"x.y"}'
```

## `tab.label.set`

Set a custom tab label for a sidebar view (overrides the manifest title). Empty label clears the override (manifest fallback). viewKey = '<pluginId>.<viewId>' from ui.tree (tab/left/<key>). | 사이드바 탭 이름변경 라벨 뷰 제목 변경

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | ✓ | Custom label; empty to clear |
| `viewKey` | string | ✓ | viewKey '<pluginId>.<viewId>' |

**Returns**: { viewKey, label }
**Errors**: INVALID_PARAMS

```bash
sok-dev tab.label.set '{"viewKey":"soksak-plugin-<id>.<view>","label":"내 라벨"}'
```

## `tab.list`

List the tabs inside a pane.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string |  | Target pane id (omit = caller's context pane) |

**Returns**: { paneId, activeTabId, tabs[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev tab.list
```

## `tab.maximize`

Maximize a tab to fill the entire space. The split tree is preserved; only the display is toggled. Same as double-clicking a tab. Omit tab to maximize the active one. | 최대화 전체화면 탭 크게 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string |  | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |

**Returns**: { tabId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev tab.maximize '{"tab":"tab-k5m6n7"}'
sok-dev tab.maximize
```

## `tab.move`

Move a tab to the zone position of the dst pane (center = move into that pane; other = split and create a new pane). | 탭 이동 다른 칸으로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination pane id |
| `tab` | string | ✓ | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |
| `zone` | string | ✓ | Drop zone (center = move/merge; others = split in that direction) (center|left|right|top|bottom) |

**Returns**: { tabId, paneId(moved or created pane) }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok-dev tab.move '{"tab":"tab-k5m6n7","dst":"pan-g2h3j4","zone":"right"}'
```

## `tab.open`

Open a new tab in a pane by program id (terminal / claude / codex / a plugin view program). The answer waits until the view is mounted, so the returned tabId can be acted on immediately; mounted:false means it did not come up in time and commands aimed at it will not find it yet. | 탭 열기 추가 claude 터미널

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mountTimeoutMs` | number |  | How long to wait for the view to become actionable (default 5000). 0 answers as soon as the tab exists — mounted will be false and commands aimed at the tab may not find it yet. |
| `pane` | string |  | Target pane id (omit = caller's context pane) |
| `program` | string | ✓ | Program id — plugin-registered only (see program.list; no built-in default). Omitted or unregistered id opens a blank pane |

**Returns**: { paneId, tabId, mounted }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev tab.open '{"program":"claude"}'
```

## `tab.rename`

Set a custom label for a content tab. Overrides the dynamic content title (e.g. a browser page <title> keeps updating underneath; the override wins on display). Empty title clears the override and the dynamic title returns. Sidebar views use tab.label.set instead. | 탭 이름변경 탭명 변경 라벨

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string | ✓ | Target tab id (omit = caller's context tab, $SOKSAK_CALLER_TAB) |
| `title` | string | ✓ | Custom label; empty to clear the override |

**Returns**: { tabId, label }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev tab.rename '{"tab":"tab-k5m6n7","title":"작업 브라우저"}'
sok-dev tab.rename '{"tab":"tab-k5m6n7","title":""}'
```

## `tab.restore`

Exit tab maximize mode and restore the original split layout for the active space. | 최대화 해제 원래대로 레이아웃 복원

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, tabId(restored tab | null = was not maximized) }

```bash
sok-dev tab.restore
```

## `term.cwd`

Get the current working directory of a terminal tab (requires shell integration). | 현재 디렉토리 cwd 작업 폴더 터미널 경로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string |  | Target terminal tab id (omit = caller's context tab) |

**Returns**: { tabId, cwd|null }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev term.cwd
```

## `term.exec` (danger: inject)

Execute a shell command in a terminal (sends the text plus Enter). Returns immediately — it does not wait for the command to finish, so read the output a moment later with term.read. | 명령 실행 터미널 셸 커맨드

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmd` | string | ✓ | Shell command to run |
| `tab` | string |  | Target terminal tab id (omit = caller's context tab) |

**Returns**: { tabId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev term.exec '{"cmd":"git status"}'
```

## `term.read`

Read terminal screen and scrollback text (TUI shows current screen only). Use to check command output. | 터미널 읽기 출력 확인 결과 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lines` | number |  | Last N lines only (omit = all) |
| `tab` | string |  | Target terminal tab id (omit = caller's context tab) |

**Returns**: { tabId, text }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev term.read
sok-dev term.read '{"lines":50}'
```

## `term.send` (danger: inject)

Inject raw key input into a terminal (for TUI control). Pass control characters via JSON escapes: \r=Enter, \u0003=^C, \u001b[A=↑. | 터미널 입력 키 주입 TUI 조작 보내기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab` | string |  | Target terminal tab id (omit = caller's context tab) |
| `text` | string | ✓ | Bytes to inject (escapes allowed) |

**Returns**: { tabId }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev term.send '{"text":"ls\r"}'
sok-dev term.send '{"text":"\u0003"}'
```

## `theme.apply`

Apply a theme (replaces all token slots). Omit mode to keep the current mode. | 테마 적용 바꾸기 다크 모드 라이트 색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | Color mode (light|dark) |
| `name` | string | ✓ | Theme name (see theme.list) |

**Returns**: { name, mode }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev theme.apply '{"name":"Paper"}'
sok-dev theme.apply '{"name":"Midnight","mode":"light"}'
```

## `theme.install`

Install a theme JSON file into ~/.soksak/themes (immediately usable if validation passes). | 테마 설치 추가 외부

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute path to theme .json file |

**Returns**: { installed(install path), rejected? }
**Errors**: INTERNAL

```bash
sok-dev theme.install '{"path":"/tmp/dracula.json"}'
```

## `theme.list`

List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons. | 테마 목록 보기 사용 가능

**Returns**: { current, mode, themes:[{name,defaultMode,modes,source,warnings,relation}], rejected }

```bash
sok-dev theme.list
```

## `theme.reload`

Re-scan the external theme directory (~/.soksak/themes) and re-apply the current theme. | 테마 새로고침 리로드 외부 재스캔

**Returns**: { count, rejected }

```bash
sok-dev theme.reload
```

## `turn.idleDetection`

Toggle the idle-output heuristic turn.ended provider (off by default). When enabled, a terminal with no output for N ms is treated as a completed turn; false positives are possible. | 유휴감지 턴감지 아이들 idle 자동턴종료

| Parameter | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | ✓ | Enable or disable idle detection |
| `ms` | number |  | No-output threshold in ms (default 2000, minimum 250) |

**Returns**: { enabled, ms }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok-dev turn.idleDetection '{"enabled":true,"ms":1500}'
```

## `turn.signal`

Emit a turn.ended event (open signal). Use when any provider — ACP, external tool, or test harness — needs to signal that a turn has finished; subscribers such as the mailbox plugin react to this event. | 턴 종료 신호 발행 턴완료 acp

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string |  | Description of the completed task or command (optional, enriches event body) |
| `project` | string |  | Project id (optional) |
| `root` | string |  | Project root path — scope key used by subscribers to filter events |
| `source` | string |  | Signal origin (shell / idle / acp — defaults to acp) |
| `tabId` | string |  | Related tab id (optional) |

**Returns**: { emitted, projectId }
**Errors**: INTERNAL

```bash
sok-dev turn.signal '{"source":"acp","root":"/Users/me/proj","command":"claude 응답 완료"}'
```

## `ui.expect`

Look up which border rules apply to a given DOM selector according to the contract table. Returns matched rules and their expected edge configuration; no matching rule is also a valid answer (add to the contract table if coverage is needed). | 보더기대 계약조회 border expect ui계약

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |

**Returns**: { matchedElements, rules: [{id, active, kind, edges?, seam?, note}] }

```bash
sok-dev ui.expect '{"selector":".pane-status"}'
```

## `ui.focus.state`

Return the keyboard-focus owner through the public view-host boundary: the requested view, whether its provider is mounted/delivered, and the view containing the active element. Pierces Shadow DOM — plugin views mount inside a shadow root, so this descends shadowRoot.activeElement to the real focused element (and finds its view across the shadow boundary) instead of stopping at the shadow host. settled only proves the DOM active element — widgets paint their focused state (e.g. a terminal's block cursor) only when they received a focus event AND the window is key, so also check windowFocused (document.hasFocus) and activeElement.ancestors (class chain up to the view container — a widget's own focus class appears here). Use after real-device input to verify focus settled in the intended view without querying plugin-private DOM. | 키보드 포커스 소유자 활성 뷰 상태 창키 커서

**Returns**: { requestedTabId, mounted, delivered, activeTabId, settled, windowFocused, activeElement:{ tag, dataNode, className, ancestors } }

```bash
sok-dev ui.focus.state
```

## `ui.focus.trace.read`

Read the focus-causality timeline recorded by ui.focus.trace.start (idempotent; keeps the last trace after it self-terminates). recording tells whether the window is still open; each event carries its composed target and document.hasFocus() at that instant. | 포커스 추적 읽기 타임라인 결과

**Returns**: { recording, events: [{ t, type, tag, className, dataNode, hasFocus }] }

```bash
sok-dev ui.focus.trace.read
```

## `ui.focus.trace.start`

Start recording a focus-causality timeline: every mousedown/mouseup/focusin/focusout (capture, Shadow-DOM composed target) with document.hasFocus() at each event. Self-terminates after ms and removes its listeners. Use when focus lands wrong under real input: start the trace, have the real click happen, then ui.focus.trace.read for the timeline — post-hoc state reads are contaminated by the window blurring when the user switches away. | 포커스 추적 타임라인 기록 클릭 인과

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ms` | number |  | Recording window in ms (default 10000, max 180000) |

**Returns**: { recording: true, ms }

```bash
sok-dev ui.focus.trace.start '{"ms":10000}'
```

## `ui.hit`

Return the topmost DOM element at viewport x,y (tag, classes, data-* attrs, rect) — hit-test diagnostics for drag/click E2E (what would elementFromPoint see?). Pierces Shadow DOM: plugin views mount inside a shadow root, so this descends shadowRoots to the real deepest element instead of stopping at the shadow host (symmetric with ui.tree, which collects data-node across shadow boundaries).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✓ | viewport x |
| `y` | number | ✓ | viewport y |

**Returns**: { tag, className, dataset, host, rect } | { tag: null }

```bash
sok-dev ui.hit '{"x":200,"y":140}'
```

## `ui.input.click` (danger: inject)

Dispatch a real-click sequence (mousedown → mouseup → click) to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Pass phase:'down' to send only the mousedown, then observe the mid-gesture state (ui.hit / ui.measure), then phase:'up' to finish with mouseup+click — the only way to verify contracts that live BETWEEN down and up (e.g. that a mid-gesture surface stays hittable, or that activation waits for gesture completion). Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first. | 클릭 주입 ui클릭 버튼클릭 E2E 게스처 다운 업 분해

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |
| `phase` | string |  | 'down' = mousedown only; 'up' = mouseup+click only; omit for the full sequence |
| `x` | number |  | Content-view-relative x (CSS px). Only when the address resolves to a content view; the click is delivered inside it as real input. |
| `y` | number |  | Content-view-relative y (CSS px). |

**Returns**: { clicked, address, phase? }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.click '{"address":"win/main/chrome/modal/consent/agree"}'
```

## `ui.input.dblclick` (danger: inject)

Dispatch a double-click (two clicks + a dblclick event) to an exposed node (E2E injection). Use to drive double-click UI flows like inline tab/label rename. Unexposed addresses return NOT_EXPOSED — no guessing. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first. | 더블클릭 두번클릭 이름변경 rename 주입 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |

**Returns**: { dblclicked, address }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.dblclick '{"address":"win/main/chrome/tab/left/a.x"}'
```

## `ui.input.dnd` (danger: inject)

Synthesize an HTML5 drag-and-drop sequence (dragstart on `from` -> dragenter/dragover on `to` -> drop -> dragend) with a shared DataTransfer (E2E injection). ui.input.drag drives pointer(mouse) drags; this drives draggable/ondrop surfaces. Pass files to drop constructed File objects (base64 payload) onto a drop target — from is then optional. position picks the pointer y inside the target (before=upper quarter, after=lower quarter) for order-sensitive drop zones. Frames are yielded between steps so the UI can re-render (drop zones appearing after dragstart). Unexposed addresses return NOT_EXPOSED. | 드래그앤드롭 주입 dnd 파일드롭 재정렬 드롭존 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `files` | json |  | [{ name, type, base64 }] — constructed Files added to the DataTransfer (file drop) |
| `from` | string |  | Source node address (draggable). Optional when only dropping files. |
| `position` | string |  | center | before | after — pointer y within the target rect (center|before|after) |
| `to` | string | ✓ | Drop-target node address |

**Returns**: { dropped, from?, to, position }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.dnd '{"from":".../node/section/s2","to":".../node/section/s5","position":"after"}'
sok-dev ui.input.dnd '{"to":".../node/img/s2/hero","files":[{"name":"a.png","type":"image/png","base64":"…"}]}'
```

## `ui.input.drag` (danger: inject)

Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone); (2) drag by dx/dy for resize handles. steps and durationMs expose a finite real-time sequence for animation/layout verification; defaults preserve the immediate two-move behavior. mousemove+mouseup dispatch on window so window-level drag listeners receive them. | 드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그

| Parameter | Type | Required | Description |
|---|---|---|---|
| `durationMs` | number |  | Total finite drag duration in milliseconds (0..10000). Default 0. [default 0] |
| `dx` | number |  | Horizontal drag distance in CSS px from `from` center (mode 2 — resize/gutter). Alternative to `to`. |
| `dy` | number |  | Vertical drag distance in CSS px from `from` center (mode 2). |
| `from` | string | ✓ | Source node address (the tab / gutter / element to grab) |
| `steps` | number |  | Number of evenly spaced mousemove events (1..120). Default 2. [default 2] |
| `to` | string |  | Target node address to drop onto (mode 1). Omit when using dx/dy. |
| `zone` | string |  | center | left | right | top | bottom — point within the target rect (mode 1) (center|left|right|top|bottom) |

**Returns**: { dragged, from, to?, zone?, dx?, dy?, steps, durationMs }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.drag '{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}'
sok-dev ui.input.drag '{"from":"win/main/chrome/gutter/pan-g2h3j4/right","dx":120}'
```

## `ui.input.fill` (danger: inject)

Set the value of an exposed input/textarea node and dispatch input+change events (E2E injection). Uses the native value setter so React controlled inputs pick the value up. Contenteditable nodes are filled too: textContent is replaced and input+focusout fire, so blur-commit inline editors take the value. Unexposed addresses return NOT_EXPOSED. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first. | 입력 주입 값입력 텍스트입력 폼입력 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |
| `value` | string | ✓ | Value to set into the field |

**Returns**: { filled, address }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.fill '{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}'
```

## `ui.input.key` (danger: inject)

Dispatch a keydown (and keyup) to an exposed node — the only way to drive keyboard-only paths: palette arrows, Escape, Enter, and shortcuts like Ctrl+R. key takes a KeyboardEvent key value ('Enter', 'Escape', 'ArrowDown', 'r'). Modifiers are separate booleans. Returns defaultPrevented so you can tell whether a handler claimed the key or it fell through. Unexposed addresses return NOT_EXPOSED — no guessing. | 키 입력 키보드 단축키 방향키 엔터 이스케이프 주입 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |
| `alt` | boolean |  | Alt/Option held |
| `ctrl` | boolean |  | Ctrl held |
| `key` | string | ✓ | KeyboardEvent key value: Enter, Escape, ArrowDown, Tab, r, … |
| `meta` | boolean |  | Meta/Cmd held |
| `shift` | boolean |  | Shift held |

**Returns**: { key, address, defaultPrevented }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.input.key '{"address":"win/main/content/view/x/node/composer-input","key":"r","ctrl":true}'
sok-dev ui.input.key '{"address":"…/node/composer-input","key":"ArrowDown"}'
```

## `ui.input.observe`

Record which input events actually reach this window over a bounded span (ms ≤ 5000). Listens on window in the capture phase, so arrivals are recorded even if app handlers stop propagation. Use it to split a failed injection into 'the event never arrived' versus 'it arrived and nothing moved' — the two have different fixes. Drive the input from another connection while this runs. | 입력 도착 관측 이벤트 수신 확인 주입 검증

| Parameter | Type | Required | Description |
|---|---|---|---|
| `events` | json |  | Event type names to record (default: mousedown, mousemove, mouseup) |
| `ms` | number |  | Recording window in ms (default 1000, max 5000) |

**Returns**: { ms, counts: { <type>: n }, samples: [{ t, type, x, y, target }] }

```bash
sok-dev ui.input.observe '{"events":["mousemove"],"ms":1500}'
```

## `ui.input.pointer` (danger: inject)

Drive the pointer the way the OS does: enter/move onto an exposed node, or leave (no address = the pointer is not over us). Hover state that a native child surface can steal — gutter highlight — is owned by app state, not CSS :hover, precisely so it can be driven and read back here. Returns the gutter-hover key now held, so a test can assert both the arming and the release. | 포인터 이동 hover 강조 진입 이탈 마우스 주입 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string |  | Exposed node to move onto. Omit to signal the pointer left us. |

**Returns**: { address, gutterHover }
**Errors**: NOT_EXPOSED, AMBIGUOUS

```bash
sok-dev ui.input.pointer '{"address":"win/main/chrome/gutter/pan-g2h3j4/right"}'
sok-dev ui.input.pointer   # 이탈(강조 해제)
```

## `ui.intent.open`

Open a resource through the binding context (R2): places the view as a tab in the bound pane without replacing existing panes, reusing the existing tab for the same resource (idempotent). The same path the rail's open affordance uses. With no binding (empty project) it places into the active pane. | 인텐트열기 결부열기 intent open

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute file path to open |
| `project` | string |  | Project id (omit for the active project) |

**Returns**: { projectId, paneId, tabId, existing }

```bash
sok-dev ui.intent.open '{"path":"/work/notes/plan.md"}'
```

## `ui.measure`

Measure an exposed node — its viewport rect (px) and computed style. style always includes the layout fields plus the interaction/visibility axis (pointerEvents, opacity, visibility) so you can tell whether a node is actually visible and clickable, not just where it sits. Pass props to read any extra computed properties by name (e.g. zIndex, transform, backgroundColor). Pass occlusion:true to also hit-test the node's center (through Shadow DOM) and report what covers it and whether it is reachable. Pass screen:true to also get the node's GLOBAL logical screen coordinates (screen.x/y = rect origin, screen.cx/cy = center) — feed cx/cy straight to an OS pointer tool (e.g. cliclick c:cx,cy) when a real hit-tested click is required; synthetic ui.input.click bypasses hit-testing and default actions, so it cannot verify pointer-events or focus-on-mouseup behavior. Accepts structural addresses from ui.tree only; CSS selectors are rejected. | DOM 측정 레이아웃 rect 크기 스타일 포인터이벤트 가시성 가림 도달성 스크린 전역좌표 실클릭

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |
| `occlusion` | boolean |  | Also hit-test the node's center (Shadow-DOM-piercing): report the topmost element there and whether it is this node (reachable) or something covers it [default false] |
| `props` | json |  | Extra computed-style property names to read, camelCase or kebab (e.g. ["zIndex","backgroundColor"]) — lifts the fixed field set |
| `pseudo` | string |  | Read the computed style of a pseudo-element instead of the node itself ("::before" | "::after"). rect and dataset still describe the node. Required when a surface paints through a pseudo-element veil — those pixels belong to no measurable node otherwise |
| `screen` | boolean |  | Also return global logical screen coordinates (window inner origin + viewport rect). cx/cy is the node center — pass it directly to an OS-level pointer tool for a real hit-tested click [default false] |

**Returns**: { address, dataset, rect:{x,y,w,h}, style, occlusion?:{ reachable, topTag, topNode }, screen?:{ x, y, cx, cy } } — dataset contains every declared data-* field on the exposed node
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.measure '{"address":"content/view/soksak-plugin-<id>.<view>/node/send"}'
```

## `ui.motion` (danger: inject)

Slow down or freeze layout motion so a transient state can be inspected. scale multiplies every transition/animation duration; hold pauses them in place. Without params it reports the current setting. Transient defects — a surface stranded at its old rect, a pane briefly narrow, a flash on tab return — are invisible to a still capture; this is how you stop time and then read the DOM with ui.tree / ui.measure. | 모션 느리게 정지 일시정지 애니메이션 배속 관측 디버그

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hold` | boolean |  | Freeze motion in place (true) or resume (false) |
| `scale` | number |  | Duration multiplier (1 = normal, 20 = twenty times slower) |

**Returns**: { scale, hold, applied, running, rates, wallMs, animations }
**Errors**: INVALID_PARAMS

```bash
sok-dev ui.motion '{"scale":20}'   # 20배 느리게
sok-dev ui.motion '{"hold":true}'  # 그 자리에 정지
sok-dev ui.motion            # 현재 설정 조회
```

## `ui.projection.pin`

Reserved. The left rail is projection-only — it renders the bound content view's declared sidebar and nothing user-pinned, so left pins are always rejected. Right-side pinning is the reserved plugin surface and stays rejected until the right pin stack renderer ships. Use unpin to clean stale pins from old snapshots. | 핀 고정 레일핀 pin rail

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id (omit for the active project) |
| `ref` | string | ✓ | Rail view ref "<pluginId>.<viewId>" |
| `side` | string |  | "left" (default) | "right" |

**Returns**: { projectId, pins: {left, right} }

```bash
sok-dev ui.projection.pin '{"ref":"<pluginId>.<viewId>"}'
```

## `ui.projection.state`

Read the sidebar projection state of a project: the bound content view (binding follows the session active chain — switching the active tab inside a group changes the binding too), resolved left/right rail slots with instanceKey and status (live|degraded|satisfied-by-pin), and pinned refs. | 투영상태 결부 사이드바상태 레일상태 projection binding rail

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id (omit for the active project) |

**Returns**: { projectId, binding: {tabId|null}, left: {slots:[{source,resolvedRef,instance,instanceKey,status}], template}, right|null, pins: {left,right} }

```bash
sok-dev ui.projection.state
sok-dev ui.projection.state '{"project":"t1"}'
```

## `ui.projection.unpin`

Remove a pinned ref from a rail side. Idempotent — unpinning an absent ref succeeds. No rail-registration check: a ref must stay removable after its plugin is gone. | 핀해제 언핀 unpin

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id (omit for the active project) |
| `ref` | string | ✓ | Pinned ref |
| `side` | string |  | "left" (default) | "right" |

**Returns**: { projectId, pins: {left, right} }

```bash
sok-dev ui.projection.unpin '{"ref":"<pluginId>.<viewId>"}'
```

## `ui.slot`

Measure a content view's slot rectangle — the bare host container a view renders into (viewport px + devicePixelRatio). Use so an engine plugin learns its present-target rect (device px = css px * dpr) to align a native/offscreen surface, and so AI can verify placement. Address is a VIEW container (no /node): win/<label>/<region>/view/<pluginId.viewId>. Unexposed returns NOT_EXPOSED. | 슬롯 뷰컨테이너 rect present타깃 dpr 측정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | View container address (win/<label>/<region>/view/<pluginId.viewId>, no node) |

**Returns**: { address, rect:{x,y,w,h}, dpr }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

```bash
sok-dev ui.slot '{"address":"win/main/content/view/soksak-plugin-<id>.<view>"}'
```

## `ui.snapshot.dom`

Measure every exposed node in one pass — one consistent instant, not several round trips that drift apart. Returns address, rect, and the requested computed properties for each, so you can read where a line sits, how wide a pane is, and how big its children are, all from the same moment. Pair with ui.motion hold to stop time first. filter narrows by address substring; selector measures raw elements that carry no address (a content-view host, a plugin body) — read-only, it drives nothing. | 돔 일괄 측정 스냅샷 좌표 폭 한번에 관측 선 위치

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filter` | string |  | Only addresses containing this substring |
| `props` | json |  | Extra computed-style property names, e.g. ["backgroundColor","zIndex"] |
| `selector` | string |  | CSS selector for elements that carry no exposed address (e.g. webview[data-content-view]). Observation only — input still requires an address. |

**Returns**: { count, nodes: [{ address, nodePath, rect, style? }] }
**Errors**: INVALID_PARAMS

```bash
sok-dev ui.snapshot.dom
sok-dev ui.snapshot.dom '{"filter":"pane","props":["backgroundColor"]}'
```

## `ui.trace`

Sample an exposed node's rect over a bounded window (ms ≤ 5000) at animation-frame cadence and return the series. This is how you verify that a layout change actually moves — and how slow/hold (ui.motion) visibly stretch or freeze that movement. Trigger the mutation right after starting the trace (it samples from the next frame). | 노드 추적 이동 기록 rect 시계열 트레이스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address (ui.tree) |
| `ms` | number |  | Sampling window in ms (default 1000, max 5000) |

**Returns**: { address, from, to, samples: [{ t, x, y, w, h }], moved, translatedOnly(true = x/y changed while w/h stayed — the move-contract), resized }
**Errors**: NOT_EXPOSED, AMBIGUOUS, INVALID_PARAMS

## `ui.tree`

Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Use to discover addressable targets before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable. Pass rects:true to include each node's viewport rect for coordinate work (drags, precision clicks). | DOM 트리 주소목록 노드목록 ui트리

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rects` | boolean |  | Include each node's viewport rect {x,y,w,h} (px) [default false] |

**Returns**: { window, count, duplicates, nodes: [{ address, nodePath, rect? }] }

```bash
sok-dev ui.tree
sok-dev ui.tree '{"rects":true}'
```

## `ui.validate`

Validate the border ownership contract (docs/UI.md §B) against the live DOM. Compares computed border values on all four edges with the contract table and reports violations. Use as the single RED/GREEN gate for border rules. | 보더검증 테두리확인 ui검증 border contract

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rule` | string |  | Rule id or selector substring filter (omit to check all rules) |

**Returns**: { pass, rulesActive, elementsChecked, violations: [{rule, selector, index, edge, expected, actual}] }

```bash
sok-dev ui.validate
sok-dev ui.validate '{"rule":"status"}'
```

## `ui.verify`

Check this window's structural invariants and report each by name. Answers whether the window is coherent right now: every exposed address resolves to exactly one node, no rail layer is left behind after a travel, no visible tab body has collapsed to nothing, and the motion clocks agree. Use after any layout change, and as the assertion in end-to-end gates — read passed (the verdict) and checks[].detail, which names the invariant and shows the offending addresses; the envelope only says the query ran. | 창 점검 불변식 검증 무결성 주소중복 레일잔존 빈슬롯 자가진단

**Returns**: { passed, failed, checks: [{ name, ok, detail }] }

```bash
sok-dev ui.verify
```

## `unit.dev.list`

List development source selections for plugins, sidecars, and kits in this CLI identity home. Core build and unit source mode are independent. | 유닛 개발 소스 목록 플러그인 사이드카 키트 작업공간

**Returns**: { unitMode: official|mixed, units: Array<{kind,id,source}> }

```bash
sok-dev unit.dev.list
```

## `unit.dev.remove`

Remove one development source selection without deleting its workspace. A plugin returns to its separate official installation when present. | 유닛 개발 소스 해제 제거 공식 설치 복귀

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Unit id |
| `kind` | string | ✓ | Unit kind (plugin|sidecar|kit) |

**Returns**: { kind, id, removed }

```bash
sok-dev unit.dev.remove '{"kind":"plugin","id":"weather"}'
```

## `unit.dev.set` (danger: inject)

Select an existing absolute directory as a unit's development source in this identity home. Symlinks and relative paths are rejected. Plugin sources are validated and loaded immediately. | 유닛 개발 소스 지정 선택 플러그인 사이드카 키트

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Unit id |
| `kind` | string | ✓ | Unit kind (plugin|sidecar|kit) |
| `source` | string | ✓ | Existing absolute source directory |

**Returns**: { kind, id, source }
**Errors**: INVALID_PARAMS, TARGET_NOT_FOUND

```bash
sok-dev unit.dev.set '{"kind":"plugin","id":"weather","source":"/absolute/path/weather"}'
```

## `update.apply` (danger: destructive)

Apply updates across every hot axis, least-disruptive first: authenticated plugin release closures, the PTY daemon with fd-handoff, then the app body in a release identity. Each result is announced on the activity bus. | 업데이트 적용 설치 새 버전 갱신 핫스왑

| Parameter | Type | Required | Description |
|---|---|---|---|
| `app` | boolean |  | Update the app body (release channel only). Default true. |
| `daemon` | boolean |  | Hot-upgrade the PTY daemon (fd-handoff drain). Default true. |
| `plugins` | boolean |  | Update installed plugin release closures. Default true. |

**Returns**: { applied: [{ axis, ... }], skipped: [{ axis, reason }] }
**Errors**: INTERNAL

```bash
sok-dev update.apply
sok-dev update.apply '{"app":false}'
```

## `update.check`

Survey what can be updated without applying anything. Reports the app body (release channel only — a debug/dev build has no remote updater and comes back available:false), plus a count of the hot axes update.apply can roll: installed plugins and the running PTY daemon. Read this first; update.apply does the work. | 업데이트 점검 확인 새 버전

**Returns**: { channel, app: { available, version? }, plugins: { installed }, daemon: { running, sessions? } }
**Errors**: INTERNAL

```bash
sok-dev update.check
```

## `webview.emitNative`

Emit a native mouse-bridge event (native-mousedown/move/up) at viewport x,y — drives divider drag/resize over a native child (browser) without a real mouse, for E2E. Pair with ui.input.drag (DOM path); this is the native path. Occluded/unfocused windows pause rAF and may not respond — call window.focus to bring the window forward first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | ✓ | native-mousedown | native-mousemove | native-mouseup |
| `x` | number | ✓ | viewport x |
| `y` | number | ✓ | viewport y |

**Returns**: { ok, kind }

```bash
sok-dev webview.emitNative '{"kind":"native-mousedown","x":400,"y":300}'
```

## `webview.composition`

Tauri-only composition audit. Reports every visible DOM content hole and every live native
surface in both coordinate systems, correlates child-webview labels to slot labels, and returns
a strict one-to-one verdict. `coordinateContract.tolerancePx` is limited to integer-rounding
error; any larger position or size difference is a defect. This command is intentionally absent
from Electron because Electron content lives in the DOM and is inspected by `webview.surfaces`.

**Returns**: { coordinateContract, anchors:[{label,viewId,projectId,rect}], surfaces:[{label,ptr,hidden,effectivelyHidden,nativeFrame,domFrame}], matches, verdict:{misplaced,stacked,missing,surfaces,holes} }

```bash
sok-dev webview.composition
```

## `webview.holes`

Tauri-only input-hole audit. Reports every visible DOM declaration that must receive mouse
input above an AppKit child surface (`right-sidebar`, `pane-gutter`, or `native-drag`) and the
native hit-test-hole ledger, then returns a strict one-to-one verdict. The 1 CSS px tolerance is
only for integer-boundary rounding. Missing and stale native holes are reported separately. This
command is intentionally absent from Electron because Electron has no native child surface to
hole-punch.

**Returns**: { tolerancePx, dom:[{kind,node,rect}], native:[{x,y,w,h}], verdict:{missingNative,staleNative,matched} }

```bash
sok-dev webview.holes
```

## `webview.health.query`

Report webview renderer-process health per label: circuit-breaker state (closed / recovering / open), crash counts in the rolling 60s window, lifetime total, and the last termination reason if the platform provided one. Labels: a window label is that window's main webview, b-<win>-<view> is a browser child. state=open means automatic recovery is exhausted — recover it manually with webview.recover. | 웹뷰 건강 상태 크래시 조회 복구

**Returns**: { count, entries: [{label, state, attempt, crashesInWindow, totalCrashes, lastCrashAgoMs, lastReason}] }

```bash
sok-dev webview.health.query
```

## `webview.recover`

Manually recover a webview: reset its circuit breaker (clears the crash window and the open state) and reload it in place. Use after webview.health.query shows state=open, or any time a webview is blank/wedged. The window's main webview reloads through the normal boot path (terminals survive — PTYs live in the core); a browser child (b-<win>-<view>) reloads in place without being re-created. | 웹뷰 복구 되살리기 크래시 화면

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | ✓ | webview label — a window label for that window's main webview, or b-<win>-<view> for a browser child (list via webview.health.query or window.list) |

**Returns**: { label, reloaded: true }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev webview.recover '{"label":"b-w-1234-v7"}'
```

## `webview.surfaces`

Reconcile this window's state (which views exist) against the browser child webviews actually alive for this window. ghosts = child webviews whose view no longer exists in state — a stale native surface floating over the window (the 'browser over an empty window' mismatch); a non-empty ghosts list is always a defect fact. Judged from the same sources the app itself uses (state store + webview_list), no pixels involved. | 표면 정합 유령 웹뷰 잔존 브라우저 대조 확인

**Returns**: { window, actual: [label], ghosts: [label], orphans: [label], engine: {registered, hostPresent}, bodies: [{node,x,y,w,h,children,overlay,…}], contentViews: {inDocument, detached, dom: [{label,slotLabel,directVisibility,computedVisibility,display,projectId,projectActive,rect}]}, stateViews }

```bash
sok-dev webview.surfaces
```

## `window.close`

Close a window. Omit label to close the window this command is addressed to — the envelope already names it, so the common case needs no argument. An unknown label is TARGET_NOT_FOUND, not an internal failure. | 창 닫기 윈도우

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string |  | Window label (omit = the addressed window; see window.list) |

**Returns**: { ok, label }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev window.close
sok-dev window.close '{"label":"w-<uuid>"}'
```

## `window.focus`

Bring a window to the front and focus it. Without label, focuses the window this command runs in (clears inactive state for automation); with label, focuses that window (see window.list). | 창 포커스 활성화 앞으로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string |  | Window label (omit = the addressed window; see window.list) |

**Returns**: { focused: true }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev window.focus
sok-dev window.focus '{"label":"w-<uuid>"}'
```

## `window.info`

Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).

**Returns**: { x, y, w, h, scale }

```bash
sok-dev window.info
```

## `window.layers`

Dump the window's native view hierarchy (class / frame / hidden, indented text). Ground truth for layer diagnostics — verify a native child webview's actual bounds and z-order against the DOM slot (e.g. divider-drag freeze, hole-punch mismatch). | 네이티브 뷰 계층 레이어 덤프 child 위치 진단

**Returns**: { hierarchy } — indented text, one view per line

```bash
sok-dev window.layers
```

## `window.list`

List open window labels. Use to discover targets for commands that accept a window argument. | 창 목록 윈도우 열린

**Returns**: { labels }

```bash
sok-dev window.list
```

## `window.maximize`

Maximize a window to fill the screen (native window maximize — distinct from tab.maximize, which only enlarges one tab within a space). Without label, targets the window this command runs in; with label, targets that window (see window.list). Pass off:true to restore (unmaximize). | 창 최대화 전체화면 키우기 해제

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string |  | Window label (omit = the addressed window; see window.list) |
| `off` | boolean |  | Restore (unmaximize) instead of maximizing |

**Returns**: { maximized: boolean }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev window.maximize
sok-dev window.maximize '{"off":true}'
sok-dev window.maximize '{"label":"w-<uuid>"}'
```

## `window.monitors`

Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space). | 모니터 목록 해상도 창 배치 현황 듀얼 파악

**Returns**: { monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }

```bash
sok-dev window.monitors
```

## `window.move`

Move the window to a screen position in physical pixels (for automation and multi-monitor validation).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✓ | Physical x coordinate |
| `y` | number | ✓ | Physical y coordinate |

**Returns**: { x, y }

```bash
sok-dev window.move '{"x":0,"y":0}'
```

## `window.occlusion`

Toggle occlusion detection. When false, rendering continues even when fully covered by other apps (for continuous background capture — note battery cost). Not needed for normal use; snapshot/record disable it automatically during capture.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | ✓ | Occlusion detection on (default) / off |

**Returns**: { occlusion }

```bash
sok-dev window.occlusion '{"enabled":false}'
```

## `window.open`

Open a new project window for a project root (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). root is required unless mode orchestrator, which brings the control plane (main) forward instead — opening and creating projects live there; empty project windows do not exist. | 새 창 열기 윈도우 프로젝트 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `alias` | string |  | Display alias for the project tab (defaults to the folder name). |
| `focus` | boolean |  | Whether the new window takes focus (default true). Automation and visual verification must pass false to preserve the user's active app. |
| `mode` | string |  | orchestrator = bring the control plane (main) forward. Mutually exclusive with root. (orchestrator) |
| `root` | string |  | Project root to open in the new window (absolute path). |
| `shell` | string |  | Shell binary for the project's terminals (defaults to the user shell). |

**Returns**: { label } | { existingWindow } (root already open — focused instead)
**Errors**: INVALID_PARAMS

```bash
sok-dev window.open '{"root":"/Users/me/work"}'
sok-dev window.open '{"root":"/Users/me/work","focus":false}'
sok-dev window.open '{"mode":"orchestrator"}'
```

## `window.pixels`

Measure what is actually painted in a region — mean color and luminance, not a picture. Same region axes as window.snapshot (rect | node | tab), so the address you measure is the address you capture. Use this to verify that a declared style reached the screen: computed style says what was declared, this says what was painted (an overlay can be clipped, covered, or composited under a native surface and the declaration still reads correct). Compare two states or two regions by their luminance. | 픽셀 색 밝기 실제칠해짐 검증 휘도 평균색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `node` | string |  | Exposed address (ui.tree) — its rect is measured for you |
| `rect` | json |  | Region {x,y,w,h} in CSS px, window coordinates (ui.measure space) |
| `settle` | boolean |  | Finish in-flight finite animations before capturing (default true — a command must yield the frame that should be showing). Pass false to capture the CURRENT instant instead: required to see mismatches that exist only mid-transition, because settling ends them. |
| `tab` | string |  | Content tab id. Inactive tabs are parked offscreen, so this activates the tab for the shot and restores what was active afterwards |

**Returns**: { tabId?, w, h, samples, mean:{r,g,b}, luminance, min, max } — luminance is 0..1 on displayed (gamma-encoded) values; min/max are the darkest and brightest sampled luminance
**Errors**: INVALID_PARAMS, OFFSCREEN, TARGET_NOT_FOUND, NOT_EXPOSED

```bash
sok-dev window.pixels '{"node":"win/main/proj/p1/chrome/layout/tab/tab-abc"}'
sok-dev window.pixels '{"rect":{"x":100,"y":80,"w":400,"h":300}}'
```

## `window.place`

Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame. | 창 배치 이동 모니터로 옮기기 위치 지정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `h` | number | ✓ | Height (physical px) |
| `label` | string |  | Window label (omit = the addressed window; see window.list) |
| `w` | number | ✓ | Width (physical px) |
| `x` | number | ✓ | Left edge (physical px) |
| `y` | number | ✓ | Top edge (physical px) |

**Returns**: { ok }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev window.place '{"x":0,"y":0,"w":2560,"h":1440}'
sok-dev window.place '{"label":"main","x":2560,"y":0,"w":2560,"h":1440}'
```

## `window.projects`

Map open windows to the project each one hosts (root path + name + window label). The meaning layer over window.list — use it first to pick the right window before targeting commands with --window. Same answer from any window (process-wide registry). | 창 프로젝트 매핑 어느 열림 창별

**Returns**: { projects: [{ root, name, window }] }

```bash
sok-dev window.projects
```

## `window.record`

Capture the window as a sequence of PNGs (dir/f0000.png ...) for use as a video source. All frames are rendered even when occluded (occlusion detection disabled for the duration). Folder is created automatically. | 녹화 연속 캡처 프레임 저장 동영상 소스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dir` | string | ✓ | Output directory for frames |
| `frames` | number |  | Number of frames (default 40, max 600) |
| `intervalMs` | number |  | Interval between frames in ms (default 40) |

**Returns**: { dir, frames }

```bash
sok-dev window.record '{"dir":"/tmp/rec"}'
sok-dev window.record '{"dir":"/tmp/rec","frames":120,"intervalMs":33}'
```

## `window.reload`

Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted). | 앱 리로드 새로고침 플러그인 재시작 코드 반영

**Returns**: { reloaded: true }

```bash
sok-dev window.reload
```

## `window.resize`

Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which pane.resize does not exercise).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `h` | number | ✓ | Physical height |
| `w` | number | ✓ | Physical width |

**Returns**: { w, h }

```bash
sok-dev window.resize '{"w":1200,"h":800}'
```

## `window.restorePrevious`

Inspect or restore the previous workspace generation for a window. The store keeps the last few values of every key, so any write — a bug, a crash, a bad tool — leaves something to come back to. Without `apply` this only reports what is there. | 이전 워크스페이스 복구 직전 세대 되돌리기 작업

| Parameter | Type | Required | Description |
|---|---|---|---|
| `apply` | boolean |  | Write the previous generation back (default false = report only). |
| `label` | string |  | Window label (omit = the addressed window; see window.list) |

**Returns**: { found, projects, tabs, applied }
**Errors**: TARGET_NOT_FOUND

```bash
sok-dev window.restorePrevious
sok-dev window.restorePrevious '{"apply":true}'
```

## `window.snapshot`

Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically. Cropping and saving compose freely: rect (CSS px, window coords — same space as ui.measure), node (an exposed address from ui.tree), or tab (a content tab id) selects the region, and path saves it while base64:true returns it inline. Capturing a tab that is not active activates it for the shot and restores whatever was active afterwards, so the screen returns to where it was. With neither path nor base64, a cropped capture still returns inline. | 스크린샷 캡처 화면 저장 PNG 스냅샷 부분 영역

| Parameter | Type | Required | Description |
|---|---|---|---|
| `base64` | boolean |  | Return the PNG as base64 instead of writing a file |
| `node` | string |  | Exposed address (ui.tree) to capture — its rect is measured for you. Use this to capture one panel or element without computing coordinates. |
| `path` | string |  | Output .png path (file mode). Omit to use a temp folder. |
| `rect` | json |  | Crop region {x,y,w,h} in CSS px, window coordinates (ui.measure space). Combine with path to save the crop. |
| `settle` | boolean |  | Finish in-flight finite animations before capturing (default true — a command must yield the frame that should be showing). Pass false to capture the CURRENT instant instead: required to see mismatches that exist only mid-transition, because settling ends them. |
| `tab` | string |  | Content tab id to capture. Inactive tabs are parked offscreen, so this activates the tab (and its space) for the shot and restores what was active afterwards. |

**Returns**: { tabId?, saved, media:{kind,path} } when path is given (cropped or full) | { tabId?, media:{kind:'image/png',base64} } otherwise — tabId echoes the resolved tab when tab was passed
**Errors**: INVALID_PARAMS, OFFSCREEN, TARGET_NOT_FOUND, NOT_EXPOSED

```bash
sok-dev window.snapshot
sok-dev window.snapshot '{"path":"/tmp/shot.png"}'
sok-dev window.snapshot '{"rect":{"x":100,"y":80,"w":400,"h":300},"base64":true}'
sok-dev window.snapshot '{"rect":{"x":100,"y":80,"w":400,"h":300},"path":"/tmp/crop.png"}'
sok-dev window.snapshot '{"node":"win/main/proj/p1/chrome/tab/space/0","path":"/tmp/tab.png"}'
```

## `window.themeScan`

Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done. | 테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀

| Parameter | Type | Required | Description |
|---|---|---|---|
| `applyAtMs` | number |  | Delay after recording starts before toggling (default 250) |
| `frames` | number |  | Frames to capture (default 40) |
| `from` | string |  | Starting mode (default dark) (light|dark) |
| `intervalMs` | number |  | Frame interval in ms (default 16 ≈ one display frame) |
| `regions` | json |  | Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar. |
| `settleMs` | number |  | Settle wait after setting the start mode (default 800) |
| `skipCapture` | boolean |  | Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning. |
| `theme` | string |  | Theme name to scan (default: current theme) |
| `to` | string |  | Ending mode (default light) (light|dark) |

**Returns**: { frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }

```bash
sok-dev window.themeScan
sok-dev window.themeScan '{"theme":"Midnight","frames":48}'
```
