#!/bin/bash
# 일회용 마이그레이션 — 실체 id 세대 이관: 카운터(t1·c1·g1·v1) → 접두형(pjt-·spc-·pan-·tab-).
#
# 무엇: app.data core kv 의 창 스냅샷("window/<label>") JSON 안에서 구세대 카운터 id 를
#   새 접두형 id 로 치환한다. 한 스냅샷 안의 같은 id 는 같은 새 id 로(참조 무결 —
#   activeViewId·activeGroupId·maximizedViewId 등 모든 참조가 함께 움직인다).
#   창 라벨(w-*)·split id(s* — 내부 노드, 복원 시 재생성)는 건드리지 않는다.
# 왜: id 는 자기 종류를 말해야 한다(docs/IDENTITY.md §6). g5 는 무엇인지도 어느 창의
#   것인지도 말하지 못한다. 신규 발급은 이미 접두형(src/state/ids.ts) — 이 스크립트가
#   영속 잔재를 같은 세대로 교정한다.
# PTY: 체크포인트/재부착 키의 pane_id 축은 여기서 건드리지 않는다 — 그 축은 셸 세션
#   자기 id(sh-, P0-5 이행 계약)가 담당하고, 그 전까지 탭 레코드의 legacyPaneId 가
#   옛 키를 보존한다(이 스크립트가 심는다). 손실 0 의 근거다.
# 플러그인 kv: 같은 매핑으로 ns != core 의 키·값 속 옛 id 도 치환한다(감사 적발 —
#   초판이 core 스냅샷만 덮어 vurl:v33·doc:t1 류 24키가 고아가 됐다).
# --reseed-from-backup <백업.db>: 이미 초판으로 이관된 홈의 잔여 수리 모드 — 백업(옛 id)과
#   현 스냅샷(새 id)을 트리 위치로 짝지어 매핑을 복원한 뒤, 플러그인 kv 치환과 탭 레코드
#   legacyPaneId 재식목만 수행한다(core 스냅샷 id 는 그대로).
# 사용: bash scripts/migrations/2026-07-26-entity-ids.sh [--identity debug|dev|app] [--dry-run]
#   기본 debug. 대상 identity 의 앱을 종료한 뒤 실행(실행 중이면 거부).
# 멱등: 이미 접두형인 id 는 건드리지 않는다. 이관 대상이 없으면 무변경.
#   실행 전 data/backups 에 타임스탬프 백업을 만든다. 변환 실패 시 원본 그대로 두고
#   비0 종료한다 — 반쯤 변환된 스냅샷을 남기지 않는다(전체가 한 트랜잭션).
set -euo pipefail

IDENTITY=debug
DRY=0
RESEED_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --reseed-from-backup) RESEED_FROM="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
if [ "$IDENTITY" = "app" ]; then HOME_DIR="$HOME/.soksak"; else HOME_DIR="$HOME/.soksak-$IDENTITY"; fi
DB="$HOME_DIR/data/soksak.db"
SOCK="$HOME_DIR/com.soksak.$IDENTITY.sock"
[ -f "$DB" ] || { echo "데이터 없음: $DB — 이관 대상 아님"; exit 0; }

if [ -S "$SOCK" ] && python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(1)
try: s.connect('$SOCK'); sys.exit(0)
except Exception: sys.exit(1)
" 2>/dev/null; then
  echo "거부: $IDENTITY 앱이 실행 중 — 종료 후 다시 실행" >&2; exit 1
fi

MIG_DB="$DB" MIG_DRY="$DRY" MIG_RESEED_FROM="$RESEED_FROM" python3 - <<'PYEOF'
import json, os, re, secrets, shutil, sqlite3, time

db = os.environ["MIG_DB"]
dry = os.environ["MIG_DRY"] == "1"
reseed_from = os.environ.get("MIG_RESEED_FROM") or ""
con = sqlite3.connect(db)
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")

ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
def body():
    return "".join(ALPHABET[b % 32] for b in secrets.token_bytes(6))

# 구세대 카운터 id → 새 접두. split(s*) 은 내부 노드라 제외(복원 시 재생성 — IDENTITY §4).
PREFIX = {"t": "pjt-", "c": "spc-", "g": "pan-", "v": "tab-"}
OLD_ID = re.compile(r"^([tcgv])(\d+)$")

