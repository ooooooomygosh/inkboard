#!/usr/bin/env python3
"""Bridge between InkBoard (cloud) and agent-autoloop (this Mac).

Runs forever under launchd (com.inkboard.bridge), one cycle every ~10 s:
  1. jobs the user handed to AI (phone / board)  → POST /v1/events (source "inkboard")
  2. follow each job's event → run state, first-line conclusion, tasks/<id>/result.md
  3. answers the user tapped on the board/phone   → POST /v1/cards/<id>/answer | resolve (owner key)
  4. /v1/state (open cards + runs)                → pushed to InkBoard so the e-ink shows them
  5. DeepSeek Harness desktop sessions (it has no hooks): read ~/.dsh/sessions/*/session.v4.jsonl.zstd
     and report turn start / tool calls / approval prompts / turn end like the Claude Code & Codex hooks
The autoloop hub only listens on 127.0.0.1, so nothing on this Mac is exposed.
"""
import glob, json, os, ssl, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
APP = os.path.join(HOME, '.inkboard')
WORK = os.path.join(HOME, 'InkBoard', 'agent-work', 'tasks')
SSL_CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()


def load_config():
    cfg = {}
    with open(os.path.join(APP, 'config.env')) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"')
    try:
        with open(os.path.join(HOME, '.agent-autoloop', 'config.json')) as f:
            al = json.load(f)
        cfg['AUTOLOOP_OWNER_KEY'] = al.get('owner', '')
        cfg.setdefault('AUTOLOOP_URL', al.get('url', 'http://127.0.0.1:3350'))
    except FileNotFoundError:
        pass
    return cfg


def http(method, url, token, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'InkBoard-bridge/1'})
    ctx = SSL_CTX if url.startswith('https') else None
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:
            return e.code, {}


def first_line(s):
    for line in (s or '').splitlines():
        line = line.strip().lstrip('#').strip()
        if line:
            return line[:120]
    return ''


def _ts(iso):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(iso).replace('Z', '+00:00')).timestamp()
    except Exception:
        return 0


def read_result(job_id):
    p = os.path.join(WORK, job_id, 'result.md')
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()[:6000]
    except OSError:
        return None


def cycle(cfg):
    srv, ingest = cfg['WORKER_URL'].rstrip('/'), cfg['INGEST_TOKEN']
    hub, src_key, owner = cfg.get('AUTOLOOP_URL', 'http://127.0.0.1:3350').rstrip('/'), cfg.get('AUTOLOOP_SOURCE_KEY'), cfg.get('AUTOLOOP_OWNER_KEY')
    if not (src_key and owner):
        return
    code, work = http('GET', f'{srv}/api/ingest/bridge', ingest)
    if code != 200:
        print('bridge pull', code, file=sys.stderr)
        return
    updates, done_ans, failed_ans = [], [], []

    # 1. new jobs → autoloop events
    for j in work.get('queued', []):
        code, r = http('POST', f'{hub}/v1/events', src_key, {
            'id': j['id'], 'type': 'inkboard.task', 'subject': f"task:{j['id']}",
            'summary': j['title'][:200], 'detail': (j.get('detail') or '')[:4000],
        })
        if code == 200 and r.get('event'):
            updates.append({'id': j['id'], 'status': 'sent' if r.get('routed') else 'failed', 'event_id': r['event'],
                            'summary': None if r.get('routed') else '没有规则接这个任务（检查 ~/.agent-autoloop/rules.json）'})
        else:
            print('emit failed', code, r, file=sys.stderr)

    # 4 (read first so 2 can see open cards). owner state
    state_code, state = http('GET', f'{hub}/v1/state', owner)
    cards, runs = [], []
    if state_code == 200:
        recent_notices = [dict(c, fyi=True) for c in state.get('recentCards', [])
                          if c.get('kind') == 'notice' and c.get('state') == 'closed' and not c.get('decidedAt')
                          and time.time() - _ts(c.get('createdAt')) < 24 * 3600]
        for c in state.get('cards', []) + recent_notices:
            cards.append({'id': c.get('id'), 'kind': c.get('kind'), 'state': c.get('state'), 'title': c.get('title'), 'text': c.get('text'),
                          'options': c.get('options') or [], 'recommend': c.get('recommend'), 'created': c.get('createdAt') or c.get('created_at'),
                          'rule': c.get('rule') or c.get('title'), 'lane': c.get('lane'), 'fyi': bool(c.get('fyi'))})
        for r in state.get('runs', []):
            runs.append({'id': r.get('id'), 'rule': r.get('rule'), 'state': r.get('state'), 'lane': r.get('lane'), 'summary': r.get('summary'),
                         'started': r.get('startedAt') or r.get('claimedAt') or r.get('createdAt')})
    open_lanes = {c.get('lane') for c in cards if c.get('state') == 'open'}

    # 2. follow sent jobs
    for j in work.get('watch', []):
        code, ev = http('GET', f"{hub}/v1/events/{j['event_id']}", src_key)
        if code != 200:
            continue
        rs = ev.get('runs') or []
        last = rs[-1] if rs else None
        lane = f"task:{j['id']}"
        if lane in open_lanes:
            updates.append({'id': j['id'], 'status': 'asking', 'run_id': last and last.get('run')})
        elif not last or last.get('state') == 'queued':
            pass
        elif last.get('state') in ('claimed', 'unknown'):
            if j['status'] != 'running':
                updates.append({'id': j['id'], 'status': 'running', 'run_id': last.get('run')})
        elif last.get('state') in ('done', 'nothing'):
            updates.append({'id': j['id'], 'status': 'done', 'run_id': last.get('run'), 'summary': first_line(last.get('summary')) or '已完成', 'result': read_result(j['id'])})
        elif last.get('state') == 'cancelled':
            updates.append({'id': j['id'], 'status': 'failed', 'run_id': last.get('run'), 'summary': first_line(last.get('summary')) or last.get('error') or '没跑成'})

    # 3. answers from the board / phone
    for a in work.get('answers', []):
        cid = a['card_id']
        if a.get('choice') == -1:
            code, _ = http('POST', f'{hub}/v1/cards/{cid}/resolve', owner, {'reason': '在 InkBoard 上处理了'})
        elif a.get('text'):
            code, _ = http('POST', f'{hub}/v1/cards/{cid}/answer', owner, {'text': a['text']})
        else:
            code, _ = http('POST', f'{hub}/v1/cards/{cid}/answer', owner, {'choice': a.get('choice', 0)})
        (done_ans if code in (200, 409) else failed_ans).append(a['id'])

    http('POST', f'{srv}/api/ingest/bridge', ingest, {
        'autoloop': {'cards': cards, 'runs': runs} if state_code == 200 else None,
        'jobs': updates, 'answersDone': done_ans, 'answersFailed': failed_ans,
    })


