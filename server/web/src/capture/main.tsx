import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import './capture.css';

type Today = {
  day: string; now: string;
  plan: null | { summary: string; blocks: { start: string; end: string; title: string; kind?: string }[]; notes: string[]; questions: { id: string; q: string; options: string[] }[]; updatedAt: string; captures: number };
  tasks: { id: string; title: string; due?: string; done: number; priority?: number; est_min?: number; day?: string; source: string; ai_ok?: number; ai_how?: string }[];
  actions: { id: string; kind: string; title: string; detail?: string; source: string; options?: string[]; recommend?: number; urgent?: boolean }[];
  doing: { id: string; kind: string; title: string; detail?: string; source: string; state: string; since?: string }[];
  jobs: { id: string; task_id: string; title: string; status: string; summary?: string; result?: string; updated_at: string }[];
  captures: { id: string; text: string; ts: string }[];
  mails: { id: string; sender: string; subject: string; received: string; summary: string; action: string }[];
  events: { title: string; start: string; end: string; allDay?: boolean; location?: string }[];
  brief: null | { headline: string; focus: string; bullets: string[]; tip: string; generatedAt: string };
  research: null | { summary: string; questions: { q: string }[] };
  aiUsage: null | { calls: number; tokens: number };
  error?: string;
};

const DRAFT = 'ib_capture_draft';
const ls = { get: (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } } };

