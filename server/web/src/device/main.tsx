import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DeviceCommand, StatePayload } from '../../../shared/types';
import '../common/board.css';
import './device.css';
import { Board, type Ctx, type Pomodoro } from '../common/widgets';
import { dayLabel, hm, md, weekday } from '../common/format';
import { WeatherIcon } from '../common/icons';

// ---------------------------------------------------------------- bridge
interface InkApi {
  heartbeat(): void; fullRefresh(): void; setMode(m: string): void; setFullRefreshMinutes(m: number): void; setPartialLimit(n: number): void;
  launch(pkg: string): void; openWifi(): void; openSettings(): void; menu(): void; reload(): void; serverUrl(): string;
  setTimezone(tz: string): void; setBrightness(v: number): void; update(url: string): void; reboot(): void; info(): string;
  setOrientation?(o: string): void; setLight?(b: number, w: number): boolean; setContrast?(l: number): void; setBatteryCare?(on: boolean, upper: number, lower: number): void; chime?(): void;
}
const w = window as any;
const native: InkApi | null = w.Ink || null;
const Ink: InkApi = native || {
  heartbeat() {}, fullRefresh() { console.log('[ink] full refresh'); }, setMode() {}, setFullRefreshMinutes() {}, setPartialLimit() {},
  launch(p) { console.log('[ink] launch', p); }, openWifi() {}, openSettings() {}, menu() {}, reload() { location.reload(); }, serverUrl() { return location.origin; },
  setTimezone() {}, setBrightness() {}, update() {}, reboot() {}, info() { return '{}'; },
};
const boot = w.__BOOT__ as { state: StatePayload & { etag: string }; preview?: boolean };
declare const __BUILD__: string;
/** A new frontend was deployed: reload once (rate-limited) so the reader never runs stale code. */
function checkBuild(s: any) {
  if (!s?.build || s.build === __BUILD__ || boot.preview) return;
  try {
    const last = +(localStorage.getItem('ib_reload_at') || 0);
    if (Date.now() - last < 120_000) return;
    localStorage.setItem('ib_reload_at', String(Date.now()));
  } catch { /* ignore */ }
  Ink.reload();
}

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or disabled */ } },
};

const deviceInfo = () => { try { return JSON.parse(Ink.info()); } catch { return {}; } };

function inNight(now: Date, start: string, end: string) {
  const m = now.getHours() * 60 + now.getMinutes();
  const p = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + (mm || 0); };
  const a = p(start), b = p(end);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// ---------------------------------------------------------------- night screen
function Night({ state, now }: { state: StatePayload; now: Date }) {
  const wx = Object.values(state.data).find((d: any) => d?.value?.daily)?.value as any;
  const cal = Object.values(state.data).find((d: any) => Array.isArray(d?.value) && d.value[0]?.start)?.value as any[] | undefined;
  const tomorrow = new Date(now.getTime() + (now.getHours() >= 12 ? 86400_000 : 0));
  const first = (cal || []).find((e) => !e.allDay && new Date(e.start).getDate() === tomorrow.getDate() && new Date(e.start) > now);
  const t = wx?.daily?.[now.getHours() >= 12 ? 1 : 0];
  return (
    <div class="night">
      <div class="night-time">{hm(now)}</div>
      <div class="night-date">{md(now)} {weekday(now)}</div>
      {t ? <div class="night-wx"><WeatherIcon name={t.icon} size={56} /><span>{dayLabel(new Date(t.d + 'T12:00'), now)} {t.text} {t.min}°~{t.max}°{t.pop >= 30 ? ` · 降水 ${t.pop}%` : ''}</span></div> : null}
      {first ? <div class="night-ev">{dayLabel(new Date(first.start), now)}第一件事：<b>{hm(new Date(first.start))} {first.title}</b></div> : null}
      <div class="night-hint">夜间模式 · 点击屏幕查看看板</div>
    </div>
  );
}