NEW_ID = re.compile(r"^(pjt|spc|pan|tab)-[a-z2-7]{6}$")

def replace_ids_in_text(text: str, mapping: dict) -> str:
    # 값 문자열 속 옛 id 참조를 단어 경계로 치환 — vurl:v33 의 v33, JSON 값 속 "t1" 등.
    def sub(m):
        return mapping.get(m.group(0), m.group(0))
    return re.sub(r"\b[tcgv]\d+\b", sub, text)

def rewrite_plugin_kv(mapping: dict) -> int:
    # ns != core 의 키·값 속 옛 id 치환. 키 충돌 시(이미 새 키 존재) 옛 키만 버린다.
    rows = con.execute("SELECT ns, k, v FROM kv WHERE ns != 'core'").fetchall()
    changed = 0
    for ns, k, v in rows:
        nk = replace_ids_in_text(k, mapping)
        nv = replace_ids_in_text(v, mapping) if isinstance(v, str) else v
        if nk == k and nv == v:
            continue
        changed += 1
        if dry:
            continue
        # 실 스키마는 컬럼이 더 있다(updated NOT NULL 등) — 행을 새로 만들지 않고
        # 키·값만 제자리 갱신한다. 키 충돌(새 키 실존)이면 최신이 이기고 옛 행만 걷는다.
        if nk != k and con.execute(
            "SELECT 1 FROM kv WHERE ns=? AND k=?", (ns, nk)
        ).fetchone():
            con.execute("DELETE FROM kv WHERE ns=? AND k=?", (ns, k))
            continue
        con.execute(
            "UPDATE kv SET k=?, v=? WHERE ns=? AND k=?", (nk, nv, ns, k)
        )
    return changed

def plant_legacy_into(doc, inverse):
    def plant(node):
        if isinstance(node, dict):
            nid = node.get("id")
            if isinstance(nid, str) and nid.startswith("tab-") and nid in inverse and "kind" in node:
                node.setdefault("legacyPaneId", inverse[nid])
            for vv in node.values():
                plant(vv)
        elif isinstance(node, list):
            for x in node:
                plant(x)
    plant(doc)

if reseed_from:
    # ── 잔여 수리 모드 — 백업(옛 id)과 현 스냅샷(새 id)을 트리 위치로 짝지어 매핑 복원 ──
    bcon = sqlite3.connect(reseed_from)
    mapping = {}
    for k, v in con.execute("SELECT k, v FROM kv WHERE ns='core' AND k LIKE 'window/%'"):
        old_row = bcon.execute("SELECT v FROM kv WHERE ns='core' AND k=?", (k,)).fetchone()
        if not old_row:
            continue
        old_doc, new_doc = json.loads(old_row[0]), json.loads(v)
        def pair(a, b):
            if isinstance(a, dict) and isinstance(b, dict):
                ia, ib = a.get("id"), b.get("id")
                if isinstance(ia, str) and isinstance(ib, str) and OLD_ID.match(ia) and NEW_ID.match(ib):
                    mapping[ia] = ib
                for kk in a:
                    if kk in b:
                        pair(a[kk], b[kk])
            elif isinstance(a, list) and isinstance(b, list):
                for x, y in zip(a, b):
                    pair(x, y)
        pair(old_doc, new_doc)
        # legacyPaneId 재식목 — 보존 코드보다 먼저 이관된 홈의 소실 복구.
        inverse = {n: o for o, n in mapping.items()}
        plant_legacy_into(new_doc, inverse)
        if not dry:
            con.execute("UPDATE kv SET v=? WHERE ns='core' AND k=?", (json.dumps(new_doc, ensure_ascii=False), k))
    kvn = rewrite_plugin_kv(mapping)
    if not dry:
        con.commit()
    print(f"잔여 수리: 매핑 {len(mapping)}쌍 복원, 플러그인 kv {kvn}건 치환, legacyPaneId 재식목")
    raise SystemExit(0)

rows = con.execute("SELECT k, v FROM kv WHERE ns='core' AND k LIKE 'window/%'").fetchall()
if not rows:
    print("스냅샷 없음 — 이관 대상 아님")
    raise SystemExit(0)

