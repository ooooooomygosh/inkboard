#!/usr/bin/env python3
"""Run InkBoard Helper jobs on their own cadence and upload the results.

launchd (com.inkboard.helper) runs this every 10 minutes. Each job remembers when it last ran:
  events   – macOS Calendar (CALENDAR_SYNC=1; a published ICS link in the editor is usually simpler)  every 10 min
  mail     – Apple Mail, mail to/from MAIL_DOMAIN (e.g. your school), last 3 days (MAIL_SYNC=1)
  notes    – recently edited research notes in ~/Downloads         every 6 h, only if changed
  location – precise location for weather (LOCATION_SYNC=1)      every 6 h
"""
import hashlib, json, os, ssl, subprocess, sys, time, urllib.request

APP_DIR = os.path.join(os.path.expanduser('~'), '.inkboard')
STATE = os.path.join(APP_DIR, 'state')
HELPER = os.path.join(APP_DIR, 'InkBoard Helper.app')
SSL_CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()
CADENCE = {'events': 600, 'mail': 600, 'notes': 6 * 3600, 'location': 6 * 3600}


def load_config():
    cfg = {}
    with open(os.path.join(APP_DIR, 'config.env')) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"')
    return cfg


def post(cfg, path, body):
    req = urllib.request.Request(cfg['WORKER_URL'].rstrip('/') + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Authorization': f"Bearer {cfg['INGEST_TOKEN']}", 'User-Agent': 'InkBoard-helper/1'})
    return urllib.request.urlopen(req, timeout=30, context=SSL_CTX).read().decode()


def already_running(cmd):
    r = subprocess.run(['pgrep', '-f', f'InkBoardHelper {cmd} '], capture_output=True, text=True)
    return bool(r.stdout.strip())


def run_helper(cmd, extra='', timeout=100):
    if already_running(cmd):
        return {'error': f'{cmd}: previous run still waiting (permission prompt not answered yet?)'}
    out = os.path.join(STATE, f'{cmd}.json')
    try:
        os.remove(out)
    except FileNotFoundError:
        pass
    args = ['open', '-g', '-j', '-n', '-a', HELPER, '--args', cmd, out] + ([extra] if extra else [])
    subprocess.run(args, check=False, timeout=20)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(out):
            with open(out) as f:
                return json.load(f)
        time.sleep(1)
    return {'error': 'timeout (waiting for a permission prompt?)'}


def due(job, force):
    stamp = os.path.join(STATE, f'{job}.last')
    if force:
        return True
    try:
        return time.time() - os.path.getmtime(stamp) >= CADENCE[job] - 30
    except FileNotFoundError:
        return True


def mark(job):
    with open(os.path.join(STATE, f'{job}.last'), 'w') as f:
        f.write(str(int(time.time())))


def main():
    os.makedirs(STATE, exist_ok=True)
    cfg = load_config()
    if cfg.get('HELPER_ENABLED', '1') != '1' or not os.path.exists(HELPER):
        return
    only = sys.argv[1:]
    force = bool(only)
    jobs = only or ['events', 'mail', 'notes', 'location']

    if 'events' in jobs and cfg.get('CALENDAR_SYNC', '1') == '1' and due('events', force):
        r = run_helper('events', '8')
        if 'events' in r:
            print('calendar', post(cfg, '/api/ingest/calendar', {'events': r['events'], 'calendars': r.get('calendars', [])}))
            mark('events')
        else:
            print('events:', r.get('error'), file=sys.stderr)

    if 'mail' in jobs and cfg.get('MAIL_SYNC') == '1' and due('mail', force):
        r = run_helper('mail', cfg.get('MAIL_DAYS', '3'), timeout=150)
        if 'mails' in r:
            off = time.strftime('%z')  # AppleScript dates are local wall time without an offset
            for m in r['mails']:
                if m.get('received') and not m['received'].endswith('Z') and '+' not in m['received'][10:]:
                    m['received'] += f'{off[:3]}:{off[3:]}'
            print('mail', post(cfg, '/api/ingest/mail', {'mails': r['mails']}))
            mark('mail')
        else:
            print('mail:', r.get('error'), file=sys.stderr)

    if 'notes' in jobs and due('notes', force):
        r = run_helper('notes', cfg.get('NOTES_DIRS', ''))
        if 'notes' in r:
            h = hashlib.sha1(json.dumps([(n['path'], n['mtime']) for n in r['notes']]).encode()).hexdigest()[:12]
            last = os.path.join(STATE, 'notes.hash')
            prev = open(last).read() if os.path.exists(last) else ''
            if h != prev or force:
                print('notes', post(cfg, '/api/ingest/context', {'notes': r['notes'], 'hash': h}))
                open(last, 'w').write(h)
            mark('notes')
        else:
            print('notes:', r.get('error'), file=sys.stderr)

    if 'location' in jobs and cfg.get('LOCATION_SYNC', '1') == '1' and due('location', force):
        r = run_helper('location', timeout=70)
        if 'lat' in r:
            print('location', post(cfg, '/api/ingest/location', r))
            mark('location')
        else:
            print('location:', r.get('error'), file=sys.stderr)


if __name__ == '__main__':
    main()
