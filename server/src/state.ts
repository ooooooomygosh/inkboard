import type { DeviceCommand, DeviceStatus, Layout, QuotaProvider, StatePayload, UsageProvider, Widget } from '../shared/types';
import { catalogOf } from '../shared/catalog';
import { DEFAULT_LAYOUT, defaultLayout } from '../shared/defaults';
import { listAgents } from './agents';
import { fetchBalances } from './sources/balances';
import { deadlinesSource } from './sources/deadlines';
import { githubSource, githubTokens } from './sources/github';
import { CalEvent, googleConnected, googleEvents, syncGoogleTasks } from './sources/google';
import { parseIcs } from './sources/ics';
import { marketsSource } from './sources/markets';
import { weatherSource } from './sources/weather';
import { Env, getSecrets, kvGet, kvSet, nowIso, sha1 } from './util';
import { getPlan, localNow } from './ai';
import { actionItems, doingItems } from './actions';
import { moneySummary } from './money';

export interface CacheEntry<T = any> { value: T | null; fetchedAt: string | null; error?: string; errorAt?: string }

/** Fill fields added in later versions so old saved layouts keep working. */
export function normalizeLayout(l: Layout): Layout {
  const d = defaultLayout(l.orientation || 'portrait');
  l.orientation ||= 'portrait';
  l.theme = { ...d.theme, ...(l.theme || {}) };
  l.device = { ...d.device, ...(l.device || {}), night: { ...d.device.night, ...(l.device?.night || {}) }, light: { ...d.device.light, ...(l.device?.light || {}) }, battery: { ...d.device.battery, ...(l.device?.battery || {}) } };
  l.grid = { ...d.grid, ...(l.grid || {}) };
  l.profile = { ...d.profile, ...(l.profile || {}) };
  return l;
}

export async function getLayout(env: Env): Promise<Layout> {
  const l = (await kvGet<Layout>(env, 'layout'))?.value;
  return l ? normalizeLayout(l) : JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
}

/** Weather props with the board-wide location applied (when the widget opts in). */
export function wxProps(p: any, layout: Layout) {
  if (p.useLocation !== false && layout.location) return { ...p, lat: layout.location.lat, lon: layout.location.lon, name: layout.location.name || p.name };
  return p;
}
const firstDeadlines = (l: Layout) => l.pages.flatMap((p) => p.widgets).find((w) => w.type === 'deadlines')?.props || catalogOf('deadlines').props;
const firstWeather = (l: Layout) => l.pages.flatMap((p) => p.widgets).find((w) => w.type === 'weather');
export function focusWx(l: Layout) {
  const base = firstWeather(l)?.props || { useLocation: true, name: '上海', lat: 31.2304, lon: 121.4737 };
  return wxProps({ ...base, useLocation: true }, l);
}

export async function saveLayout(env: Env, layout: Layout) {
  const cur = await getLayout(env);
  layout.version = (cur.version || 0) + 1;
  layout.updatedAt = nowIso();
  await kvSet(env, 'layout', layout);
  return layout;
}

const allWidgets = (l: Layout) => l.pages.flatMap((p) => p.widgets);

async function readCache(env: Env, key: string): Promise<CacheEntry> {
  return (await kvGet<CacheEntry>(env, 'cache:' + key))?.value || { value: null, fetchedAt: null };
}

async function refreshOne(env: Env, key: string, ttlSec: number, force: boolean, fn: () => Promise<any>) {
  const cur = await readCache(env, key);
  const last = Date.parse(cur.errorAt && (!cur.fetchedAt || cur.errorAt > cur.fetchedAt) ? cur.errorAt : cur.fetchedAt || '1970-01-01');
  if (!force && Date.now() - last < ttlSec * 1000) return;
  try {
    const value = await fn();
    await kvSet(env, 'cache:' + key, { value, fetchedAt: nowIso() } as CacheEntry);
  } catch (e: any) {
    await kvSet(env, 'cache:' + key, { ...cur, error: String(e?.message || e).slice(0, 200), errorAt: nowIso() } as CacheEntry);
  }
}

function calendarKey(w: Widget) { return `calendar:${w.props.source || 'auto'}:${Math.max(1, +w.props.days || 1)}`; }

