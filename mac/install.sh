#!/usr/bin/env bash
# InkBoard Mac collector installer.
#   ./install.sh <WORKER_URL> <INGEST_TOKEN>
# Installs to ~/.inkboard, a launchd job for AI quotas, and async hooks for Claude Code and Codex.
# Re-running is safe (replaces previous InkBoard entries). Undo with ./uninstall.sh.
set -euo pipefail
URL="${1:?usage: install.sh <WORKER_URL> <INGEST_TOKEN>}"
TOKEN="${2:?usage: install.sh <WORKER_URL> <INGEST_TOKEN>}"
SRC="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/.inkboard"
PY="$(command -v python3)"
mkdir -p "$APP/state" "$HOME/Library/Logs/InkBoard" "$HOME/Library/LaunchAgents"

CLI="$(ls -d /Applications/CodexBar.app/Contents/Helpers/CodexBarCLI /Applications/CodexBar*.app/Contents/Helpers/CodexBarCLI 2>/dev/null | head -1 || true)"
[[ -z "$CLI" ]] && CLI="$(command -v codexbar || true)"

cp "$SRC/inkboard_hook.py" "$SRC/quota_push.py" "$SRC/helper_sync.py" "$SRC/autoloop_bridge.py" "$SRC/mail.applescript" "$APP/"
# Helper app: Calendar / Location / Mail / Downloads need a real app bundle for macOS permissions
# rebuild only when the source changed: an ad-hoc signature changes on every build and macOS would ask for permissions again
if [[ ! -d "$APP/InkBoard Helper.app" || "$SRC/helper/main.swift" -nt "$APP/InkBoard Helper.app/Contents/MacOS/InkBoardHelper" ]]; then "$SRC/helper/build.sh" "$APP/InkBoard Helper.app" >/dev/null; fi
KEEP="$(grep -E '^(AUTOLOOP_|MAIL_SYNC|MAIL_DAYS|MAIL_DOMAIN|LOCATION_SYNC|CALENDAR_SYNC|NOTES_DIRS|SHARE_|HOST_LABEL|SSH_HOST_LABEL|PROVIDERS)' "$APP/config.env" 2>/dev/null || true)"
cat > "$APP/config.env" <<CFG
WORKER_URL=$URL
INGEST_TOKEN=$TOKEN
CODEXBAR_CLI=$CLI
# providers to query through CodexBar: auto = every provider enabled in the CodexBar app
PROVIDERS=auto
# local token usage (Claude Code / Codex logs)
COST_PROVIDERS=claude codex
# 1 = show the first 30 characters of each prompt as the session title on the screen
SHARE_PROMPT_TITLE=0
# InkBoard Helper jobs: research notes + location (+ work/school mail from Apple Mail)
# Calendars usually come through an ICS link in the editor, so macOS Calendar is off by default.
HELPER_ENABLED=1
LOCATION_SYNC=1
CALENDAR_SYNC=0
MAIL_SYNC=0
MAIL_DAYS=3
# only mail to/from this domain reaches the board, e.g. example.edu (empty = every inbox message)
MAIL_DOMAIN=
# extra folders for research notes, separated by ':' (default: ~/Downloads)
NOTES_DIRS=
# 1 = send the agent's final reply (first 800 chars) so the server can write a one-line "what got done" summary
SHARE_SUMMARY=1
CFG
[[ -n "$KEEP" ]] && printf '\n%s\n' "$KEEP" >> "$APP/config.env"
# kept settings override the defaults above: drop the earlier duplicate of every key
awk -F= '/^[A-Z_]+=/{last[$1]=NR} {line[NR]=$0; key[NR]=($0 ~ /^[A-Z_]+=/) ? $1 : ""} END{for(i=1;i<=NR;i++) if(key[i]=="" || last[key[i]]==i) print line[i]}' "$APP/config.env" > "$APP/config.env.tmp" && mv "$APP/config.env.tmp" "$APP/config.env"
chmod 600 "$APP/config.env"
DOMAIN="$(grep -E '^MAIL_DOMAIN=' "$APP/config.env" | tail -1 | cut -d= -f2- | tr -d '"' )"
sed -i '' "s|{{DOMAIN}}|${DOMAIN}|g" "$APP/mail.applescript"

# Hook wrapper: hand the payload to a detached Python process and return immediately.
cat > "$APP/inkboard-hook" <<HOOK
#!/bin/sh
P="\$(cat)"
( printf '%s' "\$P" | "$PY" "$APP/inkboard_hook.py" "\$1" >/dev/null 2>&1 & )
exit 0
HOOK
chmod +x "$APP/inkboard-hook"

# launchd: quotas every 3 minutes
PL="$HOME/Library/LaunchAgents/com.inkboard.quota.plist"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.inkboard.quota</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$APP/quota_push.py</string></array>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/InkBoard/quota.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/InkBoard/quota.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/com.inkboard.quota" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PL"

# launchd: helper jobs every 10 minutes (each job keeps its own cadence)
PH="$HOME/Library/LaunchAgents/com.inkboard.helper.plist"
cat > "$PH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.inkboard.helper</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$APP/helper_sync.py</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/InkBoard/helper.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/InkBoard/helper.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/com.inkboard.helper" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PH"

# launchd: agent-autoloop bridge (only when agent-autoloop is installed)
if [[ -f "$HOME/.agent-autoloop/config.json" ]]; then
  mkdir -p "$HOME/InkBoard/agent-work/tasks"
  PB="$HOME/Library/LaunchAgents/com.inkboard.bridge.plist"
  cat > "$PB" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.inkboard.bridge</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$APP/autoloop_bridge.py</string></array>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/InkBoard/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/InkBoard/bridge.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/com.inkboard.bridge" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PB"
fi

# Merge hooks into Claude Code and Codex configs (backups kept next to the originals).
"$PY" - "$APP/inkboard-hook" <<'PYEOF'
import json, os, shutil, sys, time
hook = sys.argv[1]
def merge(path, events, kind, extra):
    data = {}
    if os.path.exists(path):
        shutil.copy(path, f"{path}.inkboard-bak-{int(time.time())}")
        with open(path) as f:
            data = json.load(f)
    hooks = data.setdefault('hooks', {})
    for ev in list(hooks):
        groups = [g for g in hooks[ev] if not any('.inkboard/inkboard-hook' in h.get('command', '') for h in g.get('hooks', []))]
        if groups: hooks[ev] = groups
        else: del hooks[ev]
    for ev in events:
        group = {'hooks': [{'type': 'command', 'command': f'{hook} {kind}', 'timeout': 5, **extra}]}
        if ev in ('PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification'):
            group = {'matcher': '*', **group}
        hooks.setdefault(ev, []).append(group)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print('hooks ->', path)
home = os.path.expanduser('~')
merge(f'{home}/.claude/settings.json', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'], 'claude', {})
merge(f'{home}/.codex/hooks.json', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'], 'codex', {'async': True})
PYEOF

echo "InkBoard collector installed."
echo "  quotas : launchd com.inkboard.quota (log: ~/Library/Logs/InkBoard/quota.log)"
echo "  hooks  : ~/.claude/settings.json, ~/.codex/hooks.json"
echo "  Codex  : run /hooks once inside Codex and trust the InkBoard hooks."
