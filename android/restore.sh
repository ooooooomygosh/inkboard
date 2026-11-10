#!/usr/bin/env bash
# Bring back apps hidden by debloat.sh.  ./restore.sh            -> everything in debloat.txt
#                                       ./restore.sh <package>  -> one package
set -euo pipefail
cd "$(dirname "$0")"
ADB="${ADB:-$(command -v adb || ls -d "$HOME"/Library/Android/*/platform-tools/adb 2>/dev/null | head -1)}"
{ if [[ $# -gt 0 ]]; then printf '%s\n' "$@"; else grep -vE '^\s*(#|$)' debloat.txt | awk '{print $1}'; fi; } | while read -r p; do
  printf '%-40s ' "$p"; "$ADB" shell cmd package install-existing "$p" </dev/null 2>&1 | tr -d '\r'
done
