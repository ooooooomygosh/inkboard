import { Hono, type Context } from 'hono';
import { searchSymbols } from './sources/markets';
import { getCookie, setCookie } from 'hono/cookie';
import type { DeviceStatus, Layout, QuotaProvider } from '../shared/types';
import { defaultLayout } from '../shared/defaults';
import { agentTimeline, ingestAgentEvent, pruneAgentEvents, type AgentEvent } from './agents';
import { aiCron, deepseek, generateBrief, generatePapers, getPlan, localNow, parseTasks, summarizeAgent, triageMail, updateObservation, updatePlan, updateResearchFocus } from './ai';
import { addFactManual, deleteFact, editFact, getObservation, listFacts, setFactPinned } from './memory';
import { actionItems, doingItems, type AutoloopState } from './actions';
import { BALANCE_SECRETS } from './sources/balances';
import { addGoogleTask, googleAuthUrl, googleCallback, googleConnected, setGoogleTaskDone } from './sources/google';
import { cleanMail } from './mailclean';
import { mentionsMoney, moneySummary, peopleOf, recordMoney, settle, type Who } from './money';
import { listNotes, REPLIES, replyNote, sendNote, syncNoteFromTask } from './notes';
import { buildState, getLayout, mergeCalendars, pushCommand, refreshLiveMarkets, refreshSources, saveLayout } from './state';
import { Env, getSecrets, kvGet, kvSet, nowIso, timingSafeEqual, uid } from './util';

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

// ---------------- auth ----------------
const isHttps = (c: C) => new URL(c.req.url).protocol === 'https:';
const cookieOpts = (c: C) => ({ httpOnly: true, sameSite: 'Lax' as const, path: '/', maxAge: 400 * 86400, secure: isHttps(c) });

function isDevice(c: C) {
  const t = c.req.header('X-Device-Token') || getCookie(c, 'ib_dev') || '';
  return timingSafeEqual(t, c.env.DEVICE_TOKEN);
}
function isAdmin(c: C) {
  return timingSafeEqual(getCookie(c, 'ib_admin') || '', c.env.ADMIN_TOKEN);
}
function isIngest(c: C) {
  const t = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  return timingSafeEqual(t, c.env.INGEST_TOKEN);
}

app.use('/api/admin/*', async (c, next) => (isAdmin(c) ? next() : c.json({ error: 'unauthorized' }, 401)));
app.use('/api/ingest/*', async (c, next) => (isIngest(c) ? next() : c.json({ error: 'unauthorized' }, 401)));
app.use('/api/device/*', async (c, next) => (isDevice(c) || isAdmin(c) ? next() : c.json({ error: 'unauthorized' }, 401)));

// ---------------- pages ----------------
const shell = (title: string, entry: 'device' | 'admin' | 'capture' | 'money', boot: unknown) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title}</title><link rel="stylesheet" href="/assets/${entry}.css">${entry === 'money' ? '<link rel="manifest" href="/manifest-money.webmanifest"><meta name="theme-color" content="#111111"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="记账"><link rel="apple-touch-icon" sizes="180x180" href="/money-icon-180.png"><link rel="icon" type="image/png" href="/money-icon-192.png">' : ''}${entry === 'capture' ? '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#111111"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><link rel="apple-touch-icon" href="/icon-192.png">' : ''}
</head><body><div id="app"></div>
<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script src="/assets/${entry}.js"></script></body></html>`;

app.get('/', (c) => c.redirect('/admin'));

app.get('/d', async (c) => {
  const headerOk = timingSafeEqual(c.req.header('X-Device-Token') || '', c.env.DEVICE_TOKEN);
  if (headerOk) setCookie(c, 'ib_dev', c.env.DEVICE_TOKEN, cookieOpts(c));
  if (!headerOk && !isDevice(c) && !isAdmin(c)) return c.html('<h1 style="font:40px sans-serif;padding:40px">InkBoard：设备 token 不正确</h1>', 401);
  const state = await buildState(c.env);
  return c.html(shell('InkBoard', 'device', { state, preview: c.req.query('preview') === '1' }), 200, { 'Cache-Control': 'no-store' });
});

const safeNext = (n: string | undefined) => (n && /^\/[a-z0-9/_-]*$/i.test(n) ? n : '/admin');
app.get('/login', (c) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>InkBoard 登录</title><style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f2}
form{background:#fff;padding:32px;border-radius:14px;box-shadow:0 2px 20px #0001;display:grid;gap:12px;width:320px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #ccc}button{background:#111;color:#fff;border:0;cursor:pointer}</style>
<form method="post"><input type="hidden" name="next" value="${safeNext(c.req.query('next'))}"><b style="font-size:20px">InkBoard</b><input name="token" type="password" placeholder="管理口令（ADMIN_TOKEN）" autofocus><button>进入</button></form>`));

app.post('/login', async (c) => {
  const form = await c.req.parseBody();
  if (!timingSafeEqual(String(form.token || ''), c.env.ADMIN_TOKEN)) return c.redirect('/login');
  setCookie(c, 'ib_admin', c.env.ADMIN_TOKEN, cookieOpts(c));
  return c.redirect(safeNext(String(form.next || '')));
});