async function loadCalendar(env: Env, source: string, days: number): Promise<CalEvent[]> {
  const secrets = await getSecrets(env);
  const outlook = ((await kvGet<CalEvent[]>(env, 'outlook:events'))?.value || []).filter((e) => Date.parse(e.end) > Date.now() - 12 * 3600_000 && Date.parse(e.start) < Date.now() + (days + 1) * 86400_000);
  const useGoogle = source === 'google' || (source === 'auto' && (await googleConnected(env)));
  if (useGoogle) return [...outlook, ...(await googleEvents(env, days))].sort((a, b) => a.start.localeCompare(b.start));
  const urls = (secrets.ics_urls || '').split(/\s+/).filter(Boolean);
  if (!urls.length) {
    if (outlook.length || (await kvGet(env, 'outlook:events'))) return outlook.sort((a, b) => a.start.localeCompare(b.start));
    throw new Error('日历未连接：在编辑器“数据源”里填日历的 ICS 链接');
  }
  const from = Date.now() - 12 * 3600_000, to = Date.now() + (days + 1) * 86400_000;
  const lists = await Promise.all(urls.map(async (u: string) => {
    const r = await fetch(u.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`iCal ${r.status}`);
    return parseIcs(await r.text(), from, to);
  }));
  return [...outlook, ...lists.flat()].sort((a, b) => a.start.localeCompare(b.start));
}

/** Any calendar's ICS subscription link (Outlook "Publish calendar", Google "secret address", …). The cloud pulls it
 *  itself every 15 min, so it works even when the Mac is asleep. Mac EventKit events (if any) are
 *  merged in; everything downstream reads the merged `outlook:events`. */
export async function syncOutlookIcs(env: Env, tz: string, force = false) {
  const url = (await getSecrets(env)).outlook_ics;
  if (!url) return;
  const last = await kvGet<{ ok?: string; error?: string; n?: number }>(env, 'outlook:ics');
  if (!force && last && Date.now() - Date.parse(last.updatedAt + (last.updatedAt.endsWith('Z') ? '' : 'Z')) < 14 * 60_000) return;
  try {
    const r = await fetch(url.replace(/^webcal:/, 'https:'), { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'InkBoard/1' } });
    if (!r.ok) throw new Error(`日历链接返回 ${r.status}`);
    const text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('链接打开的不是日历文件（要用 .ics 那个链接）');
    const events = parseIcs(text, Date.now() - 86400_000, Date.now() + 21 * 86400_000, '日历', tz).slice(0, 300);
    await kvSet(env, 'ics:events', events);
    await kvSet(env, 'outlook:ics', { ok: nowIso(), n: events.length });
    await mergeCalendars(env);
  } catch (e: any) {
    await kvSet(env, 'outlook:ics', { ...(last?.value || {}), error: String(e?.message || e).slice(0, 160) });
  }
}

