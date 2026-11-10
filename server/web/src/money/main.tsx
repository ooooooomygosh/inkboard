// 记账 — the shared ledger page for two people (/m). Say what you spent; AI files it.
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import '../capture/capture.css';
import './money.css';

type Who = 'me' | 'partner';
type Fixed = { id: string; name: string; amount: number; currency: string; aud: number; periodZh: string; monthly: number; next: string | null; category: string; shared: boolean; who: Who };
type Entry = { id: string; day: string; amount: number; currency: string; aud: number; category: string; note: string; shared: number; who: Who; kind: string };
type Note = { id: string; from_who: Who; title: string; text: string; due: string | null; status: 'sent' | 'ack' | 'done' | 'later'; created_at: string; updated_at: string };
const QUICK = ['给我买杯奶茶', '抱抱我', '陪我散散步', '去倒垃圾', '今晚早点睡', '周末陪我看电影'];
const boot = (window as any).__BOOT__ as { who: Who; people: Record<Who, string> };
const OWNER = boot.people?.me || '我';
const STATUS: Record<Note['status'], string> = { sent: '已送达，等 TA 看到', ack: `${OWNER} 收到啦`, done: '做好啦', later: 'TA 说晚点' };
const whenOf = (due: string | null) => (due ? `${+due.slice(5, 7)}/${+due.slice(8, 10)}${due.includes('T') ? ' ' + due.slice(11, 16) : ''}` : '');
type M = {
  who: Who; people: Record<Who, string>; currency: string; month: string; today: string;
  total: number; shared: number; me: number; partner: number; todaySpent: number; fixedMonthly: number; forecast: number; balance: number;
  byCategory: { k: string; v: number }[]; fixed: Fixed[]; upcoming: Fixed[]; recent: Entry[];
  notes: Note[]; leftover?: string; changed?: number; error?: string;
};