// ---------------- 记账（两个人一本账）----------------
// The owner signs in with the admin password; the partner gets an own link (/m?k=…) that only opens the ledger.
// Names come from the editor's "关于你" (layout.profile.me / partner).
async function moneyWho(c: C): Promise<Who | null> {
  if (isAdmin(c)) return 'me';
  const k = (await getSecrets(c.env)).money_partner;
  return k && timingSafeEqual(getCookie(c, 'ib_money') || '', k) ? 'partner' : null;
}
app.get('/m', async (c) => {
  const k = c.req.query('k');
  if (k) {
    const real = (await getSecrets(c.env)).money_partner;
    if (real && timingSafeEqual(k, real)) { setCookie(c, 'ib_money', real, cookieOpts(c)); return c.redirect('/m'); }
  }
  const who = await moneyWho(c);
  if (!who) return c.redirect('/login?next=/m');
  return c.html(shell('记账', 'money', { who, people: peopleOf(await getLayout(c.env)) }), 200, { 'Cache-Control': 'no-store' });
});
app.use('/api/money/*', async (c, next) => ((await moneyWho(c)) ? next() : c.json({ error: 'unauthorized' }, 401)));
const moneyState = async (c: C, extra: Record<string, unknown> = {}) => ({ who: await moneyWho(c), ...(await moneySummary(c.env, await getLayout(c.env))), notes: await listNotes(c.env), ...extra });
app.post('/api/money/notes', async (c) => {
  const { text } = await c.req.json();
  if (!text || !String(text).trim()) return c.json({ error: 'empty' }, 400);
  const who = (await moneyWho(c))!;
  await sendNote(c.env, await getLayout(c.env), String(text).slice(0, 300), who);
  return c.json(await moneyState(c));
});
app.get('/api/money', async (c) => c.json(await moneyState(c)));
app.post('/api/money/say', async (c) => {
  const { text, who } = await c.req.json();
  if (!text || !String(text).trim()) return c.json({ error: 'empty' }, 400);
  const speaker: Who = who === 'partner' || who === 'me' ? who : (await moneyWho(c))!;
  try {
    const r = await recordMoney(c.env, await getLayout(c.env), String(text).slice(0, 2000), speaker);
    return c.json(await moneyState(c, { leftover: r.changed ? r.rest : String(text), changed: r.changed }));
  } catch (e: any) { return c.json(await moneyState(c, { error: 'AI 没记上：' + (e.message || e) })); }
});
app.post('/api/money/expenses/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(c.req.param('id')).run();
  return c.json(await moneyState(c));
});
app.post('/api/money/recurring/:id/stop', async (c) => {
  await c.env.DB.prepare('UPDATE recurring SET active = 0, updated_at = ? WHERE id = ?').bind(nowIso(), c.req.param('id')).run();
  return c.json(await moneyState(c));
});
app.post('/api/money/settle', async (c) => {
  const { payer, amount } = await c.req.json();
  await settle(c.env, await getLayout(c.env), payer === 'partner' ? 'partner' : 'me', Number(amount));
  return c.json(await moneyState(c));
});
/** The partner's ledger link (created once). Only for the owner. */
app.get('/api/admin/money/invite', async (c) => {
  const s = await getSecrets(c.env);
  if (!s.money_partner) { s.money_partner = uid(12) + uid(12); await kvSet(c.env, 'secrets', s); }
  return c.json({ url: `${new URL(c.req.url).origin}/m?k=${s.money_partner}` });
});

// ---------------- quick capture (phone) ----------------
app.get('/c', (c) => {
  if (!isAdmin(c)) return c.redirect('/login?next=/c');
  return c.html(shell('今天', 'capture', {}), 200, { 'Cache-Control': 'no-store' });
});
app.use('/api/me/*', async (c, next) => (isAdmin(c) ? next() : c.json({ error: 'unauthorized' }, 401)));