export async function mergeCalendars(env: Env) {
  const [mac, ics, partner] = await Promise.all([kvGet<CalEvent[]>(env, 'mac:events'), kvGet<CalEvent[]>(env, 'ics:events'), kvGet<CalEvent[]>(env, 'partner:events')]);
  const seen = new Set<string>();
  const merged = [...(ics?.value || []), ...(mac?.value || []), ...(partner?.value || [])].filter((e) => {
    const k = `${e.title.trim().toLowerCase()}|${Date.parse(e.start)}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => a.start.localeCompare(b.start));
  await kvSet(env, 'outlook:events', merged);
}

/** US stocks trade 04:00–20:00 New York time on weekdays (pre-market, regular, after-hours). */
export function usMarketLive(now = new Date()) {
  const p: any = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return !['Sat', 'Sun'].includes(p.weekday) && +p.hour >= 4 && +p.hour < 20;
}
const isUsStock = (sym: string) => /^[A-Z][A-Z.]{0,5}$/.test(sym) && !/\.(AX|HK|SS|SZ|L|T|TO)$/.test(sym);

/** While US stocks trade, markets that hold a US stock refresh about once a minute, piggybacking on the
 *  reader's 30-second poll (the cron only runs every 5 minutes). */
export async function refreshLiveMarkets(env: Env) {
  if (!usMarketLive()) return;
  const layout = await getLayout(env);
  const seen = new Set<string>();
  for (const w of allWidgets(layout)) {
    if (w.type !== 'markets' || !(w.props.items || []).some((i: any) => isUsStock(i.symbol))) continue;
    const k = marketsSource.key(w.props);
    if (seen.has(k)) continue;
    seen.add(k);
    await refreshOne(env, k, 60, false, () => marketsSource.fetch(w.props));
  }
}

/** Refresh every external source the current layout needs. Called by cron and after layout saves. */
export async function refreshSources(env: Env, opts: { force?: boolean; onlyWidget?: string } = {}) {
  const layout = await getLayout(env);
  const secrets = await getSecrets(env);
  const tz = layout.device.timezone;
  const jobs = new Map<string, () => Promise<void>>();
  const force = !!opts.force;
  if (!opts.onlyWidget) await syncOutlookIcs(env, tz, force);
  for (const w of allWidgets(layout)) {
    if (opts.onlyWidget && w.id !== opts.onlyWidget) continue;
    switch (w.type) {
      case 'weather': { const p = wxProps(w.props, layout); const k = weatherSource.key(p); jobs.set(k, () => refreshOne(env, k, weatherSource.ttlSec, force, () => weatherSource.fetch(p, tz))); break; }
      case 'plan': jobs.set('calendar:auto:1', () => refreshOne(env, 'calendar:auto:1', 5 * 60, force, () => loadCalendar(env, 'auto', 1))); break;
      case 'header': { const p = focusWx(layout); const k = weatherSource.key(p); jobs.set(k, () => refreshOne(env, k, weatherSource.ttlSec, force, () => weatherSource.fetch(p, tz))); break; }
      case 'stat': {
        const m = String(w.props.metric || '');
        if (m.startsWith('balance:')) jobs.set('balances', () => refreshOne(env, 'balances', 60 * 60, force, () => fetchBalances(secrets)));
        if (m === 'deadline') { const dp = firstDeadlines(layout); const k = deadlinesSource.key(dp); jobs.set(k, () => refreshOne(env, k, deadlinesSource.ttlSec, force, () => deadlinesSource.fetch(dp, env))); }
        if (m === 'tasks') jobs.set('gtasks', () => refreshOne(env, 'gtasks', 5 * 60, force, async () => { await syncGoogleTasks(env); return true; }));
        break;
      }
      case 'focus': {
        const p = focusWx(layout); const k = weatherSource.key(p);
        jobs.set(k, () => refreshOne(env, k, weatherSource.ttlSec, force, () => weatherSource.fetch(p, tz)));
        jobs.set('calendar:auto:1', () => refreshOne(env, 'calendar:auto:1', 5 * 60, force, () => loadCalendar(env, 'auto', 1)));
        jobs.set('gtasks', () => refreshOne(env, 'gtasks', 5 * 60, force, async () => { await syncGoogleTasks(env); return true; }));
        break;
      }
      case 'markets': { const k = marketsSource.key(w.props); jobs.set(k, () => refreshOne(env, k, marketsSource.ttlSec, force, () => marketsSource.fetch(w.props))); break; }
      case 'deadlines': { const k = deadlinesSource.key(w.props); jobs.set(k, () => refreshOne(env, k, deadlinesSource.ttlSec, force, () => deadlinesSource.fetch(w.props, env))); break; }
      case 'github': if (githubTokens(secrets).length) jobs.set('github', () => refreshOne(env, 'github', githubSource.ttlSec, force, () => githubSource.fetch(githubTokens(secrets)))); break;
      case 'calendar': { const k = calendarKey(w); jobs.set(k, () => refreshOne(env, k, 5 * 60, force, () => loadCalendar(env, w.props.source || 'auto', Math.max(1, +w.props.days || 1)))); break; }
      case 'quotas': if (w.props.showBalances) jobs.set('balances', () => refreshOne(env, 'balances', 60 * 60, force, () => fetchBalances(secrets))); break;
      case 'tasks': if (w.props.source !== 'local') jobs.set('gtasks', () => refreshOne(env, 'gtasks', 5 * 60, force, async () => { await syncGoogleTasks(env); return true; })); break;
    }
  }
  await Promise.all([...jobs.values()].map((j) => j()));
}

const wrap = (c: CacheEntry, value: any) => ({ value, at: c.fetchedAt, error: c.error && (!c.fetchedAt || (c.errorAt || '') > c.fetchedAt) ? c.error : undefined });

let BUILD_ID: string | null = null;
async function buildId(env: Env) {
  if (BUILD_ID) return BUILD_ID;
  try { const r = await env.ASSETS.fetch('https://assets/assets/build.json'); BUILD_ID = ((await r.json()) as any).build || ''; } catch { BUILD_ID = ''; }
  return BUILD_ID;
}

export async function buildState(env: Env, extra: { includeDevice?: boolean } = {}): Promise<StatePayload & { etag: string; build?: string }> {
  const layout = await getLayout(env);
  const widgets = allWidgets(layout);
  const types = new Set(widgets.map((w) => w.type));
  const [agents, tasks, memos, quotaRows, cmds, device] = await Promise.all([
    types.has('agents') || types.has('focus') || types.has('stat') ? listAgents(env) : Promise.resolve([]),
    types.has('tasks') || types.has('focus') || types.has('stat') ? env.DB.prepare(`SELECT * FROM tasks WHERE done = 0 OR done_at > ? ORDER BY done ASC, COALESCE(priority, 2) ASC, CASE WHEN due IS NULL THEN 1 ELSE 0 END, due ASC, sort ASC, updated_at DESC LIMIT 60`).bind(new Date(Date.now() - 18 * 3600_000).toISOString()).all<any>().then((r) => r.results) : Promise.resolve([]),
    types.has('memo') ? env.DB.prepare('SELECT * FROM memos ORDER BY pinned DESC, updated_at DESC LIMIT 20').all<any>().then((r) => r.results) : Promise.resolve([]),
    types.has('quotas') || types.has('stat') ? env.DB.prepare('SELECT json FROM quotas').all<any>().then((r) => r.results.map((x: any) => JSON.parse(x.json) as QuotaProvider)) : Promise.resolve([]),
    kvGet<DeviceCommand[]>(env, 'device:cmds'),
    extra.includeDevice ? kvGet<DeviceStatus>(env, 'device:status') : Promise.resolve(null),
  ]);
  const usage = types.has('stat') ? (await kvGet<Record<string, UsageProvider>>(env, 'usage'))?.value || {} : {};
  const needsBrief = types.has('ai') || types.has('header') || types.has('focus');
  const [briefKv, papersKv] = await Promise.all([needsBrief ? kvGet<any>(env, 'ai:brief') : null, types.has('ai') ? kvGet<any>(env, 'ai:papers') : null]);
  const brief = briefKv?.value || null;
  const today = localNow(layout.device.timezone).day;
  const plan = types.has('plan') || types.has('focus') ? await getPlan(env, today) : null;
  const mails = types.has('mail') || types.has('stat') ? (await env.DB.prepare('SELECT id, sender, subject, received, summary, action FROM mails WHERE important = 1 AND done = 0 ORDER BY received DESC LIMIT 12').all<any>()).results : [];
  const needsActions = types.has('inbox') || types.has('stat') || types.has('focus');
  const [actions, doing] = await Promise.all([needsActions ? actionItems(env, layout) : [], types.has('doing') || types.has('stat') ? doingItems(env, layout) : []]);
  // connected = the Mac has synced mail recently (an empty inbox is still connected)
  const mailSync = types.has('mail') || types.has('stat') ? (await kvGet<{ at: string; n: number }>(env, 'mail:sync'))?.value || null : null;
  const mailConnected = !!mailSync && Date.now() - Date.parse(mailSync.at) < 2 * 86400_000;

  const cacheKeys = new Set<string>();
  for (const w of widgets) {
    if (w.type === 'weather') cacheKeys.add(weatherSource.key(wxProps(w.props, layout)));
    if (w.type === 'focus') { cacheKeys.add(weatherSource.key(focusWx(layout))); cacheKeys.add('calendar:auto:1'); }
    if (w.type === 'header') cacheKeys.add(weatherSource.key(focusWx(layout)));
    if (w.type === 'plan') cacheKeys.add('calendar:auto:1');
    if (w.type === 'stat') { cacheKeys.add('balances'); cacheKeys.add(deadlinesSource.key(firstDeadlines(layout))); }
    if (w.type === 'markets') cacheKeys.add(marketsSource.key(w.props));
    if (w.type === 'deadlines') cacheKeys.add(deadlinesSource.key(w.props));
    if (w.type === 'github') cacheKeys.add('github');
    if (w.type === 'calendar') cacheKeys.add(calendarKey(w));
    if (w.type === 'quotas') cacheKeys.add('balances');
  }
  const caches: Record<string, CacheEntry> = {};
  await Promise.all([...cacheKeys].map(async (k) => { caches[k] = await readCache(env, k); }));
  const secrets = types.has('github') ? await getSecrets(env) : {};

  const data: Record<string, any> = {};
  for (const w of widgets) {
    const p = w.props;
    switch (w.type) {
      case 'weather': { const pp = wxProps(p, layout); const c = caches[weatherSource.key(pp)]; data[w.id] = { ...wrap(c, c.value), name: pp.name }; break; }
      case 'header': {
        const wc = caches[weatherSource.key(focusWx(layout))];
        data[w.id] = { value: { weather: wc.value ? { now: wc.value.now, today: wc.value.daily[0], summary: wc.value.summary, name: focusWx(layout).name } : null, headline: brief?.headline || null }, at: wc.fetchedAt };
        break;
      }
      case 'plan': {
        const c = caches['calendar:auto:1'];
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const events = ((c?.value || []) as any[]).filter((e) => !e.allDay && Date.parse(e.end) > Date.now() - 30 * 60_000 && Date.parse(e.start) < Date.now() + 18 * 3600_000).slice(0, 12);
        data[w.id] = { value: plan ? { summary: plan.summary, blocks: plan.blocks, notes: plan.notes, questions: plan.questions, updatedAt: plan.updatedAt } : null, events, calError: c?.error && !c?.fetchedAt ? c.error : undefined };
        break;
      }
      case 'inbox': data[w.id] = { value: actions }; break;
      case 'doing': data[w.id] = { value: doing }; break;
      case 'mail': data[w.id] = { value: mails.slice(0, Math.max(1, +p.max || 5)), connected: mailConnected }; break;
      case 'ai': {
        data[w.id] = p.mode === 'papers' ? { value: papersKv?.value || null } : { value: brief };
        break;
      }
      case 'stat': {
        const m = String(p.metric || '');
        const [kind, arg] = m.split(':');
        let value: any = null;
        if (kind === 'quota') value = quotaRows.find((q) => q.provider === arg) || null;
        else if (kind === 'tokens') {
          const list = Object.values(usage).filter((u) => arg === 'all' || u.provider === arg);
          value = list.length ? { providers: list } : null;
        } else if (kind === 'agents') value = { list: agents.slice(0, 3), running: agents.filter((a) => a.state === 'running').length, waiting: agents.filter((a) => a.state === 'waiting').length };
        else if (kind === 'tasks') { const open = tasks.filter((t: any) => !t.done); value = { count: open.length, top: open.slice(0, 2).map((t: any) => ({ title: t.title, due: t.due })) }; }
        else if (kind === 'deadline') value = ((caches[deadlinesSource.key(firstDeadlines(layout))]?.value || []) as any[]).filter((d) => Date.parse(d.at) > Date.now())[0] || null;
        else if (kind === 'balance') value = ((caches.balances?.value || []) as any[]).find((b) => b.id === arg) || null;
        else if (kind === 'needs') {
          const running = doing.filter((x) => x.kind !== 'block');
          value = { count: actions.length, top: actions.slice(0, 2), urgent: actions.some((a) => a.urgent), running: running.length, runningTop: running.slice(0, 3).map((x) => x.title) };
        } else if (kind === 'mail') value = { connected: mailConnected, syncedAt: mailSync?.at || null, count: mails.length, top: mails.slice(0, 2) };
        data[w.id] = { value };
        break;
      }
      case 'focus': {
        const wc = caches[weatherSource.key(focusWx(layout))];
        const cc = caches['calendar:auto:1'];
        const now = Date.now();
        const events = ((cc.value || []) as any[]).filter((e) => !e.allDay && Date.parse(e.end) > now).slice(0, 3);
        const open = tasks.filter((t: any) => !t.done);
        data[w.id] = {
          value: {
            weather: wc.value ? { now: wc.value.now, today: wc.value.daily[0], summary: wc.value.summary, name: focusWx(layout).name } : null,
            events,
            tasks: open.slice(0, 3).map((t: any) => ({ id: t.id, title: t.title, due: t.due })),
            taskCount: open.length,
            agents: agents.filter((a) => a.state === 'running' || a.state === 'waiting').slice(0, 3),
            aiFocus: brief?.focus || null,
            planSummary: plan?.summary || null,
            planBlocks: plan?.blocks || [],
            needs: actions.slice(0, 1),
          },
        };
        break;
      }
      case 'markets': { const c = caches[marketsSource.key(p)]; data[w.id] = wrap(c, c.value); break; }
      case 'github': { const c = caches.github; data[w.id] = githubTokens(secrets).length ? wrap(c, c.value) : { value: null, error: '未配置 GitHub 令牌' }; break; }
      case 'calendar': { const c = caches[calendarKey(w)]; data[w.id] = wrap(c, c.value ? c.value.slice(0, 80) : null); break; }
      case 'deadlines': {
        const c = caches[deadlinesSource.key(p)];
        const custom = (Array.isArray(p.custom) ? p.custom : []).filter((x: any) => x && x.date).map((x: any) => ({
          name: x.name, detail: x.detail, at: /T/.test(x.date) ? new Date(x.date).toISOString() : new Date(x.date + 'T23:59:59+10:00').toISOString(), kind: 'custom',
        }));
        const all = [...(c.value || []), ...custom].filter((d: any) => Date.parse(d.at) > Date.now() - 86400_000).sort((a: any, b: any) => a.at.localeCompare(b.at));
        data[w.id] = wrap(c, all.slice(0, Math.max(1, +p.max || 4)));
        break;
      }
      case 'agents': {
        const list = agents.filter((a) => p.showDone !== false || a.state !== 'done');
        data[w.id] = { value: list.slice(0, Math.max(1, +p.max || 4)), at: nowIso() };
        break;
      }
      case 'money': data[w.id] = { value: await moneySummary(env, layout).catch(() => null) }; break;
      case 'quotas': {
        const order: string[] = Array.isArray(p.providers) ? p.providers.map((x: string) => x.toLowerCase()) : [];
        // Default order: subscriptions first, the scarcest on top (one that will run out before it resets
        // beats any percentage), then pay-as-you-go balances. A list typed in the editor wins.
        const left = (q: QuotaProvider) => (q.windows.length ? Math.min(...q.windows.map((x) => 100 - (x.usedPct ?? 0))) : 1000);
        const runsOut = (q: QuotaProvider) => q.windows.some((x: any) => x.pace && x.pace.willLast === false);
        const rows = quotaRows.filter((q) => !order.length || order.includes(q.provider)).sort((a, b) =>
          order.length ? order.indexOf(a.provider) - order.indexOf(b.provider) : Number(runsOut(b)) - Number(runsOut(a)) || left(a) - left(b));
        // the same service can come from the Mac (CodexBar) and from the cloud's own balance check: show it once
        const shown = new Set(rows.map((q) => q.provider.toLowerCase()));
        const balances = p.showBalances ? ((caches.balances.value || []) as any[]).filter((b) => !shown.has(String(b.id).toLowerCase().split(/[-_:]/)[0])) : [];
        data[w.id] = { value: { providers: rows, balances }, at: rows[0]?.capturedAt || null };
        break;
      }
      case 'tasks': {
        const list = tasks.filter((t: any) => (p.source === 'all' || !p.source || t.source === p.source) && (p.showDone !== false || !t.done));
        data[w.id] = { value: list.slice(0, Math.max(1, +p.max || 8)).map((t: any) => ({ id: t.id, title: t.title, due: t.due, done: !!t.done, source: t.source, list: t.list, priority: t.priority, ai: !!t.ai_ok })), total: list.filter((t: any) => !t.done).length };
        break;
      }
      case 'memo': {
        const list = p.mode === 'pinned' ? memos.filter((m: any) => m.pinned) : memos;
        data[w.id] = { value: (list.length ? list : memos).slice(0, Math.max(1, +p.max || 3)).map((m: any) => ({ id: m.id, body: m.body, pinned: !!m.pinned, updatedAt: m.updated_at })) };
        break;
      }
    }
  }

  const commands = (cmds?.value || []).filter((c) => Date.now() - Date.parse(c.ts) < 10 * 60_000);
  const agentsActive = agents.some((a) => a.state === 'running' || a.state === 'waiting') || doing.some((d: any) => d.kind === 'job');
  const body = { layout, data, agentsActive, commands, device: device?.value, build: (await buildId(env)) || undefined };
  const etag = await sha1(JSON.stringify(body));
  return { serverTime: nowIso(), ...body, etag };
}

export async function pushCommand(env: Env, cmd: Omit<DeviceCommand, 'id' | 'ts'>) {
  const cur = (await kvGet<DeviceCommand[]>(env, 'device:cmds'))?.value || [];
  const fresh = cur.filter((c) => Date.now() - Date.parse(c.ts) < 10 * 60_000);
  fresh.push({ ...cmd, id: crypto.randomUUID(), ts: nowIso() });
  await kvSet(env, 'device:cmds', fresh.slice(-10));
}
