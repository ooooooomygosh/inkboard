#!/usr/bin/env python3
"""Claude Code / Codex hook -> InkBoard agent event.

Invoked by the `inkboard-hook` wrapper, which has already detached from the agent,
so nothing here can slow Claude Code or Codex down. Prompts are never uploaded:
only the event type, tool name and a short argument summary.
"""
import json, os, ssl, socket, subprocess, sys, urllib.request
from datetime import datetime, timezone

# python.org builds ship without CA certs; use the macOS bundle.
SSL_CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()
HOME = os.path.expanduser('~')
APP = os.path.join(HOME, '.inkboard')
STATE = os.path.join(HOME, '.inkboard', 'state')


def load_config():
    cfg = {}
    try:
        with open(os.path.join(APP, 'config.env')) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    cfg[k.strip()] = v.strip().strip('"')
    except FileNotFoundError:
        pass
    return cfg


def clip(s, n):
    s = ' '.join(str(s or '').split())
    return s if len(s) <= n else s[: n - 1] + '…'


def summarize(tool, inp):
    inp = inp or {}
    if not isinstance(inp, dict):
        return clip(inp, 60)
    base = lambda p: os.path.basename(str(p).rstrip('/')) if p else ''
    t = (tool or '').lower()
    if t in ('bash', 'shell', 'exec_command', 'local_shell', 'unified_exec'):
        cmd = inp.get('command') or inp.get('cmd') or ''
        if isinstance(cmd, list):
            cmd = ' '.join(cmd[2:] if cmd[:2] in (['bash', '-lc'], ['bash', '-c'], ['zsh', '-lc']) else cmd)
        return clip(cmd, 60)
    for k in ('file_path', 'path', 'notebook_path'):
        if inp.get(k):
            return base(inp[k])
    if t == 'apply_patch':
        patch = inp.get('input') or inp.get('patch') or ''
        files = [l.split(':', 1)[1].strip() for l in str(patch).splitlines() if l.startswith(('*** Update File:', '*** Add File:', '*** Delete File:'))]
        return clip(', '.join(base(f) for f in files) or 'patch', 60)
    for k in ('pattern', 'query', 'url', 'description', 'prompt', 'skill'):
        if inp.get(k):
            v = inp[k]
            if k == 'url':
                v = v.split('/')[2] if '://' in v else v
            return clip(v, 50)
    if t.startswith('mcp__'):
        return t.split('__')[-1]
    return ''


def tool_label(tool):
    if not tool:
        return None
    if tool.startswith('mcp__'):
        parts = tool.split('__')
        return parts[1][:18] if len(parts) > 2 else tool
    return {'exec_command': 'Shell', 'local_shell': 'Shell', 'unified_exec': 'Shell', 'apply_patch': 'Patch'}.get(tool, tool)


def last_assistant_text(transcript_path):
    """Last assistant text block from a Claude Code transcript (JSONL), read from the tail."""
    try:
        with open(transcript_path, 'rb') as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 400_000))
            lines = f.read().decode('utf-8', 'ignore').splitlines()
        for line in reversed(lines):
            try:
                e = json.loads(line)
            except Exception:
                continue
            msg = e.get('message') or {}
            if e.get('type') != 'assistant' and msg.get('role') != 'assistant':
                continue
            content = msg.get('content')
            if isinstance(content, str) and content.strip():
                return content
            for part in reversed(content or []):
                if isinstance(part, dict) and part.get('type') == 'text' and part.get('text', '').strip():
                    return part['text']
    except Exception:
        pass
    return None


def git_branch(cwd):
    try:
        out = subprocess.run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], capture_output=True, text=True, timeout=1.5)
        b = out.stdout.strip()
        return b if out.returncode == 0 and b and b != 'HEAD' else None
    except Exception:
        return None


def waiting_flag(session, value=None):
    os.makedirs(STATE, exist_ok=True)
    p = os.path.join(STATE, f'{session}.waiting')
    if value is None:
        return os.path.exists(p)
    if value:
        open(p, 'w').close()
    elif os.path.exists(p):
        os.remove(p)


def main():
    tool_kind = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    raw = sys.stdin.read()
    try:
        h = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return
    cfg = load_config()
    url, token = cfg.get('WORKER_URL'), cfg.get('INGEST_TOKEN')
    if not url or not token:
        return
    event = h.get('hook_event_name') or ''
    session = h.get('session_id') or 'unknown'
    cwd = h.get('cwd') or os.getcwd()

    # PostToolUse is only interesting right after an approval prompt (it clears "waiting").
    if event == 'PostToolUse':
        if not waiting_flag(session):
            return
        waiting_flag(session, False)
    if event in ('PermissionRequest',) or (event == 'Notification' and 'permission' in str(h.get('message', '')).lower()):
        waiting_flag(session, True)
    if event in ('UserPromptSubmit', 'Stop', 'SessionEnd'):
        waiting_flag(session, False)

    tool = h.get('tool_name')
    ev = {
        'tool': tool_kind,
        'session': session,
        'event': event,
        'host': cfg.get('HOST_LABEL') or ('Mac' if sys.platform == 'darwin' else socket.gethostname().split('.')[0]),
        'cwd': cwd,
        'ts': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
    }
    if event in ('SessionStart', 'UserPromptSubmit'):
        ev['branch'] = git_branch(cwd)
        if cfg.get('SHARE_PROMPT_TITLE') == '1' and h.get('prompt'):
            ev['title'] = clip(h['prompt'], 30)
    if tool:
        ev['toolName'] = tool_label(tool)
        ev['summary'] = summarize(tool, h.get('tool_input'))
    if event == 'PermissionRequest':
        desc = (h.get('tool_input') or {}).get('description') if isinstance(h.get('tool_input'), dict) else None
        ev['message'] = clip(desc or f"请求批准 {tool_label(tool) or ''} {ev.get('summary') or ''}", 80)
    if event == 'Notification':
        ev['message'] = clip(h.get('message'), 80)
    if event == 'Stop' and cfg.get('SHARE_SUMMARY', '1') == '1':
        text = h.get('last_assistant_message') or (last_assistant_text(h['transcript_path']) if h.get('transcript_path') else None)
        if text:
            ev['finalText'] = ' '.join(text.split())[:800]

    req = urllib.request.Request(
        url.rstrip('/') + '/api/ingest/agent', data=json.dumps(ev).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}', 'User-Agent': 'InkBoard-hook/1'})
    try:
        urllib.request.urlopen(req, timeout=4, context=SSL_CTX).read()
    except Exception:
        pass


if __name__ == '__main__':
    main()
