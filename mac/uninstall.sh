#!/usr/bin/env bash
# Remove the InkBoard collector: launchd job, Claude/Codex hook entries, ~/.inkboard.
set -euo pipefail
launchctl bootout "gui/$(id -u)/com.inkboard.quota" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.inkboard.quota.plist"
launchctl bootout "gui/$(id -u)/com.inkboard.helper" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.inkboard.helper.plist"
launchctl bootout "gui/$(id -u)/com.inkboard.bridge" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.inkboard.bridge.plist"
python3 - <<'PYEOF'
import json, os
home = os.path.expanduser('~')
for path in (f'{home}/.claude/settings.json', f'{home}/.codex/hooks.json'):
    if not os.path.exists(path): continue
    with open(path) as f: data = json.load(f)
    hooks = data.get('hooks', {})
    for ev in list(hooks):
        groups = [g for g in hooks[ev] if not any('.inkboard/inkboard-hook' in h.get('command', '') for h in g.get('hooks', []))]
        if groups: hooks[ev] = groups
        else: del hooks[ev]
    if not hooks: data.pop('hooks', None)
    with open(path, 'w') as f: json.dump(data, f, indent=2, ensure_ascii=False)
    print('cleaned', path)
PYEOF
rm -rf "$HOME/.inkboard"
echo "InkBoard collector removed."
