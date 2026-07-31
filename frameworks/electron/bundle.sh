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
NAME=${1:?"제품 이름을 인자로 준다(예: soksak-electron-dev)"}
OUT_DIR="$ROOT/frameworks/electron/build"
APP="$OUT_DIR/$NAME.app"

[ -d "$SRC" ] || { echo "electron dist 가 없다: $SRC" >&2; exit 1; }

# 신선도 — 프레임워크 번들이 이 산출물보다 새로우면 다시 짓는다(판올림 뒤 낡은 껍데기 금지).
if [ -x "$APP/Contents/MacOS/$NAME" ] && [ ! "$SRC" -nt "$APP" ]; then
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

# 서명은 이름을 바꾼 순간 깨진다 — ad-hoc 으로 다시 붙인다. 안 붙이면 실행 자체가 막힌다.
codesign --force --deep --sign - "$STAGED" 2>/dev/null || true

# 원자 교체 — 반쯤 지어진 번들이 실행되는 창을 열지 않는다.
mv "$STAGED" "$APP"
rmdir "$OUT_DIR/.staging" 2>/dev/null || true

echo "$APP"
