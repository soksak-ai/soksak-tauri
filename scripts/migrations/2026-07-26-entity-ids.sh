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
# 사용: bash scripts/migrations/2026-07-26-entity-ids.sh [--identity debug|dev|app] [--dry-run]
#   기본 debug. 대상 identity 의 앱을 종료한 뒤 실행(실행 중이면 거부).
# 멱등: 이미 접두형인 id 는 건드리지 않는다. 이관 대상이 없으면 무변경.
#   실행 전 data/backups 에 타임스탬프 백업을 만든다. 변환 실패 시 원본 그대로 두고
#   비0 종료한다 — 반쯤 변환된 스냅샷을 남기지 않는다(전체가 한 트랜잭션).
set -euo pipefail

IDENTITY=debug
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
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

MIG_DB="$DB" MIG_DRY="$DRY" python3 - <<'PYEOF'
import json, os, re, secrets, shutil, sqlite3, time

db = os.environ["MIG_DB"]
dry = os.environ["MIG_DRY"] == "1"
con = sqlite3.connect(db)
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")

ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
def body():
    return "".join(ALPHABET[b % 32] for b in secrets.token_bytes(6))

# 구세대 카운터 id → 새 접두. split(s*) 은 내부 노드라 제외(복원 시 재생성 — IDENTITY §4).
PREFIX = {"t": "pjt-", "c": "spc-", "g": "pan-", "v": "tab-"}
OLD_ID = re.compile(r"^([tcgv])(\d+)$")

rows = con.execute("SELECT k, v FROM kv WHERE ns='core' AND k LIKE 'window/%'").fetchall()
if not rows:
    print("스냅샷 없음 — 이관 대상 아님")
    raise SystemExit(0)

total_mapped = 0
changed = []
for k, v in rows:
    doc = json.loads(v)
    mapping: dict[str, str] = {}

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

try:
    with con:  # 전체가 한 트랜잭션 — 중간 실패 시 원본 그대로
        for k, new_doc, _ in changed:
            con.execute(
                "UPDATE kv SET v=? WHERE ns='core' AND k=?",
                (json.dumps(new_doc, ensure_ascii=False), k),
            )
except Exception as e:
    print(f"실패 — 원본 무변경(트랜잭션 롤백): {e}")
    raise SystemExit(1)

print("완료 — 앱을 다시 시작하면 접두형 id 로 복원된다")
PYEOF
