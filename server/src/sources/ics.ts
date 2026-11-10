// Minimal iCalendar reader for a Google "secret address in iCal format".
// Supports DTSTART/DTEND with TZID or UTC, all-day events, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY,
// INTERVAL, COUNT, UNTIL, BYDAY for weekly) and EXDATE. Good enough for personal calendars.
import type { CalEvent } from './google';

function unfold(text: string) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function tzOffsetMs(tz: string, utcMs: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p: any = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

// Outlook / Exchange exports Windows time-zone names; Intl only knows IANA names.
const WIN_TZ: Record<string, string> = {
  'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane', 'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin', 'W. Australia Standard Time': 'Australia/Perth', 'Tasmania Standard Time': 'Australia/Hobart',
  'China Standard Time': 'Asia/Shanghai', 'Taipei Standard Time': 'Asia/Taipei', 'Singapore Standard Time': 'Asia/Singapore', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'India Standard Time': 'Asia/Kolkata', 'New Zealand Standard Time': 'Pacific/Auckland',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
};
let defaultTz = 'UTC';
function ianaTz(tz: string) {
  const t = tz.replace(/^"|"$/g, '').trim();
  if (WIN_TZ[t]) return WIN_TZ[t];
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } catch { return defaultTz; }
}

/** Parse "20261110T100000" in TZID (or Z) into epoch ms. */
interface Dt { ms: number; allDay: boolean; wall: number; tz: string }
function wallToMs(wall: number, tz: string) {
  if (tz === 'UTC') return wall;
  try {
    const off = tzOffsetMs(tz, wall);
    return wall - tzOffsetMs(tz, wall - off);
  } catch {
    return wall;
  }
}
function parseDt(val: string, params: string): Dt {
  if (/VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(val)) {
    const w = Date.UTC(+val.slice(0, 4), +val.slice(4, 6) - 1, +val.slice(6, 8));
    return { ms: w, allDay: true, wall: w, tz: 'UTC' };
  }
  const y = +val.slice(0, 4), mo = +val.slice(4, 6) - 1, d = +val.slice(6, 8), h = +val.slice(9, 11), mi = +val.slice(11, 13), s = +val.slice(13, 15) || 0;
  const wall = Date.UTC(y, mo, d, h, mi, s);
  if (val.endsWith('Z')) return { ms: wall, allDay: false, wall, tz: 'UTC' };
  const raw = /TZID=("[^"]+"|[^;:]+)/.exec(params)?.[1];
  const tz = raw ? ianaTz(raw) : defaultTz;
  return { ms: wallToMs(wall, tz), allDay: false, wall, tz };
}

/** "Microsoft Teams Meeting; https://teams…" → "Teams"; bare links → the service name. */
function shortPlace(v?: string) {
  if (!v) return undefined;
  const online = /teams\.microsoft|Microsoft Teams/i.test(v) ? 'Teams' : /zoom\./i.test(v) ? 'Zoom' : /meet\.google/i.test(v) ? 'Meet' : '';
  const rest = v.replace(/https?:\/\/\S+/g, '').replace(/Microsoft Teams (Meeting|会议|會議)|Zoom Link:?|Online meeting/gi, '').replace(/[;,\s]+/g, ' ').trim();
  return [rest, online].filter(Boolean).join(' · ') || undefined;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseIcs(text: string, fromMs: number, toMs: number, calName?: string, tz = 'UTC'): CalEvent[] {
  defaultTz = tz; // floating times (no TZID, no Z) are local to the user
  const out: CalEvent[] = [];
  const lines = unfold(text).split(/\r?\n/);
  type Ev = Record<string, { v: string; p: string }[]>;
  const all: Ev[] = [];
  let ev: Ev | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') {
      if (ev) all.push(ev);
      ev = null; continue;
    }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), v = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    (ev[name] ||= []).push({ v, p: ps.join(';') });
  }
  // Moved / edited single occurrences of a series (Outlook writes these a lot): drop the original
  // instance and show the override at its new time instead.
  const moved = new Map<string, Set<number>>();
  for (const e of all) if (e['RECURRENCE-ID'] && e.UID) {
    const r = e['RECURRENCE-ID'][0];
    const set = moved.get(e.UID[0].v) || new Set<number>();
    set.add(parseDt(r.v, r.p).ms); moved.set(e.UID[0].v, set);
  }
  for (const e of all) expand(e);

  function expand(e: Record<string, { v: string; p: string }[]>) {
    if (!e.DTSTART) return;
    if ((e.STATUS?.[0]?.v || '') === 'CANCELLED' || /^(Canceled|Cancelled|已取消)[:：]/.test(e.SUMMARY?.[0]?.v || '')) return;
    if (e['RECURRENCE-ID']) { e = { ...e }; delete e.RRULE; }
    const st = parseDt(e.DTSTART[0].v, e.DTSTART[0].p);
    const en = e.DTEND ? parseDt(e.DTEND[0].v, e.DTEND[0].p) : { ms: st.ms + (st.allDay ? 86400_000 : 3600_000), allDay: st.allDay };
    const dur = en.ms - st.ms;
    const title = (e.SUMMARY?.[0]?.v || '（无标题）').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
    const location = shortPlace(e.LOCATION?.[0]?.v?.replace(/\\([,;\\])/g, '$1'));
    const ex = new Set((e.EXDATE || []).flatMap((x) => x.v.split(',').map((vv) => parseDt(vv, x.p).ms)));
    if (!e['RECURRENCE-ID'] && e.UID) for (const t of moved.get(e.UID[0].v) || []) ex.add(t);
    const push = (ms: number) => {
      if (ex.has(ms)) return;
      if (ms + dur < fromMs || ms > toMs) return;
      const iso = (t: number) => (st.allDay ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString());
      out.push({ title, start: iso(ms), end: iso(ms + dur), allDay: st.allDay, location, calendar: calName });
    };
    const rr = e.RRULE?.[0]?.v;
    if (!rr) { push(st.ms); return; }
    const r: Record<string, string> = Object.fromEntries(rr.split(';').map((kv) => kv.split('=') as [string, string]));
    const interval = +(r.INTERVAL || 1);
    const until = r.UNTIL ? parseDt(r.UNTIL, '').ms : Infinity;
    const count = r.COUNT ? +r.COUNT : Infinity;
    const byday = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))) : null;
    let n = 0;
    const at = (w: number) => wallToMs(w, st.tz); // step in wall time, convert each occurrence
    const cur = new Date(st.wall);
    for (let guard = 0; guard < 2000 && n < count; guard++) {
      const t = cur.getTime();
      if (at(t) > until || at(t) > toMs) break;
      if (r.FREQ === 'WEEKLY' && byday) {
        const weekStart = t;
        for (let k = 0; k < 7 && n < count; k++) {
          const dt = weekStart + k * 86400_000;
          if (at(dt) > until || at(dt) > toMs) break;
          if (byday.includes(new Date(dt).getUTCDay())) { n++; push(at(dt)); }
        }
        cur.setTime(weekStart + 7 * interval * 86400_000);
        continue;
      }
      n++; push(at(t));
      if (r.FREQ === 'DAILY') cur.setUTCDate(cur.getUTCDate() + interval);
      else if (r.FREQ === 'WEEKLY') cur.setUTCDate(cur.getUTCDate() + 7 * interval);
      else if (r.FREQ === 'MONTHLY') cur.setUTCMonth(cur.getUTCMonth() + interval);
      else if (r.FREQ === 'YEARLY') cur.setUTCFullYear(cur.getUTCFullYear() + interval);
      else break;
    }
  }
  return out;
}