async function today(c: C) {
  const layout = await getLayout(c.env);
  const now = localNow(layout.device.timezone);
  const [plan, tasks, caps, mails, brief, research, usage] = await Promise.all([
    getPlan(c.env, now.day),
    c.env.DB.prepare("SELECT id, title, due, done, priority, est_min, day, source, ai_ok, ai_how FROM tasks WHERE done = 0 OR done_at > ? ORDER BY done, priority, sort LIMIT 60").bind(new Date(Date.now() - 18 * 3600_000).toISOString()).all<any>().then((r) => r.results),
    c.env.DB.prepare('SELECT id, text, ts FROM captures WHERE day = ? ORDER BY ts DESC').bind(now.day).all<any>().then((r) => r.results),
    c.env.DB.prepare('SELECT id, sender, subject, received, summary, action FROM mails WHERE important = 1 AND done = 0 ORDER BY received DESC LIMIT 10').all<any>().then((r) => r.results),
    kvGet<any>(c.env, 'ai:brief'),
    kvGet<any>(c.env, 'ai:research'),
    kvGet<any>(c.env, 'ai:usage'),
  ]);
  const events = ((await kvGet<any[]>(c.env, 'outlook:events'))?.value || []).filter((e) => Date.parse(e.end) > Date.now() && Date.parse(e.start) < Date.now() + 86400_000);
  const [actions, doing, jobs] = await Promise.all([
    actionItems(c.env, layout), doingItems(c.env, layout),
    c.env.DB.prepare('SELECT id, task_id, title, status, summary, result, updated_at FROM jobs ORDER BY created_at DESC LIMIT 15').all<any>().then((r) => r.results),
  ]);
  return { day: now.day, now: now.text, plan, tasks, captures: caps, mails, events, brief: brief?.value || null, research: research?.value || null, aiUsage: usage?.value || null, actions, doing, jobs };
}
app.get('/api/me/today', async (c) => c.json(await today(c)));
app.post('/api/me/capture', async (c) => {
  const { text } = await c.req.json();
  if (!text || !String(text).trim()) return c.json({ error: 'empty' }, 400);
  const layout = await getLayout(c.env);
  const day = localNow(layout.device.timezone).day;
  await c.env.DB.prepare("INSERT INTO captures (id, text, source, day, processed, ts) VALUES (?, ?, 'phone', ?, 0, ?)").bind('c_' + uid(), String(text).slice(0, 8000), day, nowIso()).run();
  let rest = String(text);
  // money first (cheap): "午饭 18" never reaches the day planner
  if (mentionsMoney(rest)) { try { const r = await recordMoney(c.env, layout, rest, 'me'); if (r.changed) rest = r.rest; } catch { /* fall through to the planner */ } }
  if (rest.trim()) { try { await updatePlan(c.env, layout, rest); } catch (e: any) { return c.json({ ...(await today(c)), error: 'AI 整理失败：' + (e.message || e) }); } }
  c.executionCtx.waitUntil(refreshBriefIfStale(c.env, layout));
  return c.json(await today(c));
});
/** After the plan changes, refresh the brief so the board never contradicts the plan (at most every 10 min). */
async function refreshBriefIfStale(env: Env, layout: any) {
  const b = await kvGet<any>(env, 'ai:brief');
  if (b && Date.now() - Date.parse(b.value.generatedAt) < 10 * 60_000) return;
  await generateBrief(env, layout).catch(() => {});
}

/** Answer anything in the action center. choice = option index; text = free text (questions only). */
async function resolveAction(c: C, id: string, choice: number | undefined, text?: string) {
  const [kind, ...rest] = id.split(':');
  const ref = rest.join(':');
  const layout = await getLayout(c.env);
  if (kind === 'q') {
    const plan = await getPlan(c.env, localNow(layout.device.timezone).day);
    const q = plan?.questions.find((x) => x.id === ref);
    const ans = text || (q && choice !== undefined ? q.options[choice] : '');
    if (q && ans) await answerQuestion(c, ref, ans);
  } else if (kind === 'card') {
    const cardId = +ref;
    const auto = await kvGet<AutoloopState>(c.env, 'autoloop:state');
    const card = auto?.value?.cards.find((x) => x.id === cardId);
    if (card?.fyi && card.state !== 'open') {  // closed notice: only hide it on the board
      const d = (await kvGet<number[]>(c.env, 'autoloop:dismissed'))?.value || [];
      await kvSet(c.env, 'autoloop:dismissed', [...d, cardId].slice(-200));
      return;
    }
    const resolveOnly = !card?.options?.length;
    await c.env.DB.prepare('INSERT INTO card_answers (card_id, choice, text, status, ts) VALUES (?,?,?,?,?)').bind(cardId, resolveOnly ? -1 : choice ?? null, text || null, 'pending', nowIso()).run();
    if (auto?.value) { // optimistic: hide it until the bridge confirms
      auto.value.cards = auto.value.cards.map((x) => (x.id === cardId ? { ...x, state: 'answering' } : x));
      await kvSet(c.env, 'autoloop:state', auto.value);
    }
  } else if (kind === 'mail') {
    await c.env.DB.prepare('UPDATE mails SET done = 1 WHERE id = ?').bind(ref).run();
  } else if (kind === 'note') {
    await replyNote(c.env, ref, REPLIES[choice ?? 0]?.status || 'ack');
  } else if (kind === 'gh') {
    const d = (await kvGet<string[]>(c.env, 'gh:dismissed'))?.value || [];
    await kvSet(c.env, 'gh:dismissed', [...d, ref].slice(-300));
  } else if (kind === 'ask') {
    const d = (await kvGet<string[]>(c.env, 'app:asks:dismissed'))?.value || [];
    await kvSet(c.env, 'app:asks:dismissed', [...d, ref].slice(-300));
  } else if (kind === 'job') {
    await c.env.DB.prepare('UPDATE jobs SET seen = 1 WHERE id = ?').bind(ref).run();
  }
}

/** Hand a task to a background agent (agent-autoloop on the Mac picks it up). */
async function delegateTask(c: C, taskId: string, note?: string) {
  const t = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<any>();
  if (!t) return null;
  const existing = await c.env.DB.prepare("SELECT id FROM jobs WHERE task_id = ? AND status NOT IN ('done','failed')").bind(taskId).first<any>();
  if (existing) return existing.id;
  const layout = await getLayout(c.env);
  const plan = await getPlan(c.env, localNow(layout.device.timezone).day);
  const id = 'j' + uid(8);
  const detail = [
    `任务：${t.title}`,
    t.ai_how ? `AI 规划时建议的做法：${t.ai_how}` : '',
    t.due ? `截止：${t.due}` : '',
    note ? `用户补充：${note}` : '',
    plan?.notes?.length ? `今天的相关备注：${plan.notes.join('；')}` : '',
  ].filter(Boolean).join('\n');
  await c.env.DB.prepare("INSERT INTO jobs (id, task_id, title, detail, agent, status, seen, created_at, updated_at) VALUES (?,?,?,?, 'claude', 'queued', 0, ?, ?)").bind(id, taskId, t.title, detail, nowIso(), nowIso()).run();
  return id;
}

