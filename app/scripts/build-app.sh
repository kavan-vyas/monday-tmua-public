#!/bin/zsh
# Rebuild the native Monday.app executable from TMUATutor.swift.
# The bundle keeps its existing Info.plist and Resources/AppIcon.icns.
set -e
HERE="${0:A:h}"
APP="${HERE:h:h}/Monday.app"
# Must match CFBundleExecutable in Info.plist or the app will not launch.
BIN="$APP/Contents/MacOS/Monday"

swiftc -O -target arm64-apple-macos11.0 \
  -framework Cocoa -framework WebKit \
  -o "$BIN" "$HERE/TMUATutor.swift"

# Ad-hoc sign so macOS keeps window/keychain state across rebuilds.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
touch "$APP"
echo "built: $BIN"
