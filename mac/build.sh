#!/bin/sh
# Build (and optionally install) ANVIL Crew.app. Usage: mac/build.sh [--install]
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
BUILD="$HERE/build"
APP_NAME="ANVIL Crew"
APP="$BUILD/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"
BRAND_SVG="$HERE/../ds-bot/assets/brand/icon.svg"
FALLBACK_SVG="$HERE/icon.svg"

INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    *) echo "usage: $0 [--install]" >&2; exit 2 ;;
  esac
done

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> compiling (arm64, Swift 6 mode)"
xcrun swiftc -O -swift-version 6 -warnings-as-errors \
  -target arm64-apple-macos14.0 \
  -o "$APP/Contents/MacOS/ANVILCrew" \
  "$HERE"/Sources/*.swift

echo "==> icon"
if [ -f "$BRAND_SVG" ]; then SVG="$BRAND_SVG"; else SVG="$FALLBACK_SVG"; fi
echo "    source: $SVG"
xcrun swiftc -O -o "$BUILD/render-icon" "$HERE/tools/render-icon.swift"
"$BUILD/render-icon" "$SVG" "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

echo "==> bundle"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> ad-hoc signing"
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"

if [ "$INSTALL" -eq 1 ]; then
  echo "==> installing to $DEST"
  osascript -e 'quit app "ANVIL Crew"' >/dev/null 2>&1 || true
  n=0
  while pgrep -x ANVILCrew >/dev/null 2>&1 && [ "$n" -lt 20 ]; do sleep 0.25; n=$((n + 1)); done
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  codesign --verify --deep --strict "$DEST"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
  echo "installed: $DEST"
else
  echo "built: $APP"
fi
