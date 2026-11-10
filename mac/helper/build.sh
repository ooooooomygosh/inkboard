#!/usr/bin/env bash
# Build "InkBoard Helper.app" (ad-hoc signed) into ~/.inkboard/
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-$HOME/.inkboard/InkBoard Helper.app}"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
swiftc -O main.swift -o "$APP/Contents/MacOS/InkBoardHelper" -framework EventKit -framework CoreLocation -framework AppKit
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.inkboard.helper</string>
  <key>CFBundleName</key><string>InkBoard Helper</string>
  <key>CFBundleDisplayName</key><string>InkBoard Helper</string>
  <key>CFBundleExecutable</key><string>InkBoardHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>把你的课程和会议显示在墨水屏看板上，并让 AI 按日程安排今天。</string>
  <key>NSCalendarsUsageDescription</key><string>把你的日程显示在墨水屏看板上。</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>按你所在的位置显示精确天气。</string>
  <key>NSLocationUsageDescription</key><string>按你所在的位置显示精确天气。</string>
  <key>NSAppleEventsUsageDescription</key><string>读取“邮件”里最近 3 天的学校或工作邮件，让 AI 筛出需要你处理的。</string>
  <key>NSDownloadsFolderUsageDescription</key><string>读取最近修改的研究笔记，让论文雷达和简报贴合你正在做的问题。</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null
echo "built $APP"
