#!/bin/sh
# 제품 번들 — Electron 앱이 자기 이름으로 서게 한다.
#
# macOS 는 앱의 정체(메뉴바 타이틀·Dock 이름·프로세스 이름)를 **번들의 Info.plist** 에서
# 읽는다. `app.setName()` 도 애플리케이션 메뉴 첫 항목 label 도 그것을 못 이긴다(실측
# 2026-07-31: 둘 다 넣었는데 메뉴바가 "Electron" 이었다). 그래서 프레임워크의 기본 번들을
# 빌려 쓰는 한 이 제품은 프레임워크의 이름으로 보인다 — Tauri 쪽은 cargo 가 자기 실행물을
# 만들어 이름이 맞고, Electron 쪽만 비대칭이었다.
#
# 하는 일은 하나다: 프레임워크 번들을 **복사**해 이름만 이 정체성의 것으로 바꾼다(심링크
# 금지 — 경로는 선언이거나 실물이어야 한다). 멱등하다: 이미 최신이면 아무것도 하지 않는다.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC="$ROOT/node_modules/electron/dist/Electron.app"
# 이름은 **정체성에서 파생한다** — 여기 적으면 규칙이 한 벌 더 생기고, 두 벌은 갈릴 때까지
# 조용하다. 파생 규칙의 정본은 crates/soksak-core/fixtures/identity.json 이고 Rust·JS 두
# 구현이 그 픽스처에 묶여 있다. 이 스크립트는 그중 JS 쪽에 물어본다.
IDENTIFIER=${1:?"정체성을 인자로 준다(예: com.soksak.electron.dev)"}
NAME=$(node -e "process.stdout.write(require('$ROOT/frameworks/electron/cored.cjs').productName(process.argv[1]))" "$IDENTIFIER")
[ -n "$NAME" ] || { echo "제품 이름을 파생하지 못했다: $IDENTIFIER" >&2; exit 1; }
OUT_DIR="$ROOT/frameworks/electron/build"
APP="$OUT_DIR/$NAME.app"

[ -d "$SRC" ] || { echo "electron dist 가 없다: $SRC" >&2; exit 1; }

# 신선도 — 프레임워크 번들이 이 산출물보다 새로우면 다시 짓는다(판올림 뒤 낡은 껍데기 금지).
#
# **이 스크립트 자신도 신선도의 일부다.** 번들의 모양(이름·URI 스킴·서명)을 정하는 것이 이
# 파일이므로, 여기가 바뀌었는데 산출물이 그대로면 그 변경은 아무 데도 안 나타난다 — 실측
# 2026-08-01: URI 스킴 등록을 넣었는데 낡은 번들이 그대로 실행돼 딥링크가 안 닿았고, 그 부재는
# 오류가 아니라 "안 열린다"로만 보였다.
if [ -x "$APP/Contents/MacOS/$NAME" ] && [ ! "$SRC" -nt "$APP" ] && [ ! "$0" -nt "$APP" ]; then
  echo "$APP"
  exit 0
fi

rm -rf "$OUT_DIR/.staging" "$APP"
mkdir -p "$OUT_DIR/.staging"
cp -R "$SRC" "$OUT_DIR/.staging/$NAME.app"

STAGED="$OUT_DIR/.staging/$NAME.app"
mv "$STAGED/Contents/MacOS/Electron" "$STAGED/Contents/MacOS/$NAME"

PLIST="$STAGED/Contents/Info.plist"
for key in CFBundleName CFBundleDisplayName CFBundleExecutable; do
  /usr/libexec/PlistBuddy -c "Set :$key $NAME" "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :$key string $NAME" "$PLIST"
done

# URI 스킴 등록 — OS 가 `soksak://…` 을 이 앱으로 넘기게 한다. 스킴은 **제품의 것**이고 규칙은
# 코어가 쥔다(soksak-core deeplink.rs). 여기서 하는 것은 OS 에 그 사실을 알리는 일뿐이다.
# 등록이 없으면 `open soksak://…` 이 이 앱에 영영 안 닿고, 그 부재는 오류가 아니라 "저 앱에서는
# 링크가 안 열린다"로만 나타난다.
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy \
  -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string $NAME" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string soksak" \
  "$PLIST"

# 서명은 이름을 바꾼 순간 깨진다 — ad-hoc 으로 다시 붙인다. 안 붙이면 실행 자체가 막힌다.
codesign --force --deep --sign - "$STAGED" 2>/dev/null || true

# 원자 교체 — 반쯤 지어진 번들이 실행되는 창을 열지 않는다.
mv "$STAGED" "$APP"
rmdir "$OUT_DIR/.staging" 2>/dev/null || true

echo "$APP"
