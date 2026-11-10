import { Env, fetchJson, getSecrets, kvGet, kvSet, nowIso, uid } from '../util';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/tasks'];

interface GTok { refresh_token: string; access_token?: string; expires_at?: number; email?: string }

export async function googleAuthUrl(env: Env, origin: string) {
  const s = await getSecrets(env);
  if (!s.google_client_id) throw new Error('先在“密钥”里填 google_client_id / google_client_secret');
  const state = uid(16);
  await kvSet(env, 'google:oauth_state', state);
  const q = new URLSearchParams({
    client_id: s.google_client_id, redirect_uri: `${origin}/admin/google/callback`, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function googleCallback(env: Env, origin: string, code: string, state: string) {
  const expect = await kvGet<string>(env, 'google:oauth_state');
  if (!expect || expect.value !== state) throw new Error('state 不匹配');
  const s = await getSecrets(env);
  const r = await fetchJson<any>('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: s.google_client_id, client_secret: s.google_client_secret, redirect_uri: `${origin}/admin/google/callback`, grant_type: 'authorization_code' }),
  });
  if (!r.refresh_token) throw new Error('没有拿到 refresh_token');
  await kvSet(env, 'google:token', { refresh_token: r.refresh_token, access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 60) * 1000 } as GTok);
}

export async function googleConnected(env: Env) {
  return !!(await kvGet<GTok>(env, 'google:token'));
}

async function accessToken(env: Env): Promise<string | null> {
  const t = await kvGet<GTok>(env, 'google:token');
  if (!t) return null;
  const tok = t.value;
  if (tok.access_token && tok.expires_at && tok.expires_at > Date.now()) return tok.access_token;
  const s = await getSecrets(env);
  const r = await fetchJson<any>('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.google_client_id, client_secret: s.google_client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  tok.access_token = r.access_token;
  tok.expires_at = Date.now() + (r.expires_in - 60) * 1000;
  await kvSet(env, 'google:token', tok);
  return tok.access_token!;
}

const gget = async (env: Env, url: string) => {
  const at = await accessToken(env);
  if (!at) throw new Error('Google 未连接');
  return fetchJson<any>(url, { headers: { Authorization: `Bearer ${at}` } });
};

export interface CalEvent { title: string; start: string; end: string; allDay: boolean; location?: string; calendar?: string }

export async function googleEvents(env: Env, days: number): Promise<CalEvent[]> {
  const start = new Date(); start.setUTCHours(start.getUTCHours() - 12);
  const end = new Date(Date.now() + (days + 1) * 86400_000);
  const cals = await gget(env, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader');
  const selected = (cals.items || []).filter((c: any) => c.selected !== false && !c.hidden);
  const out: CalEvent[] = [];
  await Promise.all(selected.map(async (c: any) => {
    const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    const ev = await gget(env, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`);
    for (const e of ev.items || []) {
      if (e.status === 'cancelled') continue;
      const allDay = !!e.start?.date;
      out.push({ title: e.summary || '（无标题）', start: allDay ? e.start.date : e.start.dateTime, end: allDay ? e.end.date : e.end.dateTime, allDay, location: e.location, calendar: c.summaryOverride || c.summary });
    }
  }));
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Pull Google Tasks into the tasks table (source = 'google'). */
export async function syncGoogleTasks(env: Env) {
  if (!(await googleConnected(env))) return;
  const lists = await gget(env, 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20');
  const seen: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  for (const l of lists.items || []) {
    const q = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', completedMin: since });
    const open = await gget(env, `https://tasks.googleapis.com/tasks/v1/lists/${l.id}/tasks?showCompleted=false&maxResults=100`);
    const recentDone = await gget(env, `https://tasks.googleapis.com/tasks/v1/lists/${l.id}/tasks?${q}`);
    const all = [...(open.items || []), ...(recentDone.items || []).filter((t: any) => t.status === 'completed')];
    for (const t of all) {
      if (!t.title) continue;
      const ext = `${l.id}:${t.id}`;
      if (seen.includes(ext)) continue;
      seen.push(ext);
      stmts.push(env.DB.prepare(`INSERT INTO tasks (id, title, notes, due, done, source, ext_id, list, sort, done_at, updated_at)
        VALUES (?,?,?,?,?, 'google', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, notes=excluded.notes, due=excluded.due,
        done=excluded.done, list=excluded.list, sort=excluded.sort, done_at=excluded.done_at, updated_at=excluded.updated_at`)
        .bind('g_' + t.id, t.title, t.notes || null, t.due || null, t.status === 'completed' ? 1 : 0, ext, l.title, parseFloat(t.position || '0') / 1e15, t.completed || null, t.updated || nowIso()));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  // remove google tasks that disappeared
  const rows = (await env.DB.prepare("SELECT id, ext_id FROM tasks WHERE source = 'google'").all<any>()).results;
  const gone = rows.filter((r) => !seen.includes(r.ext_id));
  if (gone.length) await env.DB.batch(gone.map((r) => env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(r.id)));
}

export async function setGoogleTaskDone(env: Env, extId: string, done: boolean) {
  const [list, task] = extId.split(':');
  const at = await accessToken(env);
  if (!at) return;
  await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list}/tasks/${task}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(done ? { status: 'completed' } : { status: 'needsAction', completed: null }),
  });
}

export async function addGoogleTask(env: Env, title: string) {
  const at = await accessToken(env);
  if (!at) throw new Error('Google 未连接');
  await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
}