async function answerQuestion(c: C, qid: string, answer: string) {
  const layout = await getLayout(c.env);
  const day = localNow(layout.device.timezone).day;
  const plan = await getPlan(c.env, day);
  const q = plan?.questions.find((x) => x.id === qid);
  if (!plan || !q) return;
  plan.questions = plan.questions.filter((x) => x.id !== qid);
  await kvSet(c.env, `plan:${day}`, plan);
  await c.env.DB.prepare("INSERT INTO captures (id, text, source, day, processed, ts) VALUES (?, ?, 'answer', ?, 1, ?)").bind('c_' + uid(), `问：${q.q} 答：${answer}`, day, nowIso()).run();
  await updatePlan(c.env, layout, '', { answer: { q: q.q, a: answer } });
  c.executionCtx.waitUntil(refreshBriefIfStale(c.env, layout));
}
app.post('/api/me/answer', async (c) => { const { qid, answer } = await c.req.json(); await answerQuestion(c, qid, answer); return c.json(await today(c)); });
app.post('/api/me/tasks/:id/toggle', async (c) => {
  const t = await c.env.DB.prepare('SELECT done FROM tasks WHERE id = ?').bind(c.req.param('id')).first<any>();
  if (t) await c.env.DB.prepare('UPDATE tasks SET done = ?, done_at = ?, updated_at = ? WHERE id = ?').bind(t.done ? 0 : 1, t.done ? null : nowIso(), nowIso(), c.req.param('id')).run();
  if (t) await syncNoteFromTask(c.env, c.req.param('id'), !t.done);
  return c.json(await today(c));
});
app.post('/api/me/actions/:id', async (c) => { const b = await c.req.json(); await resolveAction(c, c.req.param('id'), b.choice, b.text); return c.json(await today(c)); });
app.post('/api/me/tasks/:id/delegate', async (c) => { const b = await c.req.json().catch(() => ({})); await delegateTask(c, c.req.param('id'), (b as any).note); return c.json(await today(c)); });
app.post('/api/me/mail/:id/done', async (c) => { await c.env.DB.prepare('UPDATE mails SET done = 1 WHERE id = ?').bind(c.req.param('id')).run(); return c.json(await today(c)); });
app.post('/api/me/feedback', async (c) => {
  const { target, ref, vote, note } = await c.req.json();
  await c.env.DB.prepare('INSERT INTO feedback (target, ref, vote, note, ts) VALUES (?,?,?,?,?)').bind(String(target), String(ref || ''), vote > 0 ? 1 : -1, note ? String(note).slice(0, 120) : null, nowIso()).run();
  return c.json({ ok: true });
});

app.get('/admin', async (c) => {
  if (!isAdmin(c)) return c.redirect('/login');
  return c.html(shell('InkBoard 编辑器', 'admin', { origin: new URL(c.req.url).origin }), 200, { 'Cache-Control': 'no-store' });
});

app.get('/admin/google/start', async (c) => {
  if (!isAdmin(c)) return c.redirect('/login');
  try { return c.redirect(await googleAuthUrl(c.env, new URL(c.req.url).origin)); }
  catch (e: any) { return c.text(String(e.message || e), 400); }
});

app.get('/admin/google/callback', async (c) => {
  if (!isAdmin(c)) return c.redirect('/login');
  try {
    await googleCallback(c.env, new URL(c.req.url).origin, c.req.query('code') || '', c.req.query('state') || '');
    c.executionCtx.waitUntil(refreshSources(c.env, { force: true }));
    return c.redirect('/admin#secrets');
  } catch (e: any) { return c.text('Google 授权失败：' + (e.message || e), 400); }
});

// ---------------- device API ----------------
app.get('/api/device/state', async (c) => {
  c.executionCtx.waitUntil(refreshLiveMarkets(c.env).catch(() => {}));
  const s = await buildState(c.env, { includeDevice: isAdmin(c) });
  if (c.req.header('If-None-Match') === `"${s.etag}"`) return c.body(null, 304, { ETag: `"${s.etag}"` });
  return c.json(s, 200, { ETag: `"${s.etag}"`, 'Cache-Control': 'no-cache' });
});

app.post('/api/device/status', async (c) => {
  if (!isDevice(c)) return c.json({ ok: true });            // the editor preview must not overwrite real device status
  const body = (await c.req.json()) as DeviceStatus;
  await kvSet(c.env, 'device:status', { ...body, seenAt: nowIso() });
  return c.json({ ok: true });
});

app.post('/api/device/tasks/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const t = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<any>();
  if (!t) return c.json({ error: 'not found' }, 404);
  const done = !t.done;
  await c.env.DB.prepare('UPDATE tasks SET done = ?, done_at = ?, updated_at = ? WHERE id = ?').bind(done ? 1 : 0, done ? nowIso() : null, nowIso(), id).run();
  if (t.source === 'google' && t.ext_id) c.executionCtx.waitUntil(setGoogleTaskDone(c.env, t.ext_id, done));
  if (t.source === 'partner') await syncNoteFromTask(c.env, id, done);
  return c.json({ ok: true, done });
});