# ---------------------------------------------------------------- DeepSeek Harness sessions
DSH_SESSIONS = os.path.join(HOME, '.dsh', 'sessions')
DSH_STATE = os.path.join(APP, 'state', 'dsh.json')
ZSTD = next((p for p in ('/opt/homebrew/bin/zstd', '/usr/local/bin/zstd') if os.path.exists(p)), 'zstd')
SKIP_CWD = (os.path.join(HOME, 'InkBoard', 'agent-work'),)  # autoloop jobs: already shown as "交给 AI"


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _dsh_summary(name, args):
    try:
        a = json.loads(args) if isinstance(args, str) else (args or {})
    except Exception:
        a = {}
    for k in ('command', 'file_path', 'path', 'pattern', 'query', 'url', 'name'):
        v = a.get(k) if isinstance(a, dict) else None
        if isinstance(v, str) and v:
            return ' '.join(v.split())[:50]
    return ''


def dsh_watch(cfg):
    if not os.path.isdir(DSH_SESSIONS):
        return
    try:
        seen = json.load(open(DSH_STATE))
    except Exception:
        seen = None  # first run: mark history as read, don't replay it
    first, seen = seen is None, seen or {}
    host = cfg.get('HOST_LABEL') or 'Mac'
    out = []
    for f in glob.glob(os.path.join(DSH_SESSIONS, '*', 'session-*', 'session.v4.jsonl.zstd')):
        mt = os.path.getmtime(f)
        if time.time() - mt > 6 * 3600:
            seen.pop(f, None)
            continue
        prev = seen.get(f) or {}
        if prev.get('mtime') == mt:
            continue
        try:
            raw = subprocess.run([ZSTD, '-dcq', f], capture_output=True, timeout=20).stdout.decode('utf-8', 'ignore')
        except Exception:
            continue
        sid, cwd, last_seq, last_text, events = None, None, prev.get('seq', -1), None, []
        for line in raw.splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = e.get('type')
            if t == 'session':
                sid, cwd = e.get('id'), e.get('cwd')
                continue
            seq = e.get('seq', -1)
            if t == 'assistant/message':
                for part in (e.get('data', {}).get('message', {}).get('content') or []):
                    if isinstance(part, dict) and part.get('type') == 'text' and part.get('text', '').strip():
                        last_text = part['text']
            if seq > last_seq:
                events.append(e)
                last_seq = seq
        seen[f] = {'mtime': mt, 'seq': last_seq}
        if first or not sid or (cwd or '').startswith(SKIP_CWD):
            continue
        for e in events:
            t, d = e.get('type'), e.get('data') or {}
            ev = {'tool': 'dsh', 'session': sid, 'host': host, 'cwd': cwd, 'ts': _iso(e.get('time') or time.time() * 1000)}
            if t == 'turn/start':
                ev['event'] = 'UserPromptSubmit'
            elif t == 'tool/call':
                ev.update(event='PreToolUse', toolName={'bash': 'Shell', 'read': 'Read', 'write': 'Write', 'edit': 'Edit'}.get(d.get('name'), d.get('name')),
                          summary=_dsh_summary(d.get('name'), d.get('arguments')))
            elif t == 'approval/asked':
                ev.update(event='PermissionRequest', message='DSH 请求批准一个操作')
            elif t == 'approval/decided':
                ev['event'] = 'PostToolUse'
            elif t == 'session/title' and cfg.get('SHARE_PROMPT_TITLE') == '1':
                ev.update(event='Notification', title=d.get('title'))
            elif t == 'turn/end':
                ev['event'] = 'Stop'
                if (d.get('reason') or {}).get('kind') not in (None, 'completed'):
                    ev['message'] = f"没跑完：{(d.get('reason') or {}).get('kind')}"
                elif last_text and cfg.get('SHARE_SUMMARY', '1') == '1':
                    ev['finalText'] = ' '.join(last_text.split())[:800]
            else:
                continue
            out.append(ev)
    if out:
        code, _ = http('POST', cfg['WORKER_URL'].rstrip('/') + '/api/ingest/agent', cfg['INGEST_TOKEN'], out[-60:])
        if code != 200:
            return  # keep the old state so these are sent again next cycle
    os.makedirs(os.path.dirname(DSH_STATE), exist_ok=True)
    json.dump(seen, open(DSH_STATE, 'w'))


