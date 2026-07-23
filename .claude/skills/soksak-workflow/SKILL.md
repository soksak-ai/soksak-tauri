---
name: soksak-workflow
description: Use when turning an idea into a certified, developable backlog inside soksak — drive the workflow plugin by CLI/MCP commands (`sok plugin.soksak-plugin-workflow.*`) to publish a draft (run), watch the scheduler verify/hunt/classify/audit it, run research and design, issuerize into per-file codification, and — as an LLM executor yourself — pull verification work with `next`, perform it in your own turn, and `submit` the verdict. 아이디어 구체화, 드래프트 인증, 리서치/설계/플랜, 파일별 실코드화, 검증 대행(next/submit)도 여기.
---

# soksak workflow — from idea to certified code, and you can be an executor

The workflow plugin turns one idea into a **certified backlog chunk** on the kanban board and
carries it to **per-file real code**. Every LLM output lands as a node with a badge
(검수전 → o/x/f); the core scheduler (reconcile) drives ready nodes; gates are deterministic.

Pipeline: `run`(idea) → requirements verified → hunt → classify → audit certifies the chunk
(badge o) → `research`(chunk) → facts verified → design facts verified → plan units (one per
file) verified → `issuerize`(chunk) → per-file codification → code nodes verified → `export`.

## Pull mode — the whole pipeline without spawning an LLM

Every LLM turn — refinement, discovery, design, planning, codification, and verification —
can be pulled and performed by YOU (the agent reading this), so the system never spawns
`claude -p` or `codex exec`:

1. **Draft refinement**: `run '{"idea":"...","pull":true}'` returns the refinement package
   ({prompt, schema}). Perform it, then publish with `run '{"idea":"...","refined":<your output>}'`.
2. **Everything after**: loop `next`. It returns either a verification node (judge it, submit
   `{"oxf":"o|x|f", ...}`) or a stage task (`node.kind == "task"`, `node.stage` names the turn —
   generate/hunt/classify/audit/research/design-*/plan/body). Perform the stage prompt and
   submit the schema-shaped output; the system replays it through the same publish pipeline
   the scheduler uses (children nodes, gates, transitions).
3. `next` returning `node:null` means nothing is ready — either the chunk is waiting on
   verification you can pull on the next call, or the pipeline is done. `export` writes the
   confirmed code nodes to real files.

Leases (30 min) keep multiple executors — you, your subagents, another agent system — from
colliding; dependencies (blockedBy) are enforced by the board, so just keep pulling.

## Discover first — never guess names

```
sok commands | grep plugin.soksak-plugin-workflow
```

## Being an executor: the next → perform → submit loop

You (an LLM in a terminal) can perform verification turns yourself — no claude -p spawn:

1. `sok plugin.soksak-plugin-workflow.next` — returns one ready verification node:
   `{node:{id,kind,title}, prompt, schema, leaseMs}`. The node is leased to you (default 30
   min); the scheduler will not double-run it.
2. **Perform the prompt yourself, in this turn.** The `prompt` is the full directive; your
   answer MUST match `schema` and MUST carry an `oxf` verdict: `"o"` (holds), `"x"`
   (legitimately rejected, kept), `"f"` (fatal).
3. `sok plugin.soksak-plugin-workflow.submit node=<id> output='<your JSON>'` — the same badge
   pipeline as the spawn path records badge+result and wakes the next node.

Rules: never submit without `oxf` (rejected). A confirmed node rejects resubmission
(ALREADY_DONE) — do not retry it. If you cannot finish, just stop; the lease expires and the
scheduler reclaims the node.

## Orchestration commands

- `run idea="..."` — refine + publish a draft chunk; the scheduler takes over.
- `ping` — provider round-trip health check (no board writes).
- `research chunk=<id>` — gate: chunk badge must be 'o'. Publishes fact discovery → design →
  plan chain.
- `issuerize chunk=<id>` — gate: facts and plan units all confirmed. Publishes one
  codification task per confirmed file unit.
- `export chunk=<id> dir=/abs/path` — writes confirmed code nodes as real files (PROOF block
  stays on the node).
- `reconcile` — manually drive one ready node (the scheduler normally does this).

Progress is visible on the kanban board (every node, badge, and result) and in the run
catalog (`$SOKSAK_HOME/runs/soksak-sidecar-workflow/latest.jsonl`, raw event stream).

## Commands (snapshot — live: `sok commands | grep plugin.soksak-plugin-workflow.`, schema: `sok help <name>`)

- `export` — 인증 덩어리의 확정(badge='o') code 노드들을 대상 디렉토리에 실제 파일로 기록 — 파일 경로는 노드 title(파일경로), 내용은 코드 전문(PROOF 블록 제외). 미확정 code 노드가 남아 있으면 거부.
- `issuerize` — 인증된 덩어리(badge='o', fact·plan-unit 전부 검증)의 o 유닛들을 파일별 실코드화 body task 로 승격 — reconcile 이 실행해 code 노드(코드 전문+PROOF, badge 검증)를 발행한다. 재호출 멱등 거부.
- `next` — CLI 실행자의 pull — ready 검증 노드 1개의 실행 패키지(조립된 지시어 prompt + 산출 schema)를 반환하고 lease 를 잡는다(기본 30분, spawn 경로 제외). 수행 후 submit 으로 제출하라. 준비 노드가 없으면 node:null.
- `ping` — provider 헬스 프로브 — exec-one 실경로로 고정 미니 프롬프트 왕복. 보드 무접촉(멱등).
- `reconcile` — 칸반 ready 노드 1개를 실행 — item 은 exec-one 검증(badge o/x/f 기록), task 는 exec-stage(stage 실행·자식 노드 발행·classify category 기록·덩어리 result 갱신) → 다음 깨움.
- `research` — 인증된 드래프트 덩어리(badge='o')에 research 워크플로를 발행 — 기초지식(fact: framework/methodology/directive) 발굴·검증 후 plan(한턴 슈도코드화)이 자동 연결된다. directive=덩어리 description(정련 정본, 단일 진실). 재호출 멱등 거부.
- `run` — 아이디어(idea) 또는 워크플로 문서(workflow-doc@1) 를 받아 칸반에 노드 DAG 로 발행하고, reconcile 로 실행을 건다. idea 면 내부에서 generate-skeleton(LLM 저작→doc) 을 먼저 돈다.
- `submit` — CLI 실행자의 제출 — next 로 받은 노드의 검증 산출(oxf 필수)을 제출하면 spawn 경로와 동일 파이프(badge/result 기록→전이)를 탄다. 확정 노드 재제출은 ALREADY_DONE 멱등 거부, 무판정 제출은 즉시 거부.
