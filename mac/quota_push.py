#!/usr/bin/env python3
"""Read subscription quotas via the CodexBar CLI and push them to InkBoard.

Runs every few minutes from launchd (com.inkboard.quota). Providers that are not
signed in on this Mac are skipped quietly.
"""
import json, os, re, ssl, subprocess, sys, urllib.request
from datetime import datetime, timezone

# python.org builds ship without CA certs; use the macOS bundle.
SSL_CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()
APP = os.path.join(os.path.expanduser('~'), '.inkboard')

LABELS = {'claude': 'Claude', 'codex': 'Codex', 'cursor': 'Cursor', 'copilot': 'Copilot', 'gemini': 'Gemini',
          'openrouter': 'OpenRouter', 'zai': 'z.ai', 'factory': 'Droid', 'kimi': 'Kimi', 'deepseek': 'DeepSeek', 'windsurf': 'Windsurf',
          'grok': 'Grok', 'antigravity': 'Antigravity', 'perplexity': 'Perplexity', 'moonshot': 'Kimi', 'doubao': '豆包', 'mistral': 'Mistral'}
PLAN_FIX = {'prolite': 'Pro', 'pro': 'Pro', 'plus': 'Plus', 'team': 'Team'}


def load_config():
    cfg = {}
    with open(os.path.join(APP, 'config.env')) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"')
    return cfg


LABEL_MAP = {'session': '5h', 'weekly': '周', 'week': '周', 'monthly': '月', 'month': '月', 'daily': '日', 'day': '日'}


def window_label(minutes, name=None):
    if name and name.lower() in LABEL_MAP:
        return LABEL_MAP[name.lower()]
    if not minutes:
        return name or '额度'
    if minutes <= 360:
        return f'{round(minutes / 60)}h'
    if minutes <= 1440:
        return '日'
    if minutes <= 10080:
        return '周'
    return '月'


def cn_tokens(n):
    return f'{n / 1e8:.2f} 亿' if n >= 1e8 else f'{n / 1e4:.0f} 万' if n >= 1e4 else str(n)


def convert(p):
    prov = p.get('provider')
    u = p.get('usage') or {}
    if p.get('error') and not u:
        return None, None
    labels = p.get('rateWindowLabels') or {}
    plan = u.get('loginMethod') or (u.get('identity') or {}).get('loginMethod') or ''
    dash = p.get('openaiDashboard') or {}
    if prov == 'codex' and dash.get('accountPlan'):
        plan = dash['accountPlan']
    plan = PLAN_FIX.get(plan.lower(), plan) if plan else ''
    plan = plan.replace('Claude ', '').replace('Cursor ', '')
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    q = {'provider': prov, 'label': LABELS.get(prov, prov.capitalize()), 'plan': plan, 'windows': [], 'credits': None,
         'capturedAt': u.get('updatedAt') or now}
    usage = None
    seen = set()
    for key in ('primary', 'secondary', 'tertiary'):
        w = u.get(key)
        if not w:
            continue
        name = labels.get(key)
        if (name or '').lower() == 'balance':
            m = re.match(r'\s*([¥$€][\d,.]+)', w.get('resetDescription') or '')
            q['balance'] = m.group(1) if m else (w.get('resetDescription') or '').split(' ')[0]
            continue
        sig = (w.get('windowMinutes'), w.get('usedPercent'), w.get('resetsAt'))
        if sig in seen:
            continue
        seen.add(sig)
        win = {'name': key, 'label': window_label(w.get('windowMinutes'), name), 'usedPct': w.get('usedPercent'), 'resetsAt': w.get('resetsAt')}
        pace = ((p.get('pace') or {}).get(key)) or None
        if pace:
            win['pace'] = {'willLast': pace.get('willLastToReset'), 'etaSec': pace.get('etaSeconds'), 'expectedPct': pace.get('expectedUsedPercent')}
        q['windows'].append(win)
    # balance-style providers (DeepSeek …): today's spend/tokens and a daily token chart
    for d in (u.get('details') or []):
        rows = {r.get('label'): r.get('value') for r in d.get('rows') or []}
        if rows.get('Today'):
            q['today'] = rows['Today']
            m = re.match(r'\s*[¥$]([\d.]+)\s*·\s*([\d,]+)\s*tokens', rows['Today'])
            if m:
                q['today'] = f"¥{float(m.group(1)):.2f} · {cn_tokens(int(m.group(2).replace(',', ''))).replace(' ', '')}"
        chart = d.get('chart') or {}
        if chart.get('unit') == 'tokens' and chart.get('points'):
            daily = [{'date': pt['label'], 'tokens': int(pt.get('value') or 0), 'cost': 0} for pt in chart['points']][-14:]
            today = datetime.now().strftime('%Y-%m-%d')
            t = next((x for x in daily if x['date'] == today), None)
            if t and rows.get('Today'):
                mm = re.match(r'\s*[¥$]([\d.]+)', rows['Today'])
                if mm:
                    t['cost'] = float(mm.group(1))
            usage = {'provider': prov, 'label': q['label'], 'today': t, 'daily': daily, 'last30Tokens': sum(x['tokens'] for x in daily),
                     'last30Cost': 0, 'currency': '¥' if '¥' in (rows.get('Today') or '') else '$', 'capturedAt': now}
    rc = (u.get('codexResetCredits') or {}).get('availableCount') or (p.get('resetCredits') or {}).get('available')
    if rc:
        q['credits'] = f'可免费重置 {rc} 次'
    if not q['windows'] and not q.get('balance') and not q['credits']:
        return None, usage
    return q, usage