async function call(path: string, body?: any): Promise<Today> {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login?next=/c'; throw new Error('login'); }
  const j: any = await r.json();
  if (!r.ok && !j.day) throw new Error(j.error || r.statusText);
  return j;
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ACTION: Record<string, string> = { reply: '回复', read: '阅读', deadline: '截止', meeting: '会议', none: '' };
const PRI = ['', '要紧', '重要', ''];

function App() {
  const [data, setData] = useState<Today | null>(null);
  const [text, setText] = useState(() => ls.get(DRAFT));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const ta = useRef<HTMLTextAreaElement>(null);

  const load = () => call('/api/me/today').then(setData).catch((e) => setErr(String(e.message || e)));
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { ls.set(DRAFT, text); }, [text]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(window.innerHeight * 0.55, Math.max(140, el.scrollHeight)) + 'px'; } }, [text]);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy('AI 正在把这段话整理进今天的安排…'); setErr('');
    try {
      const d = await call('/api/me/capture', { text: text.trim() });
      setData(d); setText(''); ls.set(DRAFT, '');
      if (d.error) setErr(d.error);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) { setErr('没发出去，内容已保留在输入框：' + (e.message || e)); }
    setBusy(null);
  }
  async function answer(qid: string, a: string) {
    if (!a.trim()) return;
    setBusy('AI 正在按你的回答调整…');
    try { setData(await call('/api/me/answer', { qid, answer: a })); } catch (e: any) { setErr(String(e.message || e)); }
    setBusy(null);
  }
  const act = async (id: string, choice?: number, text?: string) => { setBusy(id.startsWith('q:') ? 'AI 正在按你的回答调整…' : null); try { setData(await call(`/api/me/actions/${encodeURIComponent(id)}`, { choice, text })); } catch (e: any) { setErr(String(e.message || e)); } setBusy(null); };
  const delegate = async (id: string) => { setData(await call(`/api/me/tasks/${encodeURIComponent(id)}/delegate`, {})); };
  const [openJob, setOpenJob] = useState<string | null>(null);
  const toggle = async (id: string) => { setData(await call(`/api/me/tasks/${encodeURIComponent(id)}/toggle`, {})); };
  const mailDone = async (id: string) => { setData(await call(`/api/me/mail/${encodeURIComponent(id)}/done`, {})); };

  const plan = data?.plan;
  const open = (data?.tasks || []).filter((t) => !t.done);
  const done = (data?.tasks || []).filter((t) => t.done);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };

  return (
    <main>
      <header>
        <div>
          <div class="date">{data ? `${data.day.slice(5).replace('-', ' 月 ')} 日 · ${data.now.split(' ')[1] || ''}` : ''}</div>
          <h1>{plan?.summary || '今天想做什么？'}</h1>
        </div>
        <div class="hdr-links"><a class="edit" href="/m" aria-label="记账">$</a><a class="edit" href="/admin" aria-label="编辑器">▦</a></div>
      </header>

      <section class="composer">
        <textarea ref={ta} value={text} placeholder={plan ? '随时补充：新想到的事、做完了什么、计划有变…' : '把今天想做的事一口气写下来，不用分条。比如：上午把实验跑完，下午三点组会，晚上回导师邮件，顺便去超市…'}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
        <div class="row">
          <span class="hint">{text.length ? `${text.length} 字 · 草稿已自动保存` : '支持语音输入：点键盘上的麦克风'}</span>
          <button class="go" disabled={!text.trim() || !!busy} onClick={submit}>{busy ? '整理中…' : '交给 AI'}</button>
        </div>
        {busy ? <div class="busy"><i />{busy}</div> : null}
        {err ? <div class="err">{err}</div> : null}
      </section>

      {data?.actions?.length ? (
        <section class="card ask">
          <h2>需要你 <small>{data.actions.length} 件</small></h2>
          {data.actions.map((a) => (
            <div class={`q ${a.urgent ? 'urgent' : ''}`}>
              <div class="qk">{({ agent: 'Agent 等你批准', card: '后台 Agent 问你', notice: 'AI 工具通知', question: 'AI 想确认', review: 'AI 做完了', failed: 'AI 没做成', mail: '邮件', deadline: '截止' } as any)[a.kind] || a.source} · {a.source}</div>
              <div class="qq">{a.title}</div>
              {a.detail ? <div class="qd">{a.detail}</div> : null}
              {a.options?.length ? <div class="chips">{a.options.map((o, i) => <button class={i === a.recommend ? 'rec' : ''} onClick={() => act(a.id, i)}>{o}</button>)}</div> : null}
              {a.kind === 'question' || (a.kind === 'card' && (a.options?.length || 0) > 1) ? (
                <div class="qa"><input placeholder="或者直接说" value={custom[a.id] || ''} onInput={(e) => setCustom({ ...custom, [a.id]: (e.target as HTMLInputElement).value })} /><button onClick={() => act(a.id, undefined, custom[a.id] || '')}>回答</button></div>
              ) : null}
              {a.kind === 'agent' ? <div class="qd">在 Mac 的终端里批准或拒绝。</div> : null}
            </div>
          ))}
        </section>
      ) : null}

      {data?.doing?.length ? (
        <section class="card">
          <h2>进行中 <small>{data.doing.length} 项</small></h2>
          <ul class="doing">
            {data.doing.map((d) => <li class={d.state === 'waiting' ? 'wait' : ''}><span class="src">{d.source}</span><div><div class="dt">{d.title}</div>{d.detail ? <div class="dd">{d.detail}</div> : null}</div><span class="ds">{d.state === 'running' ? '运行中' : d.state === 'waiting' ? '等你批准' : d.state}</span></li>)}
          </ul>
        </section>
      ) : null}

      {plan?.blocks?.length ? (
        <section class="card">
          <h2>时间安排 <small>{plan.updatedAt ? `更新于 ${hm(plan.updatedAt)}` : ''}</small></h2>
          <ol class="tl">
            {plan.blocks.map((b) => {
              const on = toMin(b.start) <= nowMin && (b.end ? toMin(b.end) : toMin(b.start) + 30) > nowMin;
              const past = (b.end ? toMin(b.end) : toMin(b.start) + 30) <= nowMin;
              return <li class={`${b.kind || 'task'} ${on ? 'on' : ''} ${past ? 'past' : ''}`}><time>{b.start}{b.end ? `–${b.end}` : ''}</time><span>{b.title}</span></li>;
            })}
          </ol>
        </section>
      ) : null}

      <section class="card">
        <h2>待办 <small>{open.length ? `${open.length} 项` : ''}</small></h2>
        {!open.length && !done.length ? <p class="muted">写下想做的事，AI 会拆成待办。</p> : null}
        <ul class="tasks">
          {open.map((t) => {
            const job = data?.jobs?.find((j) => j.task_id === t.id && j.status !== 'failed');
            return (
              <li onClick={() => toggle(t.id)}>
                <i class="box" />
                <span class="tt">{t.title}</span>
                <span class="meta">{[t.priority === 1 ? PRI[1] : '', t.est_min ? `${t.est_min} 分` : '', t.due ? t.due.slice(5, 10).replace('-', '/') : '', t.day && data && t.day < data.day ? '遗留' : ''].filter(Boolean).join(' · ')}</span>
                {job ? <span class="ai-state">AI {({ queued: '排队中', sent: '已派出', running: '在做', asking: '等你回答', done: '做完了' } as any)[job.status] || job.status}</span>
                  : t.ai_ok ? <span class="ai-row" onClick={(e) => { e.stopPropagation(); delegate(t.id); }}><b>交给 AI</b>{t.ai_how ? ` · ${t.ai_how}` : ''}</span>
                  : <span class="ai-row minor" onClick={(e) => { e.stopPropagation(); if (confirm(`把「${t.title}」交给 AI 试试？`)) delegate(t.id); }}>交给 AI</span>}
              </li>
            );
          })}
          {done.map((t) => <li class="done" onClick={() => toggle(t.id)}><i class="box on" /><span class="tt">{t.title}</span></li>)}
        </ul>
      </section>

      {plan?.notes?.length ? (
        <section class="card"><h2>记一下</h2><ul class="notes">{plan.notes.map((n) => <li>{n}</li>)}</ul></section>
      ) : null}

      {data?.jobs?.length ? (
        <section class="card">
          <h2>AI 代办记录 <small>后台 Claude Code 完成</small></h2>
          <ul class="jobs">
            {data.jobs.map((j) => (
              <li onClick={() => setOpenJob(openJob === j.id ? null : j.id)}>
                <div class="jt"><span class={`js ${j.status}`}>{({ queued: '排队', sent: '已派出', running: '在做', asking: '等你', done: '完成', failed: '失败' } as any)[j.status] || j.status}</span>{j.title}</div>
                {j.summary ? <div class="jsum">{j.summary}</div> : null}
                {openJob === j.id && j.result ? <pre class="jres">{j.result}</pre> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data?.mails?.length ? (
        <section class="card">
          <h2>要处理的邮件 <small>AI 从邮箱筛出</small></h2>
          <ul class="mails">
            {data.mails.map((m) => (
              <li>
                <span class={`act ${m.action}`}>{ACTION[m.action] || '查看'}</span>
                <div><div class="ms">{m.summary || m.subject}</div><div class="mf">{m.sender.replace(/<.*>/, '').trim()} · {hm(m.received)}</div></div>
                <button class="x" onClick={() => mailDone(m.id)}>处理了</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data?.brief ? (
        <section class="card brief">
          <h2>简报 <small>{hm(data.brief.generatedAt)}</small></h2>
          <p class="focus">{data.brief.focus}</p>
          <ul>{data.brief.bullets.map((b) => <li>{b}</li>)}</ul>
          {data.brief.tip ? <p class="muted">{data.brief.tip}</p> : null}
        </section>
      ) : null}

      {data?.research?.summary ? (
        <section class="card"><h2>AI 理解的研究焦点</h2><p>{data.research.summary}</p><ul class="notes">{data.research.questions.map((q) => <li>{q.q}</li>)}</ul></section>
      ) : null}

      {data?.captures?.length ? (
        <section class="card log">
          <h2 onClick={() => setShowLog(!showLog)}>今天写过的 <small>{data.captures.length} 段 {showLog ? '收起' : '展开'}</small></h2>
          {showLog ? data.captures.map((c) => <p><time>{hm(c.ts)}</time>{c.text}</p>) : null}
        </section>
      ) : null}

      <footer>{data?.aiUsage ? `今天 AI 调用 ${data.aiUsage.calls} 次 · ${(data.aiUsage.tokens / 1000).toFixed(1)}k tokens` : ''}</footer>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
