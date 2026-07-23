---
name: soksak-kanban
description: Use when managing tasks/issues as a tree inside soksak — drive the kanban plugin entirely by CLI/MCP commands (`sok plugin.soksak-plugin-kanban.*`) to add/edit/move nodes, indent/outdent (re-parent) in the outline, set status for board columns, and project the one tree into board/outline/timeline/column views. Headless: works without opening the GUI. 칸반, 이슈/할일 트리, 아웃라이너, 들여쓰기/내어쓰기, 노드 이동, 상태 변경, 보드도 여기.
---

# soksak kanban — one tree, many views

The kanban plugin is **an outliner, not a flat board**. There is exactly one tree of nodes; every node has a `parentId` and an `order` among its siblings. A status field (`todo`/`doing`/`done`…) is just a node field — the board view groups by it, but the data is always the tree. Board, outline, timeline, and column views are **projections of the same tree**; mutate the tree and every view reflects it. Drive it all by command — a view, if open, only renders.

## Discover first

Names/params evolve — never guess. List the live surface:

```
sok commands | grep plugin.soksak-plugin-kanban
```

`node.list` and `view.get` read the tree; `stats` summarizes. `node.get node=<id> withChildren=true` returns a subtree.

## Mental model (read this before mutating)

- **A node's position = `parentId` + `order`.** Nothing else. Siblings are ordered by `order`; depth comes from the parent chain.
- **`outline.indent` = re-parent under the previous sibling.** `outline.outdent` = move up to the grandparent, after its parent. This is the single source of structure — "indent" is not cosmetic, it changes the tree.
- **`outline.move node=<id> parentId=<id> position=<n>`** re-parents explicitly; **`outline.reorder`** changes order among current siblings only.
- **`board.move node=<id> status=<col> position=<n>`** sets the status field (which board column it lands in) and its order within that column — the tree parent is unchanged.
- **`focus.set node=<id>`** zooms into a subtree (fractal focus): subsequent views scope to that node's descendants. `focus.set` with no node resets to root. `breadcrumb` shows the current focus path.

## Core workflow (build from a prompt)

```
# add a top-level epic, then children under it
sok plugin.soksak-plugin-kanban.node.add title='Auth' type=epic status=todo
sok plugin.soksak-plugin-kanban.node.add title='Login form' parentId=<epicId> status=todo points=3
# nest an existing node one level deeper (under its previous sibling)
sok plugin.soksak-plugin-kanban.outline.indent node=<id>
# move a card across board columns
sok plugin.soksak-plugin-kanban.board.move node=<id> status=doing position=0
```

Read back with `view.get view=board` (or `outline`/`timeline`) and `node.list parentId=<id> status=doing search=<text>`.

## Conventions

- Every command returns `{ok:true,…}` or `{ok:false,error}`. No throws — branch on `ok`.
- Address nodes by id (from `node.add`/`node.list`). `node.remove promoteChildren=true` lifts children to the grandparent instead of deleting them.
- It is **headless-complete** — you never need the GUI. The tree is the single source of truth; views only project it.

## Commands (snapshot — live: `sok commands | grep plugin.soksak-plugin-kanban.`, schema: `sok help <name>`)

- `board.move` — Move a node to a different board column by changing its status. Records a history entry. Optionally sets its position within the target column.
- `board.reorder` — Reorder a node within its current board column by setting a new 0-based position.
- `board.sort` — Sort the children of a parent node by a given key and persist the new order.
- `breadcrumb` — Return the ancestor path from the root to the focus node, useful for showing current position in the tree.
- `column.list` — List all board columns (statuses) with their metadata and current card count.
- `focus.set` — Navigate the open kanban GUI to a node and/or switch its view. For headless queries without a GUI, use view.get with the focus parameter instead.
- `node.add` — Add a node to the tree. Omit parentId to add at root level. Inserts after the sibling specified by 'after'.
- `node.edit` — Edit fields of a node. Changing status automatically appends a history entry.
- `node.get` — Fetch a single node by id or key. Use withChildren=true to include its direct children.
- `node.list` — List nodes with optional filters. Filter by parentId, status, type, assignee, or a search term against key and title.
- `node.remove` — Remove a node. With promoteChildren=true, children are re-parented to the grandparent; otherwise the entire subtree is deleted.
- `outline.indent` — Indent a node — make it a child of its previous sibling (re-parents in the tree). Use to nest an item under another.
- `outline.move` — Move a node to a different parent (reparent) at an optional position. Rejects moves that would create a cycle (moving under a descendant).
- `outline.outdent` — Outdent a node — move it up one level under the grandparent, after the former parent. Carries children along and absorbs trailing siblings.
- `outline.reorder` — Reorder a node within its current parent by setting a new 0-based sibling position.
- `ping` — 플러그인 적재/버전 확인(E2E)
- `prompt.get` — hash 로 저장 값 조회(네이티브 JSON — 문자열/객체). 소비 시점 조립용.
- `prompt.put` — 콘텐츠 주소(sha256) store — JSON 값(문자열 템플릿/directive 또는 객체 schema) 저장·dedup. hash 반환. 값은 네이티브 보관(stringify 왕복 없음).
- `prompt.resolve` — promptHash + vars(+refs) → 완성 프롬프트. {{key}}→vars(인라인 작은 값) 또는 refs(콘텐츠 주소 deref). exec-one·UI 공용 조립.
- `reset` — Delete all nodes and return to an empty board. This action is irreversible.
- `seed` — Load a demo tree (depth 4) for exploration. Skips if data already exists unless force=true.
- `stats` — Return progress statistics: completion rate, in-progress count, story points, bottlenecks, and stale nodes. Scoped to a focus node's descendants when specified.
- `timeline` — Return the status-transition timeline grouped by date in descending order. Useful for reviewing recent activity.
- `view.get` — Return a view projection. board/outline/tree projections are scoped to the focus node's children; other views (gantt, timeline, table, calendar) are global.