def post(cfg, path, body):
    req = urllib.request.Request(cfg['WORKER_URL'].rstrip('/') + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {cfg['INGEST_TOKEN']}", 'User-Agent': 'InkBoard-quota/1'})
    return urllib.request.urlopen(req, timeout=15, context=SSL_CTX).read().decode()


def push_usage(cfg):
    """Local token usage from Claude Code / Codex logs (via `codexbar cost`)."""
    cli = cfg.get('CODEXBAR_CLI')
    today = datetime.now().strftime('%Y-%m-%d')
    out = []
    for prov in [x for x in cfg.get('COST_PROVIDERS', 'claude codex').split() if x]:
        try:
            r = subprocess.run([cli, 'cost', '--provider', prov, '--format', 'json', '--days', '14'], capture_output=True, text=True, timeout=120)
            data = json.loads(r.stdout or '[]')
        except Exception as e:
            print(f'cost {prov}: {e}', file=sys.stderr)
            continue
        for p in data:
            daily = [{'date': d.get('date'), 'tokens': int(d.get('totalTokens') or 0), 'cost': round(float(d.get('totalCost') or 0), 2)} for d in (p.get('daily') or [])]
            daily.sort(key=lambda d: d['date'])
            t = next((d for d in daily if d['date'] == today), None)
            out.append({'provider': prov, 'label': LABELS.get(prov, prov), 'today': t, 'daily': daily[-14:],
                        'last30Tokens': int(p.get('last30DaysTokens') or 0), 'last30Cost': round(float(p.get('last30DaysCostUSD') or 0), 2),
                        'capturedAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')})
    if out:
        print(post(cfg, '/api/ingest/usage', {'providers': out}))


def main():
    cfg = load_config()
    try:
        push_usage(cfg)
    except Exception as e:
        print(f'usage: {e}', file=sys.stderr)
    cli = cfg.get('CODEXBAR_CLI')
    providers = [x for x in cfg.get('PROVIDERS', 'auto').split() if x]
    calls = [[]] if providers in (['auto'], ['all']) else [['--provider', x] for x in providers]
    out, extra_usage = [], []
    for args in calls:
        try:
            r = subprocess.run([cli, 'usage', *args, '--json-only', '--no-color'], capture_output=True, text=True, timeout=180)
            data = json.loads(r.stdout or '[]')
        except Exception as e:
            print(f'usage {args}: {e}', file=sys.stderr)
            continue
        for p in data:
            q, u = convert(p)
            if q:
                out.append(q)
            if u:
                extra_usage.append(u)
    if out:
        print(post(cfg, '/api/ingest/quota', {'providers': out}))
    if extra_usage:
        print(post(cfg, '/api/ingest/usage', {'providers': extra_usage}))


if __name__ == '__main__':
    main()