# ---------------------------------------------------------------- Claude desktop app titles
APP_SESSIONS = os.path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
TITLE_STATE = os.path.join(APP, 'state', 'titles.json')


def _ssh_label(cfg, ssh):
    """Name for a session that runs over SSH: SSH_HOST_LABEL from config.env, else the host's first label."""
    if not ssh:
        return None
    if cfg.get('SSH_HOST_LABEL'):
        return cfg['SSH_HOST_LABEL']
    host = str((ssh or {}).get('sshHost') or '').split('@')[-1]
    return host.split('.')[0] or '远程'


def app_titles(cfg):
    """Hooks only know a session id and folder. The desktop app keeps each session's title (local and SSH
    sessions alike); send it so the board says "墨水屏看板方案" instead of "Downloads"."""
    try:
        sent = json.load(open(TITLE_STATE))
    except Exception:
        sent = {}
    out, asks = [], []
    for f in glob.glob(os.path.join(APP_SESSIONS, '*', '*', 'local_*.json')):
        if time.time() - os.path.getmtime(f) > 3 * 86400:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        title = (d.get('title') or '').strip()
        if not title or d.get('isArchived'):
            continue
        # the last turn ended with a question for the person (the app's "next step" box)
        ask = ((d.get('turnWrapUp') or {}).get('needsUser') or '').strip()
        if ask:
            asks.append({'id': d.get('sessionId'), 'title': title, 'ask': ask, 'at': _iso(d.get('lastTurnEdgeAt') or d.get('lastActivityAt') or time.time() * 1000),
                         'host': _ssh_label(cfg, d.get('sshConfig'))})
        if time.time() - os.path.getmtime(f) > 24 * 3600:
            continue
        for sid in {d.get('cliSessionId'), d.get('lastAssistantCliSessionId')} - {None}:
            if sent.get(sid) != title:
                out.append({'tool': 'claude', 'session': sid, 'event': 'Meta', 'title': title})
                sent[sid] = title
    http('POST', cfg['WORKER_URL'].rstrip('/') + '/api/ingest/app-asks', cfg['INGEST_TOKEN'], {'asks': asks})
    if out:
        code, _ = http('POST', cfg['WORKER_URL'].rstrip('/') + '/api/ingest/agent', cfg['INGEST_TOKEN'], out[:80])
        if code != 200:
            return
    os.makedirs(os.path.dirname(TITLE_STATE), exist_ok=True)
    json.dump(sent, open(TITLE_STATE, 'w'), ensure_ascii=False)


def main():
    once = '--once' in sys.argv
    while True:
        cfg = None
        try:
            cfg = load_config()
            cycle(cfg)
        except Exception as e:  # keep running; launchd also restarts us
            print('cycle error:', e, file=sys.stderr)
        try:
            if cfg and cfg.get('DSH_WATCH', '1') == '1':
                dsh_watch(cfg)
        except Exception as e:
            print('dsh watch error:', e, file=sys.stderr)
        try:
            if cfg and cfg.get('APP_TITLES', '1') == '1' and int(time.time()) % 30 < 10:  # about every 30 s
                app_titles(cfg)
        except Exception as e:
            print('app titles error:', e, file=sys.stderr)
        if once:
            break
        time.sleep(10)


if __name__ == '__main__':
    main()
