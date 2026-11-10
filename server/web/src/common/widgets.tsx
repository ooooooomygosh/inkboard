import type { AgentSession, Layout, QuotaProvider, Widget } from '../../../shared/types';
import { AgentGlyph, Battery, Check, Spark, WeatherIcon, Wifi } from './icons';
import { ago, cnBig, dayLabel, dur, durWords, fmtNum, greeting, hm, isoWeek, lunar, md, mdSlash, resetLabel, sameDay, until, usd, weekShort, weekday } from './format';

export interface Pomodoro { start: number; min: number }

export interface Ctx {
  now: Date;
  layout: Layout;
  pageId: string;
  setPage: (id: string) => void;
  toggleTask: (id: string) => void;
  action: (a: string) => void;
  device: any;              // Ink.info()
  lastSync: number | null;  // epoch ms of last successful poll
  offline: boolean;
  preview?: boolean;
  pomodoro?: Pomodoro | null;
  setPomodoro?: (p: Pomodoro | null) => void;
  post?: (path: string, body?: any) => Promise<void>;   // device actions (answer, feedback, mail done)
}

export interface Box { w: number; h: number }

const DEFAULT_TITLES: Record<string, string> = {
  clock: '时间', weather: '天气', agents: '正在运行', quotas: 'AI 额度', calendar: '今日日程', tasks: '待办', memo: '备忘',
  markets: '行情', money: '记账', deadlines: '截止日', github: 'GitHub', text: '', nav: '', status: '状态', focus: '',
};

const TITLE_H = 34;
const titleH = (w: Widget) => (w.hideTitle ? 0 : TITLE_H);

function Title({ w, right, ctx, fallback }: { w: Widget; right?: any; ctx: Ctx; fallback?: string }) {
  if (w.hideTitle) return null;
  const t = w.title || fallback || DEFAULT_TITLES[w.type];
  if (!t) return null;
  return (
    <div class={`wt wts-${ctx.layout.theme.titleStyle}`}>
      <span class="wt-l">{t}</span>
      <span class="wt-rule" />
      {right ? <span class="wt-r">{right}</span> : null}
    </div>
  );
}

const Empty = ({ main, sub }: { main: string; sub?: string }) => (
  <div class="empty"><div class="empty-m">{main}</div>{sub ? <div class="empty-s">{sub}</div> : null}</div>
);

const staleTag = (at: string | null | undefined, now: Date, maxMin: number) =>
  at && now.getTime() - Date.parse(at) > maxMin * 60_000 ? <span class="stale">{ago(at, now.getTime())}</span> : null;

// ================================================================ clock
function ClockW({ w, ctx, box }: { w: Widget; ctx: Ctx; box: Box }) {
  const d = ctx.now;
  const timeSize = Math.max(40, Math.min(box.h - 62, box.w / 2.55));
  const sub = [lunar(d) && `农历${lunar(d)}`, w.props.showWeek !== false && `第 ${isoWeek(d)} 周`].filter(Boolean).join(' · ');
  return (
    <div class="clock">
      <div class="clock-top">
        <span class="clock-date">{md(d)} {weekday(d)}</span>
        <span class="clock-sub">{sub}</span>
      </div>
      <div class="clock-time disp" style={{ fontSize: `${timeSize}px`, fontWeight: ctx.layout.theme.clockWeight || 300 }}>{hm(d)}</div>
      {w.props.greeting !== false && box.h - timeSize > 90 ? <div class="clock-greet">{greeting(d)}</div> : null}
    </div>
  );
}

