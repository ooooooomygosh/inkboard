#!/usr/bin/env bash
# Hide the stock apps you do not want, so the reader boots straight into InkBoard.
# The list lives in debloat.txt (one package per line, # for comments; copy debloat.example.txt).
# Every removal is `pm uninstall -k --user 0`: the APK stays on /system, nothing is deleted from
# flash, and ./restore.sh brings any of them back.
set -euo pipefail
cd "$(dirname "$0")"
ADB="${ADB:-$(command -v adb || ls -d "$HOME"/Library/Android/*/platform-tools/adb 2>/dev/null | head -1)}"
LIST="${1:-debloat.txt}"
[[ -f "$LIST" ]] || { echo "没有 $LIST：先 cp debloat.example.txt debloat.txt，按 adb shell pm list packages 的结果改"; exit 1; }

# Make InkBoard the home screen first so removing the stock launcher never leaves the device without one.
"$ADB" shell cmd package set-home-activity com.inkboard/.MainActivity >/dev/null

grep -vE '^\s*(#|$)' "$LIST" | awk '{print $1}' | while read -r p; do
  if "$ADB" shell pm path "$p" </dev/null >/dev/null 2>&1; then
    printf '%-40s ' "$p"; "$ADB" shell pm uninstall -k --user 0 "$p" </dev/null 2>&1 | tr -d '\r'
  fi
done
echo "还在的第三方应用："
"$ADB" shell pm list packages -3 || true