// ---------------------------------------------------------------- app
function App() {
  const [state, setState] = useState<StatePayload & { etag?: string }>(() => boot.state || ls.get('ib_state', null as any));
  const [pageId, setPageId] = useState<string>(() => ls.get('ib_page', state?.layout.pages[0].id));
  const [now, setNow] = useState(new Date());
  const [lastSync, setLastSync] = useState<number | null>(Date.now());
  const [offline, setOffline] = useState(false);
  const [device, setDevice] = useState<any>(deviceInfo);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [wake, setWake] = useState(0);                // night mode temporarily dismissed until this time
  const [pomodoro, setPomodoroState] = useState<Pomodoro | null>(() => ls.get('ib_pomo', null));
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const setPomodoro = (p: Pomodoro | null) => { setPomodoroState(p); ls.set('ib_pomo', p); lastTouch.current = Date.now(); };
  const etag = useRef<string | undefined>(boot.state?.etag);
  const lastTouch = useRef(Date.now());
  const layoutVersion = useRef(state?.layout.version);
  const pollTimer = useRef<any>(null);

  const layout = state.layout;
  const dev = layout.device;

  // --- polling
  async function poll() {
    clearTimeout(pollTimer.current);
    try {
      const r = await fetch('/api/device/state', { headers: etag.current ? { 'If-None-Match': `"${etag.current}"` } : {}, credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { Ink.reload(); return; }
      if (r.status === 200) {
        const s: any = await r.json();
        checkBuild(s);
        etag.current = s.etag;
        setState(s);
        setOverrides({});
        ls.set('ib_state', s);
      } else if (r.status !== 304) throw new Error(String(r.status));
      setOffline(false);
      setLastSync(Date.now());
    } catch {
      setOffline(true);
    }
    schedule();
  }
  function schedule() {
    const s = (window as any).__lastState as StatePayload | undefined;
    const d = s?.layout.device || dev;
    const night = d.night.enabled && inNight(new Date(), d.night.start, d.night.end);
    const sec = night ? 600 : s?.agentsActive ? d.activePollSec : d.pollSec;
    pollTimer.current = setTimeout(poll, Math.max(5, sec) * 1000);
  }
  (window as any).__lastState = state;

  useEffect(() => {
    schedule();
    // minute clock, aligned to the minute boundary so the time digits change exactly once per minute
    let t: any;
    const tick = () => { setNow(new Date()); Ink.heartbeat(); t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50); };
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    // per-second ticking only while an agent is running (elapsed timers)
    const sec = setInterval(() => { if ((window as any).__lastState?.agentsActive) setNow(new Date()); }, 15_000);
    const tele = setInterval(sendStatus, 5 * 60_000);
    setTimeout(sendStatus, 3000);
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    (window as any).inkResume = () => { setDevice(deviceInfo()); poll(); };
    (window as any).inkBack = () => goPage(layout.pages[0].id);
    (window as any).inkKey = (k: string) => stepPage(k === 'next' ? 1 : -1);
    return () => { clearTimeout(t); clearInterval(sec); clearInterval(tele); };
  }, []);

  // --- apply device settings when the layout changes
  useEffect(() => {
    Ink.setFullRefreshMinutes(dev.fullRefreshMin);
    Ink.setPartialLimit(dev.partialLimit || 0);
    if (dev.brightness >= 0) Ink.setBrightness(dev.brightness);
    if (dev.timezone && device.timezone && dev.timezone !== device.timezone) Ink.setTimezone(dev.timezone);
    if (Ink.setOrientation && layout.orientation) Ink.setOrientation(layout.orientation);
    if (layoutVersion.current !== layout.version) { layoutVersion.current = layout.version; setTimeout(() => Ink.fullRefresh(), 120); }
    if (!layout.pages.find((p) => p.id === pageId)) setPageId(layout.pages[0].id);
  }, [layout.version]);

  // --- remote commands from the Mac editor
  useEffect(() => {
    const done: string[] = ls.get('ib_cmds', []);
    const fresh = (state.commands || []).filter((c: DeviceCommand) => !done.includes(c.id));
    if (!fresh.length) return;
    ls.set('ib_cmds', [...done, ...fresh.map((c) => c.id)].slice(-50));
    for (const c of fresh) {
      if (boot.preview) continue;
      switch (c.cmd) {
        case 'reload': setTimeout(() => Ink.reload(), 300); break;
        case 'fullRefresh': Ink.fullRefresh(); break;
        case 'launch': if (c.arg) Ink.launch(c.arg); break;
        case 'menu': Ink.menu(); break;
        case 'update': if (c.arg) Ink.update(c.arg); break;
        case 'reboot': Ink.reboot(); break;
        case 'page': if (c.arg) goPage(c.arg); break;
        case 'focus': { const fp = layout.pages.find((p) => p.widgets.some((x) => x.type === 'focus')); if (fp) goPage(fp.id); if (c.arg === 'start') setPomodoro({ start: Date.now(), min: 25 }); break; }
      }
    }
  }, [state.etag]);

  // --- front light & contrast (re-evaluated every minute; only writes when the target changes)
  const lightKey = useRef('');
  useEffect(() => {
    if (boot.preview || !Ink.setLight) return;
    const L = dev.light;
    if (!L || L.mode === 'system') { lightKey.current = ''; return; }
    let target: [number, number] = [0, 0];
    if (L.mode === 'fixed') target = [L.brightness, L.warmth];
    if (L.mode === 'schedule') {
      const win = (L.schedule || []).find((x) => inNight(now, x.from, x.to));
      target = win ? [win.brightness, win.warmth] : [0, 0];
    }
    const key = target.join('/');
    if (key !== lightKey.current) { lightKey.current = key; Ink.setLight(target[0], target[1]); }
  }, [now.getHours(), now.getMinutes(), JSON.stringify(dev.light)]);
  useEffect(() => { if (!boot.preview && Ink.setContrast && dev.contrast >= 0) Ink.setContrast(dev.contrast); }, [dev.contrast]);
  useEffect(() => { if (!boot.preview && Ink.setBatteryCare && dev.battery) Ink.setBatteryCare(dev.battery.care, dev.battery.upper, dev.battery.lower); }, [JSON.stringify(dev.battery)]);

  // --- chime when something new and urgent needs the user (never at night)
  const seenUrgent = useRef<Set<string> | null>(null);
  useEffect(() => {
    const urgent: string[] = [];
    for (const d of Object.values(state.data)) for (const a of (Array.isArray(d?.value) ? d.value : [])) if (a && a.urgent && typeof a.id === 'string') urgent.push(a.id);
    if (seenUrgent.current === null) { seenUrgent.current = new Set(urgent); return; }
    const fresh = urgent.filter((id) => !seenUrgent.current!.has(id));
    urgent.forEach((id) => seenUrgent.current!.add(id));
    const nightNow = dev.night.enabled && inNight(new Date(), dev.night.start, dev.night.end);
    if (fresh.length && !nightNow && !boot.preview && (dev as any).chime !== false) Ink.chime?.();
  }, [state.etag]);

  // --- focus timer finished: one clean refresh so the "done" state reads crisply
  const pomoDone = !!pomodoro && now.getTime() >= pomodoro.start + pomodoro.min * 60_000;
  useEffect(() => { if (pomoDone) setTimeout(() => Ink.fullRefresh(), 100); }, [pomoDone]);

  // --- return to the first page after inactivity
  useEffect(() => {
    if (!dev.returnHomeSec || (pomodoro && !pomoDone)) return;
    const t = setInterval(() => {
      if (Date.now() - lastTouch.current > dev.returnHomeSec * 1000 && pageId !== layout.pages[0].id) goPage(layout.pages[0].id);
    }, 15_000);
    return () => clearInterval(t);
  }, [pageId, dev.returnHomeSec, pomodoro, pomoDone]);

  function sendStatus() {
    const info = deviceInfo();
    setDevice(info);
    if (boot.preview || !native) return;
    fetch('/api/device/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...info, page: ls.get('ib_page', '') }) }).catch(() => {});
  }

  function goPage(id: string) {
    lastTouch.current = Date.now();
    setPageId((cur) => {
      if (cur !== id) { ls.set('ib_page', id); setTimeout(() => Ink.fullRefresh(), 60); }
      return id;
    });
  }
  function stepPage(dir: number) {
    const pages = (window as any).__lastState.layout.pages;
    setPageId((cur) => {
      const i = pages.findIndex((p: any) => p.id === cur);
      const next = pages[(i + dir + pages.length) % pages.length].id;
      ls.set('ib_page', next); setTimeout(() => Ink.fullRefresh(), 60);
      return next;
    });
    lastTouch.current = Date.now();
  }

  async function toggleTask(id: string) {
    lastTouch.current = Date.now();
    // optimistic: flip locally right away (e-ink feedback), then sync
    const cur = findTask(id);
    setOverrides((o) => ({ ...o, [id]: !(o[id] ?? cur?.done) }));
    try { await fetch(`/api/device/tasks/${encodeURIComponent(id)}/toggle`, { method: 'POST' }); } catch { /* will reconcile on next poll */ }
    setTimeout(poll, 800);
  }
  function findTask(id: string) {
    for (const d of Object.values(state.data)) if (Array.isArray(d?.value)) { const t = d.value.find((x: any) => x && x.id === id && 'done' in x); if (t) return t; }
    return null;
  }

  function action(a: string) {
    lastTouch.current = Date.now();
    const [k, arg] = a.split(/:(.*)/);
    switch (k) {
      case 'launch': Ink.launch(arg); break;
      case 'fullRefresh': Ink.fullRefresh(); poll(); break;
      case 'reload': Ink.reload(); break;
      case 'menu': Ink.menu(); break;
      case 'wifi': Ink.openWifi(); break;
      case 'settings': Ink.openSettings(); break;
      case 'page': goPage(arg); break;
      case 'focus': { const fp = layout.pages.find((p) => p.widgets.some((x) => x.type === 'focus')); if (fp) goPage(fp.id); break; }
    }
  }

  // apply optimistic task overrides
  const data = useMemo(() => {
    if (!Object.keys(overrides).length) return state.data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(state.data)) {
      out[k] = Array.isArray(v?.value) && v.value.some((x: any) => x && x.id in overrides)
        ? { ...v, value: v.value.map((x: any) => (x && x.id in overrides ? { ...x, done: overrides[x.id] } : x)) } : v;
    }
    return out;
  }, [state.data, overrides]);

  // swipe left/right to change page
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => { const p = e.touches[0]; touch.current = { x: p.clientX, y: p.clientY, t: Date.now() }; lastTouch.current = Date.now(); };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const p = e.changedTouches[0]; const dx = p.clientX - s.x, dy = p.clientY - s.y;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 800) stepPage(dx < 0 ? 1 : -1);
  };

  const night = !boot.preview && dev.night.enabled && inNight(now, dev.night.start, dev.night.end) && Date.now() > wake && !(pomodoro && !pomoDone);
  const post = async (path: string, body?: any) => {
    lastTouch.current = Date.now();
    try { await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); } catch { /* retried by next poll */ }
    setTimeout(poll, 600);
  };
  const ctx: Ctx = { now, layout, pageId, setPage: goPage, toggleTask, action, device, lastSync, offline, preview: boot.preview, pomodoro, setPomodoro, post };

  if (night) {
    return <div class="screen" onClick={() => { setWake(Date.now() + 5 * 60_000); setTimeout(() => Ink.fullRefresh(), 60); }}><Night state={state} now={now} /></div>;
  }
  return (
    <div class="screen" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <Board layout={layout} pageId={pageId} data={data} ctx={ctx} width={size.w} height={size.h} />
      {offline ? <div class="offline-badge">离线 · 显示 {lastSync ? hm(new Date(lastSync)) : ''} 的数据</div> : null}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