// ================================================================ weather
function WeatherW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value;
  const name = d?.name || w.props.name;
  if (!v) return <><Title w={w} ctx={ctx} /><Empty main={d?.error ? '天气暂不可用' : '天气加载中'} sub={d?.error} /></>;
  const today = v.daily[0];
  const avail = box.h - titleH(w);
  const showDays = Math.max(0, +w.props.days || 0);
  const hoursProp = +w.props.hours || 0;
  const topH = Math.min(118, Math.max(70, avail * (hoursProp || showDays ? 0.38 : 0.52)));
  const restH = avail - topH - 40;
  const hours = hoursProp > 0 ? hoursProp : restH >= 70 ? Math.max(3, Math.min(8, Math.floor(box.w / 76))) : 0;
  const icon = Math.round(topH * 0.66);
  return (
    <>
      <Title w={w} ctx={ctx} right={staleTag(d.at, ctx.now, 90)} />
      <div class="wx-now" style={{ height: `${topH}px` }}>
        <WeatherIcon name={v.now.icon} size={icon} />
        <div class="wx-temp disp" style={{ fontSize: `${topH * 0.86}px` }}>{v.now.temp}<span class="deg">°</span></div>
        <div class="wx-meta">
          <div class="wx-place">{name}</div>
          <div class="wx-cond">{v.now.text} · 体感 {v.now.feels}°</div>
          <div class="wx-range num">{today.min}° / {today.max}°{today.pop >= 10 ? <span> · 降水 {today.pop}%</span> : null}</div>
        </div>
      </div>
      <div class="wx-sum">{v.summary}{today.sunset ? ` · 日落 ${today.sunset}` : ''}</div>
      {hours && restH >= 60 ? (
        <div class="wx-hours">
          {v.hourly.slice(1, hours + 1).map((h: any) => (
            <div class="wx-h">
              <span class="wx-h-t num">{h.t.slice(11, 13)}</span>
              <WeatherIcon name={h.icon} size={28} />
              <span class="wx-h-v num">{h.temp}°</span>
              <span class="wx-h-p num">{h.pop >= 20 ? `${h.pop}%` : ' '}</span>
            </div>
          ))}
        </div>
      ) : null}
      {showDays ? (
        <div class="wx-days">
          {v.daily.slice(1, showDays + 1).map((x: any) => (
            <div class="wx-d">
              <span class="wx-d-n">{dayLabel(new Date(x.d + 'T12:00:00'), ctx.now)}</span>
              <WeatherIcon name={x.icon} size={28} />
              <span class="wx-d-t">{box.w > 360 ? x.text : ''}</span>
              <span class="wx-d-r num">{x.min}° / {x.max}°</span>
              <span class="wx-d-p num">{x.pop >= 20 ? `${x.pop}%` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

// ================================================================ agents
const STATE_LABEL: Record<string, string> = { running: '运行中', waiting: '等你确认', idle: '空闲', done: '已完成', stale: '无响应' };

function AgentRow({ a, ctx, showHost }: { a: AgentSession; ctx: Ctx; showHost: boolean }) {
  const now = ctx.now.getTime();
  const running = a.state === 'running' || a.state === 'waiting';
  const elapsed = a.turnStartedAt ? (now - Date.parse(a.turnStartedAt)) / 1000 : 0;
  const right = running ? dur(elapsed) : a.state === 'done' ? durWords(a.lastTurnSec || 0) : ago(a.updatedAt, now);
  const line2 = a.state === 'waiting' ? a.message || '需要你确认一个操作' : a.step || a.message || (a.state === 'done' ? '本轮已完成' : a.title || '等待指令');
  const meta = [a.toolCalls ? `${a.toolCalls} 步` : '', showHost ? a.host : ''].filter(Boolean).join(' · ');
  return (
    <div class={`ag ag-${a.state}`}>
      <AgentGlyph tool={a.tool} />
      <div class="ag-m">
        <div class="ag-1"><span class="ag-proj">{a.title || a.project || '未知项目'}</span>{a.branch ? <span class="ag-br">{a.branch}</span> : null}</div>
        <div class="ag-2">{line2}</div>
      </div>
      <div class="ag-r">
        <span class="ag-time num">{right}</span>
        <span class="ag-st">{STATE_LABEL[a.state]}{meta ? ` · ${meta}` : ''}</span>
      </div>
    </div>
  );
}

function AgentsW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: AgentSession[] = d?.value || [];
  const fit = Math.max(1, Math.floor((box.h - titleH(w) + 8) / 66));
  const active = list.filter((a) => a.state === 'running' || a.state === 'waiting').length;
  return (
    <>
      <Title w={w} ctx={ctx} right={active ? `${active} 个进行中` : list.length ? '全部空闲' : ''} />
      {list.length ? (
        <div class="ag-list">{list.slice(0, Math.min(fit, +w.props.max || 9)).map((a) => <AgentRow a={a} ctx={ctx} showHost={w.props.showHost !== false} />)}</div>
      ) : (
        <Empty main="此刻没有 Agent 在运行" sub="Claude Code 和 Codex 开始干活后会出现在这里" />
      )}
    </>
  );
}

// ================================================================ quotas
function Bar({ pct }: { pct: number | null }) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return <span class={`bar ${p >= 90 ? 'bar-hot' : ''}`}><span class="bar-fill" style={{ width: `${p}%` }} /></span>;
}

function QuotaRow({ q, ctx }: { q: QuotaProvider; ctx: Ctx; compact?: boolean }) {
  const stale = ctx.now.getTime() - Date.parse(q.capturedAt) > 3 * 3600_000;
  const wins = q.windows.filter((x) => x.usedPct != null);
  const main = wins.length ? wins.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a)) : null;
  const hot = (main?.usedPct ?? 0) >= 90;
  return (
    <div class={`qt ${hot ? 'qt-hot' : ''}`}>
      <div class="qt-name">
        <span class="qt-p">{q.label}</span>
        <span class="qt-plan">{q.plan}{stale ? ` · ${ago(q.capturedAt, ctx.now.getTime())}` : ''}</span>
      </div>
      <div class="qt-r">
        {main ? <span class="qt-big disp"><small>剩余</small>{Math.round(100 - (main.usedPct ?? 0))}<small>%</small></span> : q.balance ? <span class="qt-big disp">{q.balance}</span> : <span class="qt-reset">{q.credits || '无数据'}</span>}
        {!main && q.today ? <span class="qt-reset">今日 {q.today}</span> : null}
        {main ? <span class="qt-reset">{wins.map((x) => `${x.label} ${Math.round(x.usedPct ?? 0)}%`).join(' · ')} · {main.pace && main.pace.willLast === false && main.pace.etaSec ? `${durWords(main.pace.etaSec)}后用完` : resetLabel(main.resetsAt, ctx.now)}</span> : null}
      </div>
    </div>
  );
}

function QuotasW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value || { providers: [], balances: [] };
  const compact = !!w.props.compact || box.w < 520;
  const rowH = 64;
  const balH = v.balances.length ? 38 : 0;
  const fit = Math.max(1, Math.floor((box.h - titleH(w) - balH) / rowH));
  return (
    <>
      <Title w={w} ctx={ctx} right={d?.at ? ago(d.at, ctx.now.getTime()) : ''} />
      {v.providers.length ? (
        <div class="qt-list">{v.providers.slice(0, fit).map((q: QuotaProvider) => <QuotaRow q={q} ctx={ctx} compact={compact} />)}</div>
      ) : (
        <Empty main="等待 Mac 上传额度" sub="Mac 上的采集器每 3 分钟同步一次" />
      )}
      {v.balances.length ? (
        <div class="bal">
          {v.balances.map((b: any) => <span class={`bal-i ${b.error ? 'bal-err' : ''}`}><span class="bal-l">{b.label}</span><b class="num">{b.value}</b></span>)}
        </div>
      ) : null}
    </>
  );
}

// ================================================================ calendar
function CalendarW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const events: any[] = d?.value || [];
  const days = Math.max(1, +w.props.days || 1);
  const now = ctx.now;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).getTime();
  const evs = events.filter((e) => {
    const s = e.allDay ? new Date(e.start + 'T00:00:00') : new Date(e.start);
    const en = e.allDay ? new Date(e.end + 'T00:00:00') : new Date(e.end);
    return en.getTime() > now.getTime() - (e.allDay ? 0 : 30 * 60_000) && s.getTime() < end;
  });
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 44));
  const rows: any[] = [];
  let lastDay = '';
  for (const e of evs) {
    const s = e.allDay ? new Date(e.start + 'T00:00:00') : new Date(e.start);
    if (days > 1 && s.toDateString() !== lastDay) { rows.push({ head: /周/.test(dayLabel(s, now)) ? dayLabel(s, now) : `${dayLabel(s, now)} · ${weekShort(s)}` }); lastDay = s.toDateString(); }
    rows.push({ e, s });
  }
  const title = days > 1 ? `未来 ${days} 天` : undefined;
  if (d?.error && !d?.at) return <><Title w={w} ctx={ctx} fallback={title} /><Empty main="日程未连接" sub="在 Mac 编辑器“数据源”里连接 Google 日历" /></>;
  return (
    <>
      <Title w={w} ctx={ctx} fallback={title} right={evs.length ? `${evs.length} 项` : staleTag(d?.at, now, 30)} />
      {!evs.length ? <Empty main={days === 1 ? '今天没有日程' : `未来 ${days} 天没有日程`} sub="留给深度工作" /> : (
        <div class="cal">
          {rows.slice(0, fit).map((r) => r.head ? <div class="cal-h">{r.head}</div> : (() => {
            const e = r.e; const s: Date = r.s; const en = e.allDay ? null : new Date(e.end);
            const on = !e.allDay && s.getTime() <= now.getTime() && en!.getTime() > now.getTime();
            const soon = !e.allDay && !on && s.getTime() > now.getTime() && s.getTime() - now.getTime() < 30 * 60_000;
            return (
              <div class={`cal-e ${on ? 'cal-now' : ''}`}>
                <span class="cal-t num">{e.allDay ? '全天' : hm(s)}</span>
                <span class="cal-n">{e.title}</span>
                <span class="cal-x">{on ? `进行中 · 至 ${hm(en!)}` : soon ? `${Math.round((s.getTime() - now.getTime()) / 60000)} 分钟后` : e.location && box.w > 420 ? e.location.split(',')[0] : ''}</span>
              </div>
            );
          })())}
          {rows.length > fit ? <div class="more">还有 {rows.length - fit} 项</div> : null}
        </div>
      )}
    </>
  );
}

