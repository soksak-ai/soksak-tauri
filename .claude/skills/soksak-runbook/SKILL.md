---
name: soksak-runbook
description: Use when saving, organizing, running, or scheduling reusable commands inside soksak — drive the runbook plugin entirely by CLI/MCP commands (`sok plugin.soksak-plugin-runbook.*`) to create command entries (shell/HTTP/etc), link them with `{{references}}`, group and favorite them, run them, schedule them, and read execution history. Headless: works without opening the GUI. 런북, 저장된 명령/작업 러너, 실행, 스케줄, 반복 작업, 참조 링킹도 여기.
---

# soksak runbook — saved, linkable, schedulable commands

A runbook holds **command entries**: a labeled, reusable action (a shell command, an HTTP request, etc — `executionType`) you can run on demand or on a schedule. Entries live in a `scope` (global or per-project), can be grouped and favorited, and can **reference each other** via `{{...}}` templates resolved at run time. Every entry's run is recorded in history. Drive it all by command — a view, if open, only renders.

## Discover first

Names/params evolve — never guess. List the live surface:

```
sok commands | grep plugin.soksak-plugin-runbook
```

`command.list scope=global` (or `project`) reads entries; `command.get commandId=<id>` returns one.

## Mental model

- **`scope`** is the first thing to decide: `global` (available everywhere) vs `project` (this project only). Most commands take `scope`; pass it explicitly.
- **An entry = `label` + `command`/`url` + `executionType`** (shell, http, …) + optional `groupId`, `favorite`, schedule fields.
- **References link entries.** A command body can contain `{{...}}` templates. `ref.parse template='…'` extracts the references in a template; `ref.resolve context=… template='…'` fills them in. `command.refs commandId=<id>` lists what one entry references — this is the dependency graph (cycles are rejected).
- **Scheduling**: entries carry `repeatType`/`intervalSec`/`scheduleAt`; `schedule.fire commandId=<id>` triggers one now. `reminderSecs` drives reminders.
- **History** records each run (output, statusCode, type); it has its own list/search/trash/restore, separate from entries.

## Core workflow

```
# save a shell command in the project scope
sok plugin.soksak-plugin-runbook.command.add scope=project label='deploy' \
  executionType=shell command='make deploy' groupId=<id>
# run it
sok plugin.soksak-plugin-runbook.command.run commandId=<id> scope=project
# read what happened
sok plugin.soksak-plugin-runbook.history.list scope=project limit=20
```

For chained entries, author the body with `{{...}}` and check `command.refs` before running so the graph resolves.

## Conventions

- Every command returns `{ok:true,…}` or `{ok:false,error}`. No throws — branch on `ok`.
- Always pass `scope` explicitly (global vs project). Deletes are soft (trash) — list with `trash=true`, then `restore` or `clear trashOnly=true`.
- It is **headless-complete** — you never need the GUI.

## Commands (snapshot — live: `sok commands | grep plugin.soksak-plugin-runbook.`, schema: `sok help <name>`)

- `command.add` — 런북 명령 추가. label·command(템플릿)·executionType(terminal|script|background|schedule|api) 필수. groupId 생략 시 기본 그룹. command 템플릿의 Reference 메타는 parse 로 추출·저장(검증용).
- `command.delete` — 명령 휴지통으로(소프트 삭제 — boolean deleted). 복원 가능.
- `command.duplicate` — 명령 복제(새 id, label 에 ' (복사)' 접미, 비휴지통·order 맨 뒤).
- `command.favorite` — 즐겨찾기 토글(있으면 해제, 없으면 설정).
- `command.get` — 명령 1건 조회(Reference 메타 포함). 없으면 TARGET_NOT_FOUND.
- `command.list` — 명령 목록(order 순). trash=true 휴지통만, favorite=true 즐겨찾기만, groupId 지정 시 해당 그룹.
- `command.refs` — 명령의 command 템플릿을 parse 해 Reference 메타를 반환(검증·표시용 — 실행 아님).
- `command.restore` — 휴지통의 명령 복원(deleted=false).
- `command.run` — 런북 명령 실행. command 참조는 위상순으로 먼저 실행→출력을 다음 입력으로 되먹임(링킹). 순환=CYCLE, 미해소 참조=UNRESOLVED. script/background=셸 실행(stdout/stderr·exitCode 캡처) — secret 참조는 자식 env 주입($SOKSAK_SECRET_N, 평문은 Rust 경계에서만·history/lastOutput 엔 플레이스홀더). terminal=코어 term.exec(포커스 pane) — secret 동반 시 SECRET_PENDING(ps 노출 위험으로 미지원). 결과는 lastOutput/lastStatusCode/lastExecutedAt 갱신 + 히스토리 자동 기록.
- `command.search` — 명령 CJK 전문검색(label·command). 휴지통 제외.
- `command.set-group` — 명령을 다른 그룹으로 이동.
- `command.update` — 명령 갱신(전체교체 — 누락 필드는 기존 보존). command 변경 시 Reference 메타 재추출.
- `editor.serialize` — 배지 토큰/텍스트 세그먼트 배열을 저장형 토큰 문자열로 직렬화(에디터 저장 경로의 순수 노출). raw 가 없는 토큰은 provider 규약으로 합성. text 만 넘기면 역직렬화→재직렬화 왕복(항등 확인).
- `editor.tokens` — 저장형 토큰 문자열을 배지 토큰 배열로 역직렬화(텍스트 제외). 인라인 배지 에디터의 토큰 모델 검증용. 시크릿 토큰은 provider·key 만 — 평문 미보유(R2).
- `export` — 런북 전체(그룹·명령·히스토리) JSONL 내보내기. 각 줄 = { kind, doc }. 평문 시크릿은 저장하지 않으므로 export 에도 등장하지 않는다(R2).
- `group.add` — 그룹 추가. name 필수, color(blue|red|green|orange|purple|gray) 생략 시 gray.
- `group.delete` — 그룹 삭제(하드). 소속 명령은 기본 그룹으로 재배치(고아 방지). 기본 그룹은 보장 후 재생성.
- `group.list` — 그룹 목록(order 순). 기본 그룹을 보장(없으면 생성).
- `group.update` — 그룹 갱신(name·color).
- `history.add` — 실행 히스토리 1건 기록(label·command·type 필수, output·statusCode·commandId 선택). 실행기가 후속에 호출하나, 헤드리스 검증용으로도 노출.
- `history.clear` — 히스토리 전체 삭제(하드). trashOnly=true 면 휴지통만.
- `history.delete` — 히스토리 1건 휴지통으로(소프트 삭제).
- `history.list` — 히스토리 목록(최신순). trash=true 휴지통만, type 지정 시 해당 실행타입만.
- `history.restore` — 휴지통의 히스토리 복원.
- `history.search` — 히스토리 CJK 전문검색(label·command·output). 휴지통 제외.
- `import` — JSONL 가져오기(export 역). 각 줄 { kind, doc } 를 컬렉션에 put(id 보존 = 멱등 upsert).
- `ref.parse` — Reference 템플릿을 파싱해 노드와 추출된 Reference 목록을 반환(엔진 검증).
- `ref.resolve` — Reference 템플릿을 주어진 context 로 해석해 텍스트·에러·시크릿 핸들을 반환(엔진 검증). 평문 시크릿 미수신 — secretNs 만.
- `schedule.fire` — 코어 스케줄러가 due 시각에 호출 — schedule 명령의 action(command 필드, 셸)을 실행하고 다음 occurrence 를 재무장한다(반복/간격). deleted 면 발화·재무장 0. 사용자 직접 호출 대상 아님.