app.post('/api/device/actions/:id', async (c) => { const b = await c.req.json(); await resolveAction(c, c.req.param('id'), b.choice, b.text); return c.json({ ok: true }); });
app.post('/api/device/tasks/:id/delegate', async (c) => { await delegateTask(c, c.req.param('id')); return c.json({ ok: true }); });
app.post('/api/device/answer', async (c) => { const { qid, answer } = await c.req.json(); await answerQuestion(c, qid, answer); return c.json({ ok: true }); });
app.post('/api/device/mail/:id/done', async (c) => { await c.env.DB.prepare('UPDATE mails SET done = 1 WHERE id = ?').bind(c.req.param('id')).run(); return c.json({ ok: true }); });
app.post('/api/device/feedback', async (c) => {
  const { target, ref, vote, note } = await c.req.json();
  await c.env.DB.prepare('INSERT INTO feedback (target, ref, vote, note, ts) VALUES (?,?,?,?,?)').bind(String(target), String(ref || ''), vote > 0 ? 1 : -1, note ? String(note).slice(0, 120) : null, nowIso()).run();
  return c.json({ ok: true });
});

// ---------------- ingest (Mac collector / hooks) ----------------
// agent-autoloop bridge on the Mac: pull queued jobs + pending answers, push state and job progress
app.get('/api/ingest/bridge', async (c) => {
  const [queued, watch, answers] = await Promise.all([
    c.env.DB.prepare("SELECT id, task_id, title, detail, agent FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 10").all<any>().then((r) => r.results),
    c.env.DB.prepare("SELECT id, event_id, status FROM jobs WHERE status IN ('sent','running','asking') AND event_id IS NOT NULL").all<any>().then((r) => r.results),
    c.env.DB.prepare("SELECT id, card_id, choice, text FROM card_answers WHERE status = 'pending' ORDER BY id LIMIT 20").all<any>().then((r) => r.results),
  ]);
  return c.json({ queued, watch, answers });
});
app.post('/api/ingest/bridge', async (c) => {
  const b = await c.req.json();
  const st: D1PreparedStatement[] = [];
  if (b.autoloop) await kvSet(c.env, 'autoloop:state', { cards: (b.autoloop.cards || []).slice(0, 30), runs: (b.autoloop.runs || []).slice(0, 30), at: nowIso() });
  for (const j of b.jobs || []) {
    st.push(c.env.DB.prepare('UPDATE jobs SET status = COALESCE(?, status), event_id = COALESCE(?, event_id), run_id = COALESCE(?, run_id), summary = COALESCE(?, summary), result = COALESCE(?, result), updated_at = ? WHERE id = ?')
      .bind(j.status ?? null, j.event_id ?? null, j.run_id ?? null, j.summary ? String(j.summary).slice(0, 200) : null, j.result ? String(j.result).slice(0, 6000) : null, nowIso(), j.id));
    if (j.status === 'done') st.push(c.env.DB.prepare("UPDATE tasks SET done = 1, done_at = ?, updated_at = ? WHERE id = (SELECT task_id FROM jobs WHERE id = ?) AND done = 0").bind(nowIso(), nowIso(), j.id));
  }
  for (const id of b.answersDone || []) st.push(c.env.DB.prepare("UPDATE card_answers SET status = 'sent' WHERE id = ?").bind(id));
  for (const id of b.answersFailed || []) st.push(c.env.DB.prepare("UPDATE card_answers SET status = 'failed' WHERE id = ?").bind(id));
  if (st.length) await c.env.DB.batch(st);
  return c.json({ ok: true });
});