total_mapped = 0
changed = []
GLOBAL_MAPPING: dict = {}
for k, v in rows:
    doc = json.loads(v)
    mapping: dict[str, str] = GLOBAL_MAPPING

    def convert(val):
        # id 로 쓰이는 문자열만 — 키 이름이 Id 로 끝나는 필드와 id 필드, 그리고 그 참조.
        m = OLD_ID.match(val)
        if not m:
            return val
        if val not in mapping:
            mapping[val] = f"{PREFIX[m.group(1)]}{body()}"
        return mapping[val]

    # legacy* 필드는 제외 — 그 값이 바로 보존해야 할 옛 키다. 재실행이 그것까지 변환하면
    # 멱등이 깨지고 PTY 손실 0 의 근거가 사라진다(픽스처 실측으로 잡은 결함).
    ID_KEYS = re.compile(r"(^id$|Id$)")
    LEGACY_KEYS = re.compile(r"^legacy")

    def walk(node, parent_key=""):
        if isinstance(node, dict):
            out = {}
            for kk, vv in node.items():
                if isinstance(vv, str) and ID_KEYS.search(kk) and not LEGACY_KEYS.match(kk) and OLD_ID.match(vv):
                    out[kk] = convert(vv)
                else:
                    out[kk] = walk(vv, kk)
            return out
        if isinstance(node, list):
            return [walk(x, parent_key) for x in node]
        return node

    # 1패스: id 선언부(모든 *Id/id 필드)가 매핑을 만든다. 2패스: 같은 매핑으로 잔여 참조
    # (예: 문자열 값으로만 남은 참조)를 정합시킨다 — 선언과 참조가 항상 같이 움직인다.
    new_doc = walk(doc)
    new_doc = walk(new_doc)

    # 탭 레코드에 legacyPaneId 를 심는다 — PTY 재부착·체크포인트의 옛 키 보존(손실 0 근거).
    def plant_legacy(node):
        if isinstance(node, dict):
            # 구조상 탭 레코드 = views[] 원소(kind 필드 보유). 옛 id 는 mapping 의 역방향에서.
            for kk, vv in list(node.items()):
                plant_legacy(vv)
            return
        if isinstance(node, list):
            for x in node:
                plant_legacy(x)

    inverse = {new: old for old, new in mapping.items()}

    def plant(node):
        if isinstance(node, dict):
            nid = node.get("id")
            if isinstance(nid, str) and nid.startswith("tab-") and nid in inverse and "kind" in node:
                node["legacyPaneId"] = inverse[nid]
            for vv in node.values():
                plant(vv)
        elif isinstance(node, list):
            for x in node:
                plant(x)

    plant(new_doc)

    if mapping:
        changed.append((k, new_doc, len(mapping)))
        total_mapped += len(mapping)

if not changed:
    print("전 스냅샷이 이미 접두형 — 무변경")
    raise SystemExit(0)

print(f"이관 대상: 스냅샷 {len(changed)}개, id {total_mapped}개")
for k, _, n in changed:
    print(f"  {k}: {n}개")

if dry:
    print("dry-run — 쓰지 않음")
    raise SystemExit(0)

backup_dir = os.path.join(os.path.dirname(db), "backups")
os.makedirs(backup_dir, exist_ok=True)
stamp = time.strftime("%Y%m%d-%H%M%S")
backup = os.path.join(backup_dir, f"soksak-pre-entity-ids-{stamp}.db")
shutil.copy2(db, backup)
print(f"백업: {backup}")

all_mapping = {}
for _, _, _ in changed:
    pass
try:
    with con:  # 전체가 한 트랜잭션 — 중간 실패 시 원본 그대로
        for k, new_doc, _ in changed:
            con.execute(
                "UPDATE kv SET v=? WHERE ns='core' AND k=?",
                (json.dumps(new_doc, ensure_ascii=False), k),
            )
        kvn = rewrite_plugin_kv(GLOBAL_MAPPING)
        print(f"플러그인 kv {kvn}건 치환")
except Exception as e:
    print(f"실패 — 원본 무변경(트랜잭션 롤백): {e}")
    raise SystemExit(1)

print("완료 — 앱을 다시 시작하면 접두형 id 로 복원된다")
PYEOF