// The partner's page wears the soft "cute" look; the owner can preview it with /m?cute=1.
// Mascot pictures: /mascot/header.png and /mascot/fab.png (put your own in public/custom/).
const CUTE = boot.who === 'partner' || new URLSearchParams(location.search).has('cute');
if (CUTE) document.documentElement.classList.add('cute');
const DRAFT = 'ib_money_draft';
const ls = { get: (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } } };
const SYM: Record<string, string> = { CNY: '¥', JPY: '¥', USD: '$', AUD: '$', CAD: '$', NZD: '$', SGD: '$', HKD: '$', TWD: '$', EUR: '€', GBP: '£', KRW: '₩' };
let BASE = 'CNY';
const sym = (c: string) => SYM[c] || c + ' ';
const money = (n: number, dp = 0) => `${sym(BASE)}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const cur = (n: number, c: string) => (c === BASE ? money(n, n % 1 ? 2 : 0) : `${c} ${n}`);
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

async function call(path: string, body?: any): Promise<M> {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login?next=/m'; throw new Error('login'); }
  const j: any = await r.json();
  if (!r.ok && !j.month) throw new Error(j.error || r.statusText);
  return j;
}

function App() {
  const [d, setD] = useState<M | null>(null);
  const [text, setText] = useState(() => ls.get(DRAFT));
  const [speaker, setSpeaker] = useState<Who>(boot.who);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; err?: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const load = () => call('/api/money').then(setD).catch((e) => setMsg({ t: String(e.message || e), err: true }));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { ls.set(DRAFT, text); }, [text]);

  async function say() {
    if (!text.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await call('/api/money/say', { text: text.trim(), who: speaker });
      setD(r);
      if (r.error) setMsg({ t: r.error, err: true });
      else if (!r.changed) setMsg({ t: '没听出金额，内容还在输入框里，可以补一句再发。', err: true });
      else { setText(''); ls.set(DRAFT, ''); setMsg({ t: r.leftover ? `记好了。没当成账的部分：${r.leftover}` : '记好了' }); }
    } catch (e: any) { setMsg({ t: '没发出去，内容已保留：' + (e.message || e), err: true }); }
    setBusy(false);
  }
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  async function sendNote(text: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    try { setD(await call('/api/money/notes', { text: text.trim() })); setNote(''); setSent(text.trim()); setTimeout(() => { setSheet(false); setSent(''); }, 1400); }
    catch (e: any) { setMsg({ t: '纸条没送出去：' + (e.message || e), err: true }); }
    setSending(false);
  }
  const del = async (id: string) => setD(await call(`/api/money/expenses/${id}/delete`, {}));
  const stop = async (f: Fixed) => { if (confirm(`停掉「${f.name}」？以后不再按周期计入。`)) setD(await call(`/api/money/recurring/${f.id}/stop`, {})); };
  const settleUp = async () => {
    if (!d || Math.abs(d.balance) < 0.01) return;
    const payer: Who = d.balance > 0 ? 'partner' : 'me';
    if (confirm(`${d.people[payer]} 已经转给 ${d.people[payer === 'partner' ? 'me' : 'partner']} ${money(d.balance, 2)}？记为结清。`)) setD(await call('/api/money/settle', { payer, amount: Math.abs(d.balance) }));
  };

  if (!d) return <main><div class="busy"><i />加载中…</div></main>;
  const P = d.people;
  BASE = d.currency || BASE;
  const owe = Math.abs(d.balance) < 0.5 ? null : d.balance > 0 ? `${P.partner} 应给 ${P.me}` : `${P.me} 应给 ${P.partner}`;
  const maxCat = Math.max(1, ...d.byCategory.map((c) => c.v));
  const recent = showAll ? d.recent : d.recent.slice(0, 8);

  return (
    <main class="money">
      <header>
        {CUTE ? <img class="mascot" src="/mascot/header.png" alt="" /> : null}
        <div>
          <div class="date">{CUTE ? `${+d.month.slice(5)} 月的小账本` : `${+d.month.slice(5)} 月 · ${P.me} & ${P.partner}`}</div>
          <h1>本月 {money(d.total)}</h1>
        </div>
        {d.who === 'me' ? <a class="edit" href="/c" aria-label="今天">↩</a> : null}
      </header>

      <section class="split">
        <div><span>{P.me}</span><b>{money(d.me)}</b></div>
        <div><span>{P.partner}</span><b>{money(d.partner)}</b></div>
        <div><span>共同</span><b>{money(d.shared)}</b></div>
      </section>
      <p class="sub">各自的数字 = 自己的花销 + 共同开销的一半 · 今天 {money(d.todaySpent)} · 预计本月 {money(d.forecast)}</p>

      <section class="composer">
        <div class="who">
          <span>谁在记</span>
          {(['me', 'partner'] as Who[]).map((w) => <button class={speaker === w ? 'on' : ''} onClick={() => setSpeaker(w)}>{P[w]}</button>)}
        </div>
        <textarea ref={ta} rows={3} value={text} placeholder="比如：午饭 18、一起买菜 63.5、房租每月 3000 下次 15 号"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); say(); } }} />
        <div class="row">
          <span class="hint">点键盘上的麦克风语音输入</span>
          <button class="go" disabled={!text.trim() || busy} onClick={say}>{busy ? '记账中…' : '记一笔'}</button>
        </div>
        {busy ? <div class="busy"><i />AI 正在整理…</div> : null}
        {msg ? <div class={msg.err ? 'err' : 'ok'}>{msg.t}</div> : null}
      </section>

      {owe ? (
        <section class="card owe">
          <div><div class="owe-t">{owe}</div><div class="owe-v">{money(d.balance, 2)}</div></div>
          <button onClick={settleUp}>已转账</button>
        </section>
      ) : null}

      {d.notes?.length ? (
        <section class="card notes">
          <h2>小纸条 <small>{CUTE ? `给 ${P.me} 的` : `来自 ${P.partner}`}</small></h2>
          <ul class="nt">
            {d.notes.slice(0, 6).map((n) => (
              <li class={`nt-${n.status}`}>
                <div class="nt-m"><b>{n.title}</b><span>{whenOf(n.due) ? `${whenOf(n.due)} · ` : ''}{STATUS[n.status]}</span></div>
                <i class="nt-dot" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section class="card">
        <h2>固定支出 <small>每月约 {money(d.fixedMonthly)}</small></h2>
        {d.fixed.length ? (
          <ul class="fixed">
            {d.fixed.map((f) => (
              <li>
                <div class="fx-main"><b>{f.name}</b><span>{f.periodZh} {cur(f.amount, f.currency)}{f.shared ? ' · 共同' : ` · ${P[f.who]}`}</span></div>
                <div class="fx-side"><b>{money(f.monthly)}<small>/月</small></b><span>{f.next ? `下次 ${md(f.next)}` : ''}</span></div>
                <button class="x" onClick={() => stop(f)} aria-label="停掉">×</button>
              </li>
            ))}
          </ul>
        ) : <p class="muted">说“房租每月 3000 我们一起”“Claude 每月 20 美元”，AI 会建成固定项，按周期自动计入。</p>}
      </section>

      {d.byCategory.length ? (
        <section class="card">
          <h2>本月花在哪</h2>
          <ul class="cats">{d.byCategory.map((c) => <li><span>{c.k}</span><i style={{ width: `${(c.v / maxCat) * 100}%` }} /><b>{money(c.v)}</b></li>)}</ul>
        </section>
      ) : null}

      <section class="card">
        <h2>最近 <small>记错了点 × 删掉重说</small></h2>
        {d.recent.length ? (
          <ul class="recent">
            {recent.map((e) => (
              <li class={e.kind === 'settle' ? 'settle' : ''}>
                <span class="r-d">{md(e.day)}</span>
                <div class="r-m"><b>{e.note || e.category}</b><span>{e.kind === 'settle' ? '结算' : `${e.category} · ${e.shared ? '共同 · ' : ''}${P[e.who]} 付`}</span></div>
                <span class="r-v">{cur(e.amount, e.currency)}{e.currency !== BASE ? <small>≈{money(e.aud, 2)}</small> : null}</span>
                <button class="x" onClick={() => del(e.id)} aria-label="删除">×</button>
              </li>
            ))}
          </ul>
        ) : <p class="muted">还没有记录。</p>}
        {d.recent.length > 8 ? <button class="more" onClick={() => setShowAll(!showAll)}>{showAll ? '收起' : `显示全部 ${d.recent.length} 条`}</button> : null}
      </section>
      {CUTE ? <button class="fab" onClick={() => setSheet(true)} aria-label={`给 ${P.me} 写小纸条`}><img src="/mascot/fab.png" alt="" /><span>使唤 {P.me}</span></button> : null}
      {sheet ? (
        <div class="sheet-bg" onClick={(e) => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div class="sheet">
            <img class="sheet-chick" src="/mascot/fab.png" alt="" />
            {sent ? <div class="sheet-sent"><b>送到啦！</b><span>{P.me} 的墨水屏马上会响一下</span></div> : (
              <>
                <h3>给 {P.me} 的小纸条</h3>
                <p class="sheet-sub">TA 会在墨水屏和手机上收到，还会进 TA 的待办和日程</p>
                <div class="chips">{QUICK.map((q) => <button onClick={() => sendNote(q)} disabled={sending}>{q}</button>)}</div>
                <textarea rows={2} value={note} placeholder="自己写：周六晚上 7 点陪我去吃火锅" onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
                <div class="row">
                  <button class="ghost" onClick={() => setSheet(false)}>算了</button>
                  <button class="go" disabled={!note.trim() || sending} onClick={() => sendNote(note)}>{sending ? '送纸条中…' : `交给 ${P.me}`}</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