app.post('/api/ingest/context', async (c) => {
  const body = await c.req.json();
  await kvSet(c.env, 'ctx:notes', { notes: (body.notes || []).slice(0, 12), hash: String(body.hash || ''), at: nowIso() });
  return c.json({ ok: true });
});
app.post('/api/ingest/location', async (c) => {
  const b = await c.req.json();
  const lat = +b.lat, lon = +b.lon, acc = +b.accuracy || 9999;
  if (!isFinite(lat) || !isFinite(lon)) return c.json({ error: 'bad location' }, 400);
  if (acc > 1500) return c.json({ ok: true, skipped: `accuracy ±${Math.round(acc)} m too coarse` });
  const layout = await getLayout(c.env);
  if ((layout.device as any).autoLocation === false) return c.json({ ok: true, skipped: 'auto location off' });
  const cur = layout.location;
  const km = cur ? Math.hypot((lat - cur.lat) * 111, (lon - cur.lon) * 111 * Math.cos((lat * Math.PI) / 180)) : Infinity;
  if (km < 0.3 && cur?.name && cur.name !== '当前位置' && (cur.accuracy || 9999) <= acc) return c.json({ ok: true, unchanged: true });
  let name = cur?.name || '当前位置';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=zh-CN`, { headers: { 'User-Agent': 'InkBoard/1.0 (personal e-ink dashboard)' }, signal: AbortSignal.timeout(10000) });
    const j: any = await r.json();
    const a: any = j.address || {};
    name = a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city || name;
  } catch { /* keep previous name */ }
  layout.location = { lat: +lat.toFixed(5), lon: +lon.toFixed(5), name, accuracy: Math.round(+b.accuracy || 0), updatedAt: nowIso() };
  for (const p of layout.pages) for (const w of p.widgets) if (w.type === 'weather') w.props.useLocation = true;
  await saveLayout(c.env, layout);
  c.executionCtx.waitUntil(refreshSources(c.env, { force: true }));
  return c.json({ ok: true, name });
});
app.post('/api/ingest/calendar', async (c) => {
  const body = await c.req.json();
  const events = (body.events || []).filter((e: any) => e && e.start && e.title).slice(0, 200)
    .map((e: any) => ({ title: String(e.title).slice(0, 120), start: e.start, end: e.end || e.start, allDay: !!e.allDay, location: e.location ? String(e.location).slice(0, 80) : undefined, calendar: e.calendar }));
  await kvSet(c.env, 'mac:events', events);
  await mergeCalendars(c.env);
  c.executionCtx.waitUntil(refreshSources(c.env, { force: true }));
  return c.json({ ok: true, n: events.length });
});
app.post('/api/ingest/app-asks', async (c) => {
  const body = await c.req.json();
  const asks = (body.asks || []).filter((a: any) => a?.id && a?.ask).slice(0, 20)
    .map((a: any) => ({ id: String(a.id).slice(0, 80), title: String(a.title || '').slice(0, 60), ask: String(a.ask).slice(0, 160), at: a.at || nowIso(), host: a.host ? String(a.host).slice(0, 20) : undefined }));
  await kvSet(c.env, 'app:asks', asks);
  return c.json({ ok: true, n: asks.length });
});
app.post('/api/ingest/mail', async (c) => {
  const body = await c.req.json();
  const st: D1PreparedStatement[] = [];
  for (const m of (body.mails || []).slice(0, 60)) {
    if (!m?.id) continue;
    const cm = cleanMail({ sender: String(m.sender || ''), subject: String(m.subject || ''), snippet: String(m.snippet || '') });
    st.push(c.env.DB.prepare('INSERT INTO mails (id, sender, subject, received, snippet, important, action, summary, done, triaged) VALUES (?,?,?,?,?, NULL, NULL, NULL, 0, 0) ON CONFLICT(id) DO NOTHING')
      .bind(String(m.id).slice(0, 200), cm.sender.slice(0, 120), cm.subject.slice(0, 200), m.received || nowIso(), cm.snippet.slice(0, 1200)));
  }
  if (st.length) await c.env.DB.batch(st);
  await kvSet(c.env, 'mail:sync', { at: nowIso(), n: st.length });
  c.executionCtx.waitUntil(triageMail(c.env).catch(() => {}));
  return c.json({ ok: true, n: st.length });
});
app.post('/api/ingest/agent', async (c) => {
  const body = await c.req.json();
  const events: AgentEvent[] = Array.isArray(body) ? body : [body];
  for (const e of events) {
    if (!e || !e.session || !e.event) continue;
    await ingestAgentEvent(c.env, e);
    const fin = (e as any).finalText;
    if ((e.event === 'Stop' || e.event === 'TurnComplete') && fin && fin.length > 30) {
      c.executionCtx.waitUntil(summarizeAgent(c.env, `${e.tool}:${e.session}`, fin).catch(() => {}));
    }
  }
  return c.json({ ok: true });
});

app.post('/api/ingest/quota', async (c) => {
  const body = (await c.req.json()) as { providers: QuotaProvider[] };
  const stmts = (body.providers || []).filter((p) => p && p.provider).map((p) =>
    c.env.DB.prepare('INSERT INTO quotas (provider, json, captured_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET json = excluded.json, captured_at = excluded.captured_at')
      .bind(p.provider.toLowerCase(), JSON.stringify({ ...p, provider: p.provider.toLowerCase() }), p.capturedAt || nowIso()));
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, n: stmts.length });
});

app.post('/api/ingest/usage', async (c) => {
  const body = (await c.req.json()) as { providers: any[] };
  const cur = (await kvGet<Record<string, any>>(c.env, 'usage'))?.value || {};
  for (const p of body.providers || []) if (p && p.provider) cur[p.provider] = p;
  await kvSet(c.env, 'usage', cur);
  return c.json({ ok: true });
});

// ---------------- admin API ----------------
app.get('/api/admin/meta', async (c) => {
  const secrets = await getSecrets(c.env);
  const device = (await kvGet<DeviceStatus>(c.env, 'device:status'))?.value || null;
  return c.json({
    googleConnected: await googleConnected(c.env),
    secrets: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, v ? (k === 'ics_urls' ? `${v.split(/\s+/).filter(Boolean).length} 个地址` : '••••' + v.slice(-4)) : ''])),
    balanceSecrets: BALANCE_SECRETS,
    device,
    aiUsage: (await kvGet(c.env, 'ai:usage'))?.value || null,
    outlook: {
      ics: (await kvGet(c.env, 'outlook:ics'))?.value || null,
      mails: await c.env.DB.prepare('SELECT COUNT(*) AS n, MAX(received) AS last FROM mails').first<{ n: number; last: string | null }>(),
    },
    origin: new URL(c.req.url).origin,
  });
});

app.get('/api/admin/layout', async (c) => c.json(await getLayout(c.env)));
app.get('/api/admin/symbols', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 40);
  if (!q) return c.json({ items: [] });
  try {
    if (/[\u3400-\u9fff]/.test(q)) {
      // Yahoo search is English-only: let DeepSeek turn a Chinese name into tickers, then check them on Yahoo.
      const cache = (await kvGet<Record<string, any[]>>(c.env, 'symbols:zh'))?.value || {};
      if (cache[q]) return c.json({ items: cache[q] });
      const r = await deepseek(c.env, '把用户说的金融品种名称换成 Yahoo Finance 代码。只输出 JSON：{"items":[{"symbol":"…","name":"中文名"}]}，最多 4 个，最可能的放前面。A 股用 .SS/.SZ，港股 4 位数字加 .HK，澳股 .AX，美股直接代码，汇率如 AUDCNY=X，加密货币如 BTC-USD，期货如 GC=F，指数如 ^GSPC。', q, { maxTokens: 200, effort: 'off' });
      const out: any[] = [];
      for (const it of (r.items || []).slice(0, 4)) {
        const hit = (await searchSymbols(String(it.symbol)).catch(() => [])).find((x) => x.symbol.toUpperCase() === String(it.symbol).toUpperCase());
        if (hit) out.push({ ...hit, name: it.name || hit.name });
      }
      if (out.length) await kvSet(c.env, 'symbols:zh', { ...cache, [q]: out });
      return c.json({ items: out });
    }
    return c.json({ items: await searchSymbols(q) });
  } catch (e: any) { return c.json({ items: [], error: String(e?.message || e) }); }
});
app.put('/api/admin/layout', async (c) => {
  const l = (await c.req.json()) as Layout;
  if (!l || !Array.isArray(l.pages) || !l.pages.length) return c.json({ error: 'invalid layout' }, 400);
  const saved = await saveLayout(c.env, l);
  c.executionCtx.waitUntil(refreshSources(c.env));
  return c.json(saved);
});
app.post('/api/admin/layout/reset', async (c) => {
  const { orientation } = (await c.req.json().catch(() => ({}))) as { orientation?: any };
  const cur = await getLayout(c.env);
  const fresh = defaultLayout(orientation || cur.orientation || 'landscape');
  fresh.location = cur.location;
  fresh.profile = cur.profile;
  fresh.device = { ...fresh.device, ...cur.device };
  const saved = await saveLayout(c.env, fresh);
  c.executionCtx.waitUntil(refreshSources(c.env));
  return c.json(saved);
});

app.put('/api/admin/secrets', async (c) => {
  const patch = (await c.req.json()) as Record<string, string | null>;
  const cur = await getSecrets(c.env);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete cur[k];
    else cur[k] = String(v).trim();
  }
  await kvSet(c.env, 'secrets', cur);
  c.executionCtx.waitUntil(refreshSources(c.env, { force: true }));
  return c.json({ ok: true });
});

app.post('/api/admin/refresh', async (c) => {
  const { widgetId } = (await c.req.json().catch(() => ({}))) as { widgetId?: string };
  await refreshSources(c.env, { force: true, onlyWidget: widgetId });
  return c.json({ ok: true });
});

app.post('/api/admin/ai/brief', async (c) => {
  try { return c.json(await generateBrief(c.env, await getLayout(c.env))); } catch (e: any) { return c.json({ error: String(e.message || e) }, 500); }
});
app.post('/api/admin/ai/papers', async (c) => {
  const l = await getLayout(c.env);
  const props = l.pages.flatMap((p) => p.widgets).find((w) => w.type === 'ai' && w.props?.mode === 'papers')?.props;
  try { return c.json(await generatePapers(c.env, props)); } catch (e: any) { return c.json({ error: String(e.message || e) }, 500); }
});
app.post('/api/admin/ai/tasks', async (c) => {
  const { text, google } = await c.req.json();
  if (!text) return c.json({ error: 'text required' }, 400);
  const l = await getLayout(c.env);
  try {
    const tasks = await parseTasks(c.env, text, l.device.timezone);
    for (const t of tasks) {
      if (google) await addGoogleTask(c.env, t.title);
      else await c.env.DB.prepare("INSERT INTO tasks (id, title, due, done, source, sort, updated_at) VALUES (?,?,?,0,'local',?,?)").bind('t_' + uid(), t.title, t.due || null, -Date.now() / 1e9, nowIso()).run();
    }
    return c.json({ ok: true, tasks });
  } catch (e: any) { return c.json({ error: String(e.message || e) }, 500); }
});
app.get('/api/admin/memory', async (c) => c.json({ facts: await listFacts(c.env), observation: await getObservation(c.env), research: (await kvGet(c.env, 'ai:research'))?.value || null }));
app.post('/api/admin/memory', async (c) => { const b = await c.req.json(); await addFactManual(c.env, b.kind || 'fact', b.subject || '用户', b.predicate || '备注', String(b.value || '')); return c.json({ ok: true }); });
app.patch('/api/admin/memory/:id', async (c) => {
  const b = await c.req.json();
  if (b.pinned !== undefined) await setFactPinned(c.env, c.req.param('id'), !!b.pinned);
  if (b.value) await editFact(c.env, c.req.param('id'), String(b.value));
  return c.json({ ok: true });
});
app.delete('/api/admin/memory/:id', async (c) => { await deleteFact(c.env, c.req.param('id')); return c.json({ ok: true }); });
app.post('/api/admin/ai/research', async (c) => { try { return c.json(await updateResearchFocus(c.env)); } catch (e: any) { return c.json({ error: String(e.message || e) }, 500); } });
app.post('/api/admin/ai/observation', async (c) => { try { return c.json(await updateObservation(c.env, await getLayout(c.env))); } catch (e: any) { return c.json({ error: String(e.message || e) }, 500); } });
app.get('/api/admin/ai/usage', async (c) => c.json((await kvGet(c.env, 'ai:usage'))?.value || null));

app.post('/api/admin/command', async (c) => {
  const { cmd, arg } = await c.req.json();
  await pushCommand(c.env, { cmd, arg });
  return c.json({ ok: true });
});

app.get('/api/admin/agent/:id/timeline', async (c) => c.json(await agentTimeline(c.env, c.req.param('id'), 30)));
app.delete('/api/admin/agent/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM agent_sessions WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// tasks
app.get('/api/admin/tasks', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM tasks ORDER BY done ASC, sort ASC, updated_at DESC LIMIT 200').all()).results));
app.post('/api/admin/tasks', async (c) => {
  const { title, due, google } = await c.req.json();
  if (!title) return c.json({ error: 'title required' }, 400);
  if (google) {
    await addGoogleTask(c.env, title);
    await refreshSources(c.env, { force: true });
    return c.json({ ok: true });
  }
  const min = await c.env.DB.prepare('SELECT MIN(sort) AS m FROM tasks').first<{ m: number }>();
  await c.env.DB.prepare('INSERT INTO tasks (id, title, due, done, source, sort, updated_at) VALUES (?,?,?,0,\'local\',?,?)').bind('t_' + uid(), title, due || null, (min?.m ?? 0) - 1, nowIso()).run();
  return c.json({ ok: true });
});
app.patch('/api/admin/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const t = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<any>();
  if (!t) return c.json({ error: 'not found' }, 404);
  const done = b.done === undefined ? !!t.done : !!b.done;
  await c.env.DB.prepare('UPDATE tasks SET title = ?, due = ?, done = ?, done_at = ?, sort = ?, updated_at = ? WHERE id = ?')
    .bind(b.title ?? t.title, b.due === undefined ? t.due : b.due, done ? 1 : 0, done ? t.done_at || nowIso() : null, b.sort ?? t.sort, nowIso(), id).run();
  if (t.source === 'google' && b.done !== undefined && !!b.done !== !!t.done) c.executionCtx.waitUntil(setGoogleTaskDone(c.env, t.ext_id, done));
  return c.json({ ok: true });
});
app.delete('/api/admin/tasks/:id', async (c) => {
  await c.env.DB.prepare("DELETE FROM tasks WHERE id = ? AND source = 'local'").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// memos
app.get('/api/admin/memos', async (c) => c.json((await c.env.DB.prepare('SELECT * FROM memos ORDER BY pinned DESC, updated_at DESC').all()).results));
app.post('/api/admin/memos', async (c) => {
  const { body, pinned } = await c.req.json();
  if (!body) return c.json({ error: 'body required' }, 400);
  await c.env.DB.prepare('INSERT INTO memos (id, body, pinned, updated_at) VALUES (?,?,?,?)').bind('m_' + uid(), body, pinned ? 1 : 0, nowIso()).run();
  return c.json({ ok: true });
});
app.patch('/api/admin/memos/:id', async (c) => {
  const b = await c.req.json();
  const m = await c.env.DB.prepare('SELECT * FROM memos WHERE id = ?').bind(c.req.param('id')).first<any>();
  if (!m) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('UPDATE memos SET body = ?, pinned = ?, updated_at = ? WHERE id = ?').bind(b.body ?? m.body, b.pinned === undefined ? m.pinned : b.pinned ? 1 : 0, nowIso(), m.id).run();
  return c.json({ ok: true });
});
app.delete('/api/admin/memos/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM memos WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// Personal pictures (ledger mascot, home-screen icon) live in public/custom/, which is not in git.
// Without them the bundled defaults in public/defaults/ are served.
async function customOr(c: C, name: string) {
  const origin = new URL(c.req.url).origin;
  const r = await c.env.ASSETS.fetch(new Request(`${origin}/custom/${name}`));
  return r.ok ? r : c.env.ASSETS.fetch(new Request(`${origin}/defaults/${name}`));
}
for (const n of ['header', 'fab']) app.get(`/mascot/${n}.png`, (c) => customOr(c, `${n}.png`));
for (const n of [180, 192, 512]) app.get(`/money-icon-${n}.png`, (c) => customOr(c, `money-icon-${n}.png`));

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refreshSources(env).then(async () => aiCron(env, await getLayout(env))));
    const d = new Date(ev.scheduledTime);
    if (d.getUTCHours() === 17 && d.getUTCMinutes() < 5) ctx.waitUntil(pruneAgentEvents(env));
  },
} satisfies ExportedHandler<Env>;