// ================================================================ tasks
function dueLabel(due: string | null | undefined, now: Date) {
  if (!due) return null;
  const dd = new Date(due.length <= 10 ? due + 'T23:59:00' : due);
  if (isNaN(dd.getTime())) return null;
  const overdue = dd.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { text: overdue ? `逾期 ${mdSlash(dd)}` : dayLabel(dd, now), hot: overdue || sameDay(dd, now) };
}

function TasksW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const narrow = box.w < 420;
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / (narrow ? 58 : 46)));
  return (
    <>
      <Title w={w} ctx={ctx} right={d?.total ? `${d.total} 项` : ''} />
      {!list.length ? <Empty main="没有待办" sub="在手机上打开 /c，把今天想做的事写下来" /> : (
        <div class="tk">
          {list.slice(0, fit).map((t) => {
            const due = dueLabel(t.due, ctx.now);
            return (
              <div class={`tk-i ${t.done ? 'tk-done' : ''} ${narrow ? 'tk-narrow' : ''} ${t.priority === 1 ? 'tk-p1' : ''}`} data-tap onClick={() => ctx.toggleTask(t.id)}>
                <Check on={t.done} size={24} />
                <span class="tk-t">{t.ai && !t.done ? <span class="tk-ai">AI</span> : null}{t.title}{narrow && due && !t.done ? <small class={due.hot ? 'tk-hot-s' : ''}> · {due.text}</small> : null}</span>
                {!narrow && due && !t.done ? <span class={`tk-due ${due.hot ? 'tk-hot' : ''}`}>{due.text}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ================================================================ memo
function MemoW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const one = box.h < 80;
  return (
    <>
      {one ? null : <Title w={w} ctx={ctx} />}
      {!list.length ? <Empty main="还没有备忘" sub="在 Mac 编辑器里写一条" /> : (
        <div class={`memo ${one ? 'memo-one' : ''}`}>
          {list.map((m) => <div class="memo-i">{one ? <span class="memo-tag">备忘</span> : null}<span class="memo-b">{m.body}</span></div>)}
        </div>
      )}
    </>
  );
}

// ================================================================ markets
function MarketsW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const avail = box.h - titleH(w);
  const spark = w.props.sparkline !== false && avail >= 100;
  const hasExt = list.some((q) => q.ext);
  const itemH = (spark ? 100 : avail >= 110 ? 62 : 34) + (hasExt && avail >= 110 ? 18 : 0);
  const rows = Math.max(1, Math.floor(avail / itemH));
  const cols = Math.max(1, Math.ceil(list.length / rows));
  const line = itemH === 34;
  const colW = cols >= 3 ? 0 : 999; // 3+ columns: too narrow for the price, show only the % move
  const chg = (q: any) => (q.changePct == null ? '' : `${q.changePct >= 0 ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%`);
  return (
    <>
      <Title w={w} ctx={ctx} right={staleTag(d?.at, ctx.now, 180)} />
      {!list.length ? <Empty main="行情加载中" sub={d?.error} /> : (
        <div class={`mk ${line ? 'mk-line' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {list.slice(0, rows * cols).map((q) => (
            <div class="mk-i">
              <span class="mk-l">{q.label}</span>
              <span class="mk-p num">{fmtNum(q.price)}</span>
              <span class={`mk-c num ${q.changePct != null && Math.abs(q.changePct) >= 2 ? 'mk-big' : ''}`}>{chg(q)}</span>
              {q.ext && !line ? <span class="mk-x num">{q.ext.session === 'pre' ? '盘前' : '盘后'}{colW >= 150 ? ` ${fmtNum(q.ext.price)} ` : ' '}{q.ext.changePct >= 0 ? '▲' : '▼'}{Math.abs(q.ext.changePct).toFixed(colW >= 150 ? 2 : 1)}%</span> : hasExt && !line ? <span class="mk-x"> </span> : null}
              {spark ? <Spark data={q.spark} w={Math.max(60, Math.min(260, box.w / cols - 28))} h={32} /> : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ================================================================ money (two people, one ledger)
function MoneyW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value;
  const SYM: Record<string, string> = { CNY: '¥', JPY: '¥', EUR: '€', GBP: '£', KRW: '₩' };
  const $ = (n: number) => `${SYM[v?.currency] || '$'}${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
  if (!v) return <><Title w={w} ctx={ctx} /><Empty main="还没有账" sub="在手机记账页说一句“午饭 18”就记上" /></>;
  const P = v.people;
  const owe = Math.abs(v.balance) < 0.5 ? null : v.balance > 0 ? `${P.partner} → ${P.me}` : `${P.me} → ${P.partner}`;
  const room = box.h - titleH(w);
  const n = Math.max(0, Math.min(+w.props.upcoming || 2, Math.floor((room - 150) / 34)));
  return (
    <>
      <Title w={w} ctx={ctx} right={`${+v.month.slice(5)} 月`} />
      <div class="mn">
        <div class="mn-top"><span class="mn-big disp">{$(v.total)}</span><span class="mn-cap">本月 · 今天 {$(v.todaySpent)}</span></div>
        <div class="mn-ppl">
          <div><span>{P.me}</span><b class="num">{$(v.me)}</b></div>
          <div><span>{P.partner}</span><b class="num">{$(v.partner)}</b></div>
          <div><span>共同</span><b class="num">{$(v.shared)}</b></div>
        </div>
        {owe ? <div class="mn-owe"><span>{owe}</span><b class="num">{$(v.balance)}</b></div> : null}
        {n ? v.upcoming.slice(0, n).map((f: any) => <div class="mn-up"><span>{f.name}</span><span class="num">{+f.next.slice(5, 7)}/{+f.next.slice(8)} · {$(f.aud)}</span></div>) : null}
      </div>
    </>
  );
}

// ================================================================ deadlines
function DeadlinesW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 52));
  return (
    <>
      <Title w={w} ctx={ctx} />
      {!list.length ? <Empty main="近期没有截止日" sub="下一轮会议 DDL 公布后自动出现" /> : (
        <div class="dl">
          {list.slice(0, fit).map((x) => {
            const u = until(x.at, ctx.now.getTime());
            const hot = Date.parse(x.at) - ctx.now.getTime() < 3 * 86400_000;
            const dt = new Date(x.at);
            return (
              <div class={`dl-i ${hot ? 'dl-hot' : ''}`}>
                <span class="dl-n"><b class="num">{u.n}</b><small>{u.unit}</small></span>
                <span class="dl-m"><span class="dl-t">{x.name}</span><span class="dl-d">{x.detail ? x.detail + ' · ' : ''}{mdSlash(dt)} {weekShort(dt)}</span></span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ================================================================ github
function GithubW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value;
  if (!v) return <><Title w={w} ctx={ctx} /><Empty main="GitHub 未连接" sub={d?.error || '在 Mac 编辑器“数据源”里填令牌'} /></>;
  const fit = Math.max(1, Math.floor((box.h - titleH(w) - 34) / 46));
  const ci = (s: string | null) => (s === 'SUCCESS' ? '✓' : s === 'FAILURE' || s === 'ERROR' ? '✗' : s === 'PENDING' || s === 'EXPECTED' ? '…' : '–');
  const repos: any[] = v.repos || [];
  const short = (r: string) => (r.startsWith(`${v.login}/`) ? r.slice(v.login.length + 1) : r);
  const items = [
    ...v.reviews.map((r: any) => ({ text: r.title, sub: `${short(r.repo)} #${r.number} · ${r.author}`, badge: '待 review', hot: true })),
    ...repos.filter((r) => r.ci === 'FAILURE' || r.ci === 'ERROR').map((r) => ({ text: `${short(r.repo)} 主分支 CI 失败`, sub: `${ago(r.pushedAt, ctx.now.getTime())}推送`, badge: 'CI ✗', hot: true })),
    ...repos.filter((r) => r.ci !== 'FAILURE' && r.ci !== 'ERROR').map((r) => ({ text: short(r.repo), sub: [`issue ${r.issues}`, `PR ${r.prs}`, `${ago(r.pushedAt, ctx.now.getTime())}推送`].join(' · '), badge: `CI ${ci(r.ci)}`, hot: false })),
  ];
  const issues = repos.reduce((s, r) => s + r.issues, 0), prs = repos.reduce((s, r) => s + r.prs, 0);
  return (
    <>
      <Title w={w} ctx={ctx} right={`@${v.login}`} />
      <div class="gh-sum"><span><b class="num">{v.reviewCount}</b> 待 review</span><span><b class="num">{issues}</b> issue</span><span><b class="num">{prs}</b> PR</span></div>
      {!items.length ? <Empty main="最近没有活跃的仓库" /> : (
        <div class="gh">
          {items.slice(0, fit).map((x) => (
            <div class={`gh-i ${x.hot ? 'gh-hot' : ''}`}><span class="gh-b">{x.badge}</span><span class="gh-t">{x.text}</span><span class="gh-s">{x.sub}</span></div>
          ))}
        </div>
      )}
    </>
  );
}

// ================================================================ focus
const toMinF = (hhmm: string) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
function FocusW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value || {};
  const now = ctx.now;
  const p = w.props;
  const pomo = ctx.pomodoro;
  const remain = pomo ? Math.max(0, Math.ceil((pomo.start + pomo.min * 60_000 - now.getTime()) / 60_000)) : 0;
  const pomoDone = !!pomo && remain === 0;
  const blocks: any[] = [];
  const nowM = now.getHours() * 60 + now.getMinutes();
  const pb = (v.planBlocks || []).map((b: any) => ({ ...b, s: toMinF(b.start), e: b.end ? toMinF(b.end) : toMinF(b.start) + 30 })).filter((b: any) => b.e > nowM);
  const curBlock = pb.find((b: any) => b.s <= nowM) || null;
  const nextBlock = pb.find((b: any) => b.s > nowM) || null;
  if (p.showEvent !== false && (curBlock || nextBlock)) {
    const b = curBlock || nextBlock;
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    blocks.push(
      <div class="fx-b">
        <span class="fx-k">{curBlock ? '按计划现在' : '下一段'}</span>
        <span class="fx-v">{b.title}</span>
        <span class="fx-s num">{curBlock ? `至 ${hh(b.e)} · 还剩 ${b.e - nowM} 分钟` : `${hh(b.s)} 开始 · ${b.s - nowM} 分钟后`}{curBlock && nextBlock ? ` · 接着 ${nextBlock.title}` : ''}</span>
      </div>,
    );
  } else if (p.showEvent !== false) {
    const e = (v.events || [])[0];
    const s = e ? new Date(e.start) : null;
    const on = !!e && s!.getTime() <= now.getTime();
    blocks.push(
      <div class="fx-b">
        <span class="fx-k">{on ? '正在进行' : '下一个日程'}</span>
        {e ? <><span class="fx-v">{e.title}</span><span class="fx-s num">{on ? `至 ${hm(new Date(e.end))}` : `${dayLabel(s!, now) === '今天' ? '' : dayLabel(s!, now) + ' '}${hm(s!)} · ${until(e.start, now.getTime()).n}${until(e.start, now.getTime()).unit}后`}</span></>
          : <><span class="fx-v fx-dim">今天没有了</span><span class="fx-s">整段时间都是你的</span></>}
      </div>,
    );
  }
  if (p.showTask !== false) {
    const t = (v.tasks || [])[0];
    blocks.push(
      <div class="fx-b" data-tap onClick={() => t && ctx.toggleTask(t.id)}>
        <span class="fx-k">{v.aiFocus ? 'AI 建议现在做' : '最重要的事'}</span>
        {v.aiFocus ? <><span class="fx-v">{v.aiFocus}</span><span class="fx-s">{t ? `待办：${t.title}` : '待办已清空'}</span></> : t ? <><span class="fx-v fx-task"><Check on={false} size={24} /> {t.title}</span><span class="fx-s">{v.taskCount > 1 ? `另有 ${v.taskCount - 1} 项待办` : '最后一项'}</span></>
          : <><span class="fx-v fx-dim">没有待办</span><span class="fx-s">干得漂亮</span></>}
      </div>,
    );
  }
  if (p.showAgents !== false) {
    const a: AgentSession | undefined = (v.agents || []).find((x: AgentSession) => x.state === 'waiting') || (v.agents || [])[0];
    const waiting = a?.state === 'waiting';
    blocks.push(
      <div class={`fx-b ${waiting ? 'fx-alert' : ''}`}>
        <span class="fx-k">{waiting ? 'Agent 等你确认' : 'Agent'}</span>
        {a ? <><span class="fx-v">{a.title || a.project}</span><span class="fx-s num">{waiting ? a.message || '需要批准' : `${a.step || '运行中'} · ${dur((now.getTime() - Date.parse(a.turnStartedAt || a.updatedAt)) / 1000)}`}</span></>
          : <><span class="fx-v fx-dim">全部空闲</span><span class="fx-s">没有运行中的任务</span></>}
      </div>,
    );
  }
  const wx = v.weather;
  const bigSize = Math.min(box.h * 0.5, box.w / 2.5);
  const onTime = () => {
    if (!ctx.setPomodoro) return;
    if (!pomo) ctx.setPomodoro({ start: Date.now(), min: Math.max(1, +p.pomodoroMin || 25) });
    else ctx.setPomodoro(null);
  };
  return (
    <div class="fx">
      <div class="fx-top">
        <span>{md(now)} {weekday(now)}<span class="fx-lunar"> · 农历{lunar(now)}</span></span>
        {p.showWeather !== false && wx ? (
          <span class="fx-wx"><WeatherIcon name={wx.now.icon} size={34} /><b class="num">{wx.now.temp}°</b><span>{wx.name} · {wx.now.text} · {wx.today.min}°/{wx.today.max}°</span></span>
        ) : null}
      </div>
      <div class="fx-mid" data-tap onClick={onTime}>
        {pomo && !pomoDone ? (
          <>
            <div class="fx-time disp" style={{ fontSize: `${bigSize}px` }}>{remain}<span class="fx-unit">分钟</span></div>
            <div class="fx-pomo">
              <span class="fx-bar"><span style={{ width: `${Math.min(100, ((now.getTime() - pomo.start) / (pomo.min * 60_000)) * 100)}%` }} /></span>
              <span class="num">专注中 · {hm(now)} · {hm(new Date(pomo.start + pomo.min * 60_000))} 结束 · 轻点结束</span>
            </div>
          </>
        ) : (
          <>
            <div class="fx-time disp" style={{ fontSize: `${bigSize}px` }}>{hm(now)}</div>
            <div class="fx-hint">{pomoDone ? `✓ 完成一个 ${pomo!.min} 分钟专注 · 轻点关闭` : `轻点时间，开始 ${+p.pomodoroMin || 25} 分钟专注`}</div>
          </>
        )}
      </div>
      {blocks.length ? <div class="fx-row" style={{ gridTemplateColumns: `repeat(${blocks.length}, 1fr)` }}>{blocks}</div> : null}
      <div class="fx-pages">
        {ctx.layout.pages.map((pg) => <span class={pg.id === ctx.pageId ? 'on' : ''} data-tap onClick={() => ctx.setPage(pg.id)}>{pg.name}</span>)}
      </div>
    </div>
  );
}

// ================================================================ header
function HeaderW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const now = ctx.now;
  const wx = d?.value?.weather;
  const tSize = Math.min(box.h * 0.92, 108);
  return (
    <div class="hd">
      <div class="hd-time disp" style={{ fontSize: `${tSize}px` }}>{hm(now)}</div>
      <div class="hd-date">
        <div class="hd-title">{w.props.title || d?.value?.headline || greeting(now)}</div>
        <div class="hd-sub">{md(now)} {weekday(now)} · 农历{lunar(now)} · 第 {isoWeek(now)} 周</div>
      </div>
      {w.props.showWeather !== false && wx ? (
        <div class="hd-wx">
          <WeatherIcon name={wx.now.icon} size={Math.min(64, box.h * 0.6)} />
          <div class="hd-temp disp">{wx.now.temp}°</div>
          <div class="hd-wxm">
            <div class="hd-place">{wx.name}</div>
            <div class="hd-cond">{wx.now.text} · {wx.today.min}°/{wx.today.max}°{wx.today.pop >= 20 ? ` · 雨 ${wx.today.pop}%` : ''}</div>
          </div>
        </div>
      ) : null}
      {w.props.showStatus !== false ? <StatusInline ctx={ctx} noTime /> : null}
    </div>
  );
}

// ================================================================ stat (KPI card)
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini' };
function MiniBars({ data, w, h }: { data: number[]; w: number; h: number }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const bw = w / data.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} class="ico minibars">
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * (h - 2));
        return <rect x={i * bw + 2} y={h - bh} width={Math.max(2, bw - 4)} height={bh} rx="1.5" fill={i === data.length - 1 ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" />;
      })}
    </svg>
  );
}

function StatW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const m = String(w.props.metric || '');
  const [kind, arg] = m.split(':');
  const v = d?.value;
  const big = Math.max(34, Math.min(box.h * 0.36, box.w * 0.3, 72));
  const label = w.title || ({ quota: `${v?.label || PROVIDER_LABEL[arg] || arg} 额度`, tokens: arg === 'all' ? '今日 Token' : `${arg === 'claude' ? 'Claude Code' : 'Codex'} 今日`, agents: 'Agent', needs: '需要你', mail: '邮件', tasks: '待办', deadline: '最近截止', balance: v?.label || arg } as any)[kind] || m;
  const head = (tag?: any) => <div class="kpi-h"><span class="kpi-l">{label}</span>{tag ? <span class="kpi-tag">{tag}</span> : null}</div>;
  const empty = (msg: string, sub?: string) => <div class="kpi">{head()}<div class="kpi-v disp kpi-dim" style={{ fontSize: `${big * 0.7}px` }}>—</div><div class="kpi-s">{msg}</div>{sub ? <div class="kpi-s">{sub}</div> : null}</div>;

  if (kind === 'quota') {
    if (!v) return empty('等待 Mac 上传');
    if (v.balance && !(v.windows || []).length) {
      return (
        <div class="kpi">
          {head(box.w >= 260 ? '余额' : undefined)}
          <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{v.balance}</div>
          {v.today ? <div class="kpi-s kpi-strong">今日 {v.today}</div> : null}
          <div class="kpi-s">{ago(v.capturedAt, ctx.now.getTime())}更新</div>
        </div>
      );
    }
    const wins = (v.windows || []).filter((x: any) => x.usedPct != null);
    if (!wins.length) return empty(v.credits || '暂无额度数据');
    const main = wins.reduce((a: any, b: any) => (b.usedPct > a.usedPct ? b : a));
    const others = wins.filter((x: any) => x !== main);
    const remaining = w.props.show !== 'used';
    const pct = remaining ? 100 - main.usedPct : main.usedPct;
    const hot = main.usedPct >= 90;
    const stale = ctx.now.getTime() - Date.parse(v.capturedAt) > 3 * 3600_000;
    return (
      <div class={`kpi ${hot ? 'kpi-hot' : ''}`}>
        {head(v.plan)}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}><small>{remaining ? '剩余' : '已用'}</small>{Math.round(pct)}<small>%</small></div>
        <div class="kpi-bar"><span style={{ width: `${Math.min(100, main.usedPct)}%` }} /></div>
        <div class="kpi-s">{main.label} 窗口 · {resetLabel(main.resetsAt, ctx.now)}</div>
        {main.pace && main.pace.willLast === false && main.pace.etaSec ? <div class="kpi-s kpi-strong">按当前速度 {durWords(main.pace.etaSec)}后用完</div> : null}
        {v.credits && hot ? <div class="kpi-s kpi-strong">{v.credits}</div> : null}
        {others.slice(0, 1).map((o: any) => <div class="kpi-s">{o.label} {remaining ? '剩余' : '已用'} {Math.round(remaining ? 100 - o.usedPct : o.usedPct)}% · {resetLabel(o.resetsAt, ctx.now)}</div>)}
        {stale ? <div class="kpi-s">{ago(v.capturedAt, ctx.now.getTime())}更新</div> : null}
      </div>
    );
  }
  if (kind === 'tokens') {
    const list: any[] = v?.providers || [];
    if (!list.length) return empty('等待 Mac 上传', 'Claude Code / Codex 本地日志');
    const today = list.reduce((s, p) => s + (p.today?.tokens || 0), 0);
    const cost = list.filter((p) => !p.currency || p.currency === '$').reduce((s, p) => s + (p.today?.cost || 0), 0);
    const dates = Array.from(new Set(list.flatMap((p) => p.daily.map((x: any) => x.date)))).sort().slice(-7);
    const series = dates.map((dt) => list.reduce((s, p) => s + (p.daily.find((x: any) => x.date === dt)?.tokens || 0), 0));
    const b = cnBig(today);
    const parts = arg === 'all' ? list.map((p) => `${p.label} ${cnBig(p.today?.tokens || 0).v}${cnBig(p.today?.tokens || 0).u}`).join(' · ') : `近 30 天 ${cnBig(list[0].last30Tokens).v}${cnBig(list[0].last30Tokens).u}`;
    return (
      <div class="kpi">
        {head(cost && box.w >= 230 ? `≈ ${usd(cost)}` : undefined)}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{b.v}<small>{b.u}</small></div>
        {cost && box.w < 230 ? <div class="kpi-s kpi-strong">≈ {usd(cost)} API 价</div> : null}
        <div class="kpi-s">{parts}</div>
        {box.h > 150 ? <div class="kpi-chart"><MiniBars data={series} w={Math.min(box.w - 36, 260)} h={Math.min(46, box.h * 0.22)} /><span class="kpi-cap">近 7 天</span></div> : null}
      </div>
    );
  }
  if (kind === 'agents') {
    const list: AgentSession[] = v?.list || [];
    const waiting = list.find((a) => a.state === 'waiting');
    const running = list.filter((a) => a.state === 'running');
    const top = waiting || running[0] || list[0];
    const now = ctx.now.getTime();
    return (
      <div class={`kpi ${waiting ? 'kpi-hot' : ''}`}>
        {head(list.length ? `${list.length} 个会话` : undefined)}
        <div class="kpi-v disp" style={{ fontSize: `${big * (waiting ? 0.82 : 1)}px` }}>
          {waiting ? '等你确认' : running.length ? <>{running.length}<small>个运行中</small></> : <span class="kpi-dim">空闲</span>}
        </div>
        {top ? <div class="kpi-s kpi-strong">{({ claude: 'Claude', codex: 'Codex', dsh: 'DSH' } as any)[top.tool] || top.tool} · {top.title || top.project}</div> : <div class="kpi-s">没有运行中的任务</div>}
        {top ? <div class="kpi-s mono">{waiting ? waiting.message : top.state === 'running' ? `${top.step || '思考中'} · ${dur((now - Date.parse(top.turnStartedAt || top.updatedAt)) / 1000)}` : top.state === 'done' ? `完成 · 用时 ${durWords(top.lastTurnSec || 0)}` : ago(top.updatedAt, now)}</div> : null}
      </div>
    );
  }
  if (kind === 'needs') {
    const n = v?.count || 0;
    const top = v?.top?.[0];
    return (
      <div class={`kpi ${v?.urgent ? 'kpi-hot' : ''}`}>
        {head(n ? '行动中心' : undefined)}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{n ? <>{n}<small>件要你</small></> : <span class="kpi-dim">清空</span>}</div>
        {top ? <div class="kpi-s kpi-strong">{top.title}</div> : v?.running ? <div class="kpi-s kpi-strong">{v.running} 个 AI 在跑，没在等你</div> : <div class="kpi-s">AI 和 Agent 都没在等你</div>}
        {top ? <div class="kpi-s">{top.source}{top.detail ? ` · ${top.detail}` : ''}</div> : null}
        {v?.running ? <div class="kpi-s">{top ? `在跑 ${v.running}：` : ''}{(v.runningTop || []).join('、')}</div> : null}
      </div>
    );
  }
  if (kind === 'mail') {
    if (!v?.connected) return empty('邮件没在同步', '检查邮件转寄规则和 Mac 上的 InkBoard');
    const top = v.top?.[0];
    return (
      <div class={`kpi ${v.count ? '' : ''}`}>
        {head(v.count ? 'AI 筛选' : undefined)}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{v.count ? <>{v.count}<small>封待处理</small></> : <span class="kpi-dim">清空</span>}</div>
        {top ? <div class="kpi-s kpi-strong">{top.sender.replace(/<.*>/, '').trim()}</div> : <div class="kpi-s">没有需要你处理的邮件</div>}
        {top ? <div class="kpi-s">{top.summary}</div> : v.syncedAt ? <div class="kpi-s">邮箱 · {ago(v.syncedAt, ctx.now.getTime())}同步</div> : null}
      </div>
    );
  }
  if (kind === 'tasks') {
    if (!v) return empty('没有待办');
    return (
      <div class="kpi">
        {head()}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{v.count}<small>项</small></div>
        {v.top.map((t: any) => <div class="kpi-s">· {t.title}</div>)}
      </div>
    );
  }
  if (kind === 'deadline') {
    if (!v) return empty('近期没有截止日');
    const u = until(v.at, ctx.now.getTime());
    const hot = Date.parse(v.at) - ctx.now.getTime() < 3 * 86400_000;
    return (
      <div class={`kpi ${hot ? 'kpi-hot' : ''}`}>
        {head()}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{u.n}<small>{u.unit}</small></div>
        <div class="kpi-s kpi-strong">{v.name}</div>
        <div class="kpi-s">{v.detail} · {mdSlash(new Date(v.at))}</div>
      </div>
    );
  }
  if (kind === 'balance') {
    if (!v) return empty('未配置 API key', '在“数据源”里填写');
    return (
      <div class="kpi">
        {head(v.sub)}
        <div class="kpi-v disp" style={{ fontSize: `${big}px` }}>{v.value}</div>
        <div class="kpi-s">{v.error ? '读取失败' : ago(v.capturedAt, ctx.now.getTime()) + '更新'}</div>
      </div>
    );
  }
  return empty('未知指标');
}

// ================================================================ today's plan (quick capture → AI)
const toMin = (hhmm: string) => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };

function PlanW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const plan = d?.value;
  const nowMin = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  // timeline = AI blocks + calendar events that the plan did not already include
  const rows: { start: number; end: number; title: string; kind: string }[] = [];
  for (const b of plan?.blocks || []) rows.push({ start: toMin(b.start), end: b.end ? toMin(b.end) : toMin(b.start) + 30, title: b.title, kind: b.kind || 'task' });
  for (const e of d?.events || []) {
    const s0 = new Date(e.start), e0 = new Date(e.end);
    if (s0.toDateString() !== ctx.now.toDateString()) continue;
    const sm = s0.getHours() * 60 + s0.getMinutes();
    if (rows.some((r) => Math.abs(r.start - sm) < 10 && r.kind === 'event')) continue;
    rows.push({ start: sm, end: e0.getHours() * 60 + e0.getMinutes(), title: e.title, kind: 'event' });
  }
  rows.sort((a, b) => a.start - b.start);
  const upcoming = rows.filter((r) => r.end > nowMin);
  const qs = w.props.showQuestions !== false ? plan?.questions || [] : [];
  const qH = qs.length ? 30 + qs.length * 58 : 0;
  const fit = Math.max(1, Math.floor((box.h - titleH(w) - (plan?.summary ? 30 : 0) - qH) / 40));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if (!plan && !rows.length) {
    return <><Title w={w} ctx={ctx} fallback="今日安排" /><Empty main="还没有今天的安排" sub="在手机上打开 /c，把今天想做的事一口气写下来" /></>;
  }
  return (
    <>
      <Title w={w} ctx={ctx} fallback="今日安排" right={plan?.updatedAt ? `AI · ${hm(new Date(plan.updatedAt))}` : ''} />
      {plan?.summary ? <div class="pl-sum">{plan.summary}</div> : null}
      <div class="pl">
        {upcoming.slice(0, fit).map((r) => {
          const on = r.start <= nowMin && r.end > nowMin;
          return (
            <div class={`pl-i pl-${r.kind} ${on ? 'pl-now' : ''}`}>
              <span class="pl-t num">{hhmm(r.start)}</span>
              <span class="pl-bar" />
              <span class="pl-n">{r.title}</span>
              <span class="pl-d num">{on ? `至 ${hhmm(r.end)}` : r.end > r.start ? `${r.end - r.start}′` : ''}</span>
            </div>
          );
        })}
        {!upcoming.length ? <div class="w-empty">今天剩下的时间都空着</div> : null}
      </div>
      {qs.length ? (
        <div class="pl-qs">
          {qs.map((q: any) => (
            <div class="pl-q">
              <div class="pl-qq">AI 想确认：{q.q}</div>
              <div class="pl-qo">{q.options.map((o: string) => <span data-tap onClick={() => ctx.post?.('/api/device/answer', { qid: q.id, answer: o })}>{o}</span>)}</div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

// ================================================================ mail (via the Mac, AI-triaged)
const ACTION_ZH: Record<string, string> = { reply: '回复', read: '阅读', deadline: '截止', meeting: '会议', none: '' };
function MailW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 58));
  if (!d?.connected) return <><Title w={w} ctx={ctx} fallback="重要邮件" /><Empty main="邮件没在同步" sub="检查邮件转寄规则，以及 Mac 上的 InkBoard 是否在运行" /></>;
  return (
    <>
      <Title w={w} ctx={ctx} fallback="重要邮件" right={list.length ? `${list.length} 封待处理` : ''} />
      {!list.length ? <Empty main="没有需要你处理的邮件" sub="AI 会把导师、截止和需要回复的邮件放在这里" /> : (
        <div class="ml">
          {list.slice(0, fit).map((m) => (
            <div class="ml-i" data-tap onClick={() => ctx.post?.(`/api/device/mail/${encodeURIComponent(m.id)}/done`)}>
              <span class={`ml-a ml-${m.action}`}>{ACTION_ZH[m.action] || '查看'}</span>
              <div class="ml-m">
                <div class="ml-s">{m.summary || m.subject}</div>
                <div class="ml-f">{String(m.sender || '').replace(/<.*>/, '').trim()} · {ago(m.received, ctx.now.getTime())}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ================================================================ action center
const KIND_LABEL: Record<string, string> = { agent: '批准', card: '拍板', notice: '通知', question: '确认', review: '成果', failed: '失败', mail: '邮件', deadline: '截止' };

function InboxW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 86));
  return (
    <>
      <Title w={w} ctx={ctx} fallback="需要你" right={list.length ? `${list.length} 件` : ''} />
      {!list.length ? <Empty main="没有需要你处理的事" sub="AI 提问、Agent 等批准、邮件、截止都会出现在这里" /> : (
        <div class="ib">
          {list.slice(0, fit).map((a) => (
            <div class={`ib-i ${a.urgent ? 'ib-urgent' : ''}`}>
              <div class="ib-h"><span class="ib-k">{KIND_LABEL[a.kind] || '事项'}</span><span class="ib-s">{a.source}</span></div>
              <div class="ib-t">{a.title}</div>
              {a.detail ? <div class="ib-d">{a.detail}</div> : null}
              {a.options?.length ? (
                <div class="ib-o">{a.options.slice(0, 4).map((o: string, i: number) => <span class={i === a.recommend ? 'rec' : ''} data-tap onClick={() => ctx.post?.(`/api/device/actions/${encodeURIComponent(a.id)}`, { choice: i })}>{o}</span>)}</div>
              ) : a.kind === 'agent' ? <div class="ib-d">去 Mac 上批准</div> : null}
            </div>
          ))}
          {list.length > fit ? <div class="more">还有 {list.length - fit} 件，在手机上看全部</div> : null}
        </div>
      )}
    </>
  );
}

function DoingW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const list: any[] = d?.value || [];
  const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 62));
  const now = ctx.now.getTime();
  return (
    <>
      <Title w={w} ctx={ctx} fallback="进行中" right={list.length ? `${list.length} 项` : ''} />
      {!list.length ? <Empty main="此刻没有进行中的事" sub="Claude Code、Codex、交给 AI 的代办和你当前的计划块会出现在这里" /> : (
        <div class="dg">
          {list.slice(0, fit).map((x) => (
            <div class={`dg-i dg-${x.kind} ${x.state === 'waiting' || x.state === '等你回答' ? 'dg-wait' : ''}`}>
              <span class="dg-src">{x.source}</span>
              <div class="dg-m"><div class="dg-t">{x.title}</div>{x.detail ? <div class="dg-d">{x.detail}</div> : null}</div>
              <div class="dg-r"><span class="dg-st">{x.state === 'running' ? '运行中' : x.state === 'waiting' ? '等你批准' : x.state}</span>{x.since ? <span class="dg-time num">{dur((now - Date.parse(x.since)) / 1000)}</span> : null}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ================================================================ AI (DeepSeek)
function AiW({ w, d, ctx, box }: { w: Widget; d: any; ctx: Ctx; box: Box }) {
  const v = d?.value;
  if (w.props.mode === 'papers') {
    const items: any[] = v?.items || [];
    const fit = Math.max(1, Math.floor((box.h - titleH(w)) / 78));
    return (
      <>
        <Title w={w} ctx={ctx} fallback="论文雷达" right={v?.generatedAt ? `按你的研究焦点 · ${ago(v.generatedAt, ctx.now.getTime())}${v.scanned ? ` · ${v.matched ?? '?'}/${v.scanned} 篇相关` : ''}` : ''} />
        {!items.length ? <Empty main={v?.note || '今天早上自动扫描 arXiv'} sub="DeepSeek 挑出与你研究最相关的 3 篇" /> : (
          <div class="pp">
            {items.slice(0, fit).map((x, i) => (
              <div class="pp-i">
                <span class="pp-n disp">{i + 1}</span>
                <div class="pp-m">
                  <div class="pp-t">{x.title}<span class="pp-why">{x.why}</span></div>
                  <div class="pp-g">{x.gist}</div>
                  <div class="pp-s">arXiv {x.id} · {(x.authors || []).slice(0, 2).join(', ')}{x.authors?.length > 2 ? ' 等' : ''}
                    <span class="pp-fb" data-tap onClick={() => ctx.post?.('/api/device/feedback', { target: 'paper', ref: x.id, vote: 1, note: x.en })}>有用</span>
                    <span class="pp-fb" data-tap onClick={() => ctx.post?.('/api/device/feedback', { target: 'paper', ref: x.id, vote: -1, note: x.en })}>无关</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Title w={w} ctx={ctx} fallback="今日简报" right={v?.generatedAt ? `AI · ${hm(new Date(v.generatedAt))}` : ''} />
      {!v ? <Empty main="简报生成中" sub="每天 6:30 / 12:00 / 17:30 自动更新" /> : (
        <div class="br">
          {v.focus ? <div class="br-focus"><span class="br-k">现在做</span><span class="br-f">{v.focus}</span></div> : null}
          <ul class="br-list">{(v.bullets || []).slice(0, box.h > 330 ? 3 : 2).map((b: string) => <li>{b}</li>)}</ul>
          {v.tip && box.h > 300 ? <div class="br-tip">{v.tip}</div> : null}
        </div>
      )}
    </>
  );
}

// ================================================================ text / nav / status
const TextW = ({ w }: { w: Widget }) => (
  <div class="txt" style={{ fontSize: `${+w.props.size || 22}px`, textAlign: w.props.align || 'center', fontWeight: w.props.bold ? 700 : 400 }}>{w.props.text}</div>
);

function StatusInline({ ctx, noTime }: { ctx: Ctx; noTime?: boolean }) {
  const dv = ctx.device || {};
  return (
    <span class="st">
      {dv.battery != null ? <span class="st-i"><Battery pct={dv.battery} charging={dv.charging} /><span class="num">{dv.battery}%</span></span> : null}
      <span class="st-i"><Wifi level={ctx.offline ? 0 : dv.wifiLevel ?? 4} />{ctx.offline ? '离线' : null}</span>
      {ctx.lastSync && !noTime ? <span class="st-i num">同步 {hm(new Date(ctx.lastSync))}</span> : null}
    </span>
  );
}

function NavW({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const pages = ctx.layout.pages;
  const buttons: any[] = Array.isArray(w.props.buttons) ? w.props.buttons : [];
  return (
    <div class="nav">
      {w.props.showPages !== false && pages.length > 1 ? (
        <div class="nav-pages">
          {pages.map((p) => <span class={`nav-p ${p.id === ctx.pageId ? 'on' : ''}`} data-tap onClick={() => ctx.setPage(p.id)}>{p.name}</span>)}
        </div>
      ) : <div />}
      <StatusInline ctx={ctx} />
      <div class="nav-btns">
        {buttons.map((b) => <span class="nav-b" data-tap onClick={() => ctx.action(b.action)}>{b.label}</span>)}
      </div>
    </div>
  );
}

// ================================================================ dispatcher
export function WidgetBody({ w, data, ctx, box }: { w: Widget; data: any; ctx: Ctx; box: Box }) {
  switch (w.type) {
    case 'clock': return <ClockW w={w} ctx={ctx} box={box} />;
    case 'weather': return <WeatherW w={w} d={data} ctx={ctx} box={box} />;
    case 'agents': return <AgentsW w={w} d={data} ctx={ctx} box={box} />;
    case 'quotas': return <QuotasW w={w} d={data} ctx={ctx} box={box} />;
    case 'money': return <MoneyW w={w} d={data} ctx={ctx} box={box} />;
    case 'calendar': return <CalendarW w={w} d={data} ctx={ctx} box={box} />;
    case 'tasks': return <TasksW w={w} d={data} ctx={ctx} box={box} />;
    case 'memo': return <MemoW w={w} d={data} ctx={ctx} box={box} />;
    case 'markets': return <MarketsW w={w} d={data} ctx={ctx} box={box} />;
    case 'deadlines': return <DeadlinesW w={w} d={data} ctx={ctx} box={box} />;
    case 'github': return <GithubW w={w} d={data} ctx={ctx} box={box} />;
    case 'focus': return <FocusW w={w} d={data} ctx={ctx} box={box} />;
    case 'header': return <HeaderW w={w} d={data} ctx={ctx} box={box} />;
    case 'stat': return <StatW w={w} d={data} ctx={ctx} box={box} />;
    case 'ai': return <AiW w={w} d={data} ctx={ctx} box={box} />;
    case 'plan': return <PlanW w={w} d={data} ctx={ctx} box={box} />;
    case 'mail': return <MailW w={w} d={data} ctx={ctx} box={box} />;
    case 'inbox': return <InboxW w={w} d={data} ctx={ctx} box={box} />;
    case 'doing': return <DoingW w={w} d={data} ctx={ctx} box={box} />;
    case 'text': return <TextW w={w} />;
    case 'nav': return <NavW w={w} ctx={ctx} />;
    case 'status': return <div class="st-wrap"><StatusInline ctx={ctx} /></div>;
    default: return <Empty main={`未知组件 ${w.type}`} />;
  }
}

/** Lays a page out on the CSS grid. Used by both the device and the editor canvas. */
export function Board({ layout, pageId, data, ctx, width, height, overlay }: {
  layout: Layout; pageId: string; data: Record<string, any>; ctx: Ctx; width: number; height: number;
  overlay?: (w: Widget, box: Box) => any;
}) {
  const page = layout.pages.find((p) => p.id === pageId) || layout.pages[0];
  const g = layout.grid;
  const colW = (width - 2 * g.padding - (g.cols - 1) * g.gap) / g.cols;
  const rowH = (height - 2 * g.padding - (g.rows - 1) * g.gap) / g.rows;
  const theme = layout.theme;
  const NOCARD = new Set(['header', 'nav', 'focus', 'text', 'status', 'clock']);
  return (
    <div class={`board ${theme.cards !== false ? 'cards' : ''} font-${theme.displayFont || 'smiley'}`} style={{
      width: `${width}px`, height: `${height}px`, padding: `${g.padding}px`, gap: `${g.gap}px`,
      gridTemplateColumns: `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, 1fr)`,
      fontSize: `${20 * (layout.theme.fontScale || 1)}px`,
    }}>
      {page.widgets.map((w) => {
        const pad = theme.cards !== false && !NOCARD.has(w.type) ? 30 : 0;
        const box = { w: w.w * colW + (w.w - 1) * g.gap - pad, h: w.h * rowH + (w.h - 1) * g.gap - pad };
        return (
          <div class={`wg wg-${w.type} ${theme.cards !== false && !NOCARD.has(w.type) ? 'card' : ''}`} key={w.id} data-wid={w.id} style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}>
            <WidgetBody w={w} data={data[w.id]} ctx={ctx} box={box} />
            {overlay ? overlay(w, box) : null}
          </div>
        );
      })}
    </div>
  );
}
