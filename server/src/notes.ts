// Little notes from the partner's ledger page to the board owner ("帮我买杯奶茶", "周六晚上陪我看电影").
// Each note becomes the owner's to-do, lands in "需要你" on the e-ink and the phone, and goes on the
// calendar when it names a time. The reply (收到啦 / 做好了 / 晚点) shows up on the partner's page.
import type { Layout } from '../shared/types';
import { localNow, parseTasks } from './ai';
import { peopleOf } from './money';
import { mergeCalendars } from './state';
import { Env, kvGet, kvSet, nowIso, uid } from './util';

export type NoteStatus = 'sent' | 'ack' | 'done' | 'later';
export const REPLIES: { label: string; status: NoteStatus }[] = [
  { label: '收到啦', status: 'ack' }, { label: '做好了', status: 'done' }, { label: '晚点', status: 'later' },
];

function tzOffsetMs(tz: string, utcMs: number) {
  const p: any = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/** "2026-11-14T19:30" in the user's time zone → ISO UTC. */
function localToIso(local: string, tz: string) {
  const [d, t] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, dd, hh, mm);
  return new Date(wall - tzOffsetMs(tz, wall - tzOffsetMs(tz, wall))).toISOString();
}

export async function sendNote(env: Env, layout: Layout, text: string, from: 'partner' | 'me' = 'partner') {
  const tz = layout.device.timezone;
  const today = localNow(tz).day;
  let title = text.trim().slice(0, 40), due: string | null = null;
  try {
    const t = (await parseTasks(env, text, tz))[0];
    if (t?.title) title = String(t.title).slice(0, 40);
    if (t?.due && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t.due)) due = t.due;
  } catch { /* keep the raw words */ }
  const id = 'n_' + uid(8), taskId = 't_' + uid(8), ts = nowIso();
  const who = peopleOf(layout)[from];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tasks (id, title, notes, due, done, source, sort, updated_at, day, priority) VALUES (?, ?, ?, ?, 0, 'partner', 0, ?, ?, 1)")
      .bind(taskId, `${who}：${title}`, text.slice(0, 500), due ? due.slice(0, 10) : null, ts, due ? due.slice(0, 10) : today),
    env.DB.prepare('INSERT INTO notes (id, from_who, text, title, due, status, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, from, text.slice(0, 500), title, due, 'sent', taskId, ts, ts),
  ]);
  if (due && due.includes('T')) {
    // a time was named: put it on the calendar so the planner, the focus page and the 7-day view see it
    const start = localToIso(due, tz);
    const ev = (await kvGet<any[]>(env, 'partner:events'))?.value || [];
    const keep = ev.filter((e) => Date.parse(e.end) > Date.now() - 2 * 86400_000);
    keep.push({ title: `${who}：${title}`, start, end: new Date(Date.parse(start) + 3600_000).toISOString(), allDay: false, calendar: who, noteId: id });
    await kvSet(env, 'partner:events', keep);
    await mergeCalendars(env);
  }
  return id;
}

export async function listNotes(env: Env) {
  return (await env.DB.prepare('SELECT id, from_who, title, text, due, status, created_at, updated_at FROM notes ORDER BY created_at DESC LIMIT 12').all<any>()).results;
}

export async function replyNote(env: Env, id: string, status: NoteStatus) {
  const n = await env.DB.prepare('SELECT task_id FROM notes WHERE id = ?').bind(id).first<any>();
  if (!n) return;
  const ts = nowIso();
  const st: D1PreparedStatement[] = [env.DB.prepare('UPDATE notes SET status = ?, updated_at = ? WHERE id = ?').bind(status, ts, id)];
  if (status === 'done' && n.task_id) st.push(env.DB.prepare('UPDATE tasks SET done = 1, done_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, n.task_id));
  await env.DB.batch(st);
}

/** The owner ticked the to-do on the board or phone: tell the partner it's done (or not, if it gets un-ticked). */
export async function syncNoteFromTask(env: Env, taskId: string, done: boolean) {
  await env.DB.prepare("UPDATE notes SET status = ?, updated_at = ? WHERE task_id = ? AND (status != 'done' OR ? = 0)").bind(done ? 'done' : 'ack', nowIso(), taskId, done ? 1 : 0).run();
}
