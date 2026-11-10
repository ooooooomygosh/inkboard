import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Layout, Orientation, Page, StatePayload, Widget, WidgetType } from '../../../shared/types';
import { screenSize } from '../../../shared/defaults';
import { CATALOG, catalogOf, type Field } from '../../../shared/catalog';
import '../common/board.css';
import './admin.css';
import { Board, type Box, type Ctx } from '../common/widgets';
import { ago } from '../common/format';
// @ts-ignore - tiny MIT QR encoder
import qrcode from 'qrcode-generator';

const boot = (window as any).__BOOT__ as { origin: string };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const r = await fetch(path, { method: opts.method || 'GET', headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: string } | null>(null);
  const t = useRef<any>();
  const show = (text: string, kind = 'ok') => { setMsg({ text, kind }); clearTimeout(t.current); t.current = setTimeout(() => setMsg(null), 2600); };
  return { msg, show };
}

// ---------------------------------------------------------------- markets symbols editor
const PRESETS: { group: string; items: { symbol: string; label: string }[] }[] = [
  { group: '汇率', items: [
    { symbol: 'USDCNY=X', label: 'USD/CNY' }, { symbol: 'EURCNY=X', label: 'EUR/CNY' }, { symbol: 'JPYCNY=X', label: 'JPY/CNY' }, { symbol: 'HKDCNY=X', label: 'HKD/CNY' },
    { symbol: 'AUDCNY=X', label: 'AUD/CNY' }, { symbol: 'GBPCNY=X', label: 'GBP/CNY' }, { symbol: 'EURUSD=X', label: 'EUR/USD' }, { symbol: 'USDJPY=X', label: 'USD/JPY' },
  ] },
  { group: '指数', items: [
    { symbol: '^GSPC', label: '标普 500' }, { symbol: '^IXIC', label: '纳斯达克' },
    { symbol: '000001.SS', label: '上证指数' }, { symbol: '^HSI', label: '恒生指数' }, { symbol: '^N225', label: '日经 225' }, { symbol: '^AXJO', label: 'ASX 200' },
  ] },
  { group: '股票', items: [
    { symbol: 'NVDA', label: 'NVDA' }, { symbol: 'AAPL', label: 'AAPL' }, { symbol: 'MSFT', label: 'MSFT' }, { symbol: 'TSLA', label: 'TSLA' },
    { symbol: 'GOOGL', label: 'GOOGL' }, { symbol: 'BABA', label: '阿里巴巴' }, { symbol: '0700.HK', label: '腾讯' }, { symbol: '600519.SS', label: '贵州茅台' },
  ] },
  { group: '其他', items: [{ symbol: 'BTC-USD', label: 'BTC' }, { symbol: 'ETH-USD', label: 'ETH' }, { symbol: 'GC=F', label: '黄金' }, { symbol: 'CL=F', label: '原油' }] },
];

function SymbolsInput({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const items: { symbol: string; label?: string }[] = Array.isArray(value) ? value : [];
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<any>();
  const has = (sym: string) => items.some((x) => x.symbol === sym);
  const add = (it: { symbol: string; label?: string }) => { if (!has(it.symbol)) onChange([...items, { symbol: it.symbol, label: it.label || it.symbol }]); };
  const remove = (i: number) => onChange(items.filter((_, k) => k !== i));
  const move = (i: number, d: number) => { const n = [...items]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  const rename = (i: number, label: string) => onChange(items.map((x, k) => (k === i ? { ...x, label } : x)));
  const search = (v: string) => {
    setQ(v); clearTimeout(timer.current);
    if (!v.trim()) { setRes([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setRes((await api(`/api/admin/symbols?q=${encodeURIComponent(v.trim())}`)).items || []); } catch { setRes([]); }
      setBusy(false);
    }, 350);
  };
  return (
    <div class="sym">
      {items.length ? items.map((it, i) => (
        <div class="sym-row">
          <input class="sym-label" value={it.label || ''} placeholder={it.symbol} onInput={(e) => rename(i, (e.target as HTMLInputElement).value)} />
          <code class="sym-code">{it.symbol}</code>
          <button class="ico" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button class="ico" title="下移" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
          <button class="ico" title="删除" onClick={() => remove(i)}>×</button>
        </div>
      )) : <div class="hint">还没有，搜索或从下面点选。</div>}
      <input class="sym-q" value={q} placeholder="搜索：英伟达、苹果、美元 人民币、比特币、黄金…" onInput={(e) => search((e.target as HTMLInputElement).value)} />
      {q ? (
        <div class="sym-res">
          {busy && !res.length ? <div class="hint">搜索中…</div> : null}
          {!busy && !res.length ? <div class="hint">没找到。也可以直接输 Yahoo 代码，比如 0700.HK、^GSPC。<button class="link" onClick={() => { add({ symbol: q.trim().toUpperCase() }); search(''); }}>直接添加 {q.trim().toUpperCase()}</button></div> : null}
          {res.map((r) => (
            <button class={`sym-hit ${has(r.symbol) ? 'on' : ''}`} onClick={() => { add({ symbol: r.symbol, label: r.kind === '汇率' ? r.name.replace(' 汇率', '') : r.symbol.replace(/\.(AX|SS|SZ|HK)$/, '') }); search(''); }}>
              <b>{r.name}</b><span>{r.symbol}{r.exchange ? ` · ${r.exchange}` : ''}{r.kind ? ` · ${r.kind}` : ''}</span>
            </button>
          ))}
        </div>
      ) : (
        <div class="sym-presets">
          {PRESETS.map((g) => (
            <div class="sym-g"><span class="sym-gn">{g.group}</span>
              {g.items.map((it) => <button class={`chip ${has(it.symbol) ? 'on' : ''}`} onClick={() => (has(it.symbol) ? onChange(items.filter((x) => x.symbol !== it.symbol)) : add(it))}>{it.label}</button>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- field editor
function FieldInput({ f, value, onChange }: { f: Field; value: any; onChange: (v: any) => void }) {
  const [text, setText] = useState<string>(() => (f.type === 'json' ? JSON.stringify(value ?? null, null, 1) : f.type === 'list' ? (value || []).join('\n') : ''));
  const [err, setErr] = useState('');
  useEffect(() => { if (f.type === 'json') setText(JSON.stringify(value ?? null, null, 1)); if (f.type === 'list') setText((value || []).join('\n')); }, [JSON.stringify(value)]);
  switch (f.type) {
    case 'symbols': return <SymbolsInput value={value} onChange={onChange} />;
    case 'bool': return <label class="sw"><input type="checkbox" checked={!!value} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} /><span /></label>;
    case 'number': return <input type="number" step="any" value={value ?? ''} onInput={(e) => onChange((e.target as HTMLInputElement).value === '' ? '' : Number((e.target as HTMLInputElement).value))} />;
    case 'select': return <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>{f.options!.map((o) => <option value={o.value}>{o.label}</option>)}</select>;
    case 'textarea': return <textarea rows={3} value={value || ''} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />;
    case 'list': return <textarea rows={4} value={text} placeholder="每行一个" onInput={(e) => { const v = (e.target as HTMLTextAreaElement).value; setText(v); onChange(v.split(/\n|,/).map((s) => s.trim()).filter(Boolean)); }} />;
    case 'json': return (
      <>
        <textarea class="mono" rows={6} value={text} onInput={(e) => {
          const v = (e.target as HTMLTextAreaElement).value; setText(v);
          try { onChange(JSON.parse(v)); setErr(''); } catch (x: any) { setErr('JSON 格式有误'); }
        }} />
        {err ? <div class="err">{err}</div> : null}
      </>
    );
    default: return <input value={value ?? ''} placeholder={f.placeholder} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />;
  }
}

// ---------------------------------------------------------------- canvas with drag/resize
function Canvas({ layout, pageId, data, selected, onSelect, onChange, scale }: {
  layout: Layout; pageId: string; data: Record<string, any>; selected: string | null; onSelect: (id: string | null) => void;
  onChange: (fn: (l: Layout) => void, commit?: boolean) => void; scale: number;
}) {
  const g = layout.grid;
  const { w: DEV_W, h: DEV_H } = screenSize(layout.orientation);
  const colW = (DEV_W - 2 * g.padding - (g.cols - 1) * g.gap) / g.cols;
  const rowH = (DEV_H - 2 * g.padding - (g.rows - 1) * g.gap) / g.rows;
  const drag = useRef<any>(null);
  const page = layout.pages.find((p) => p.id === pageId)!;
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);

  const overlaps = useMemo(() => {
    const s = new Set<string>();
    const ws = page.widgets;
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i], b = ws[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { s.add(a.id); s.add(b.id); }
    }
    return s;
  }, [page]);

  function start(e: PointerEvent, w: Widget, mode: 'move' | 'resize') {
    e.preventDefault(); e.stopPropagation();
    onSelect(w.id);
    drag.current = { mode, id: w.id, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, ow: w.w, oh: w.h, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const dx = Math.round((ev.clientX - d.sx) / scale / (colW + g.gap));
      const dy = Math.round((ev.clientY - d.sy) / scale / (rowH + g.gap));
      if (!dx && !dy && !d.moved) return;
      d.moved = true;
      onChange((l) => {
        const ww = l.pages.find((p) => p.id === pageId)!.widgets.find((x) => x.id === d.id)!;
        const cat = catalogOf(ww.type);
        if (d.mode === 'move') {
          ww.x = Math.max(0, Math.min(g.cols - ww.w, d.ox + dx));
          ww.y = Math.max(0, Math.min(g.rows - ww.h, d.oy + dy));
        } else {
          ww.w = Math.max(cat.minW, Math.min(g.cols - ww.x, d.ow + dx));
          ww.h = Math.max(cat.minH, Math.min(g.rows - ww.y, d.oh + dy));
        }
      }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (drag.current?.moved) onChange(() => {}, true);
      drag.current = null;
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  const ctx: Ctx = { now, layout, pageId, setPage: () => {}, toggleTask: () => {}, action: () => {}, device: { battery: 82, charging: true, wifiLevel: 4 }, lastSync: Date.now(), offline: false, preview: true, pomodoro: null };
  const overlay = (w: Widget, box: Box) => (
    <div class={`ov ${selected === w.id ? 'sel' : ''} ${overlaps.has(w.id) ? 'clash' : ''}`} onPointerDown={(e) => start(e as any, w, 'move')}>
      <span class="ov-tag">{catalogOf(w.type).name} · {w.w}×{w.h}</span>
      <span class="ov-rs" onPointerDown={(e) => start(e as any, w, 'resize')} />
    </div>
  );
  return (
    <div class="device" style={{ width: DEV_W * scale + 28, height: DEV_H * scale + 28 }}>
      <div class="device-screen" style={{ transform: `scale(${scale})`, width: DEV_W, height: DEV_H }} onPointerDown={() => onSelect(null)}>
        <div class="gridlines" style={{ padding: g.padding, gap: g.gap, gridTemplateColumns: `repeat(${g.cols},1fr)`, gridTemplateRows: `repeat(${g.rows},1fr)` }}>
          {Array.from({ length: g.cols * g.rows }, () => <i />)}
        </div>
        <Board layout={layout} pageId={pageId} data={data} ctx={ctx} width={DEV_W} height={DEV_H} overlay={overlay} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panels
function WidgetProps({ w, update, remove, duplicate, refresh }: { w: Widget; update: (fn: (w: Widget) => void) => void; remove: () => void; duplicate: () => void; refresh: () => void }) {
  const cat = catalogOf(w.type);
  return (
    <div class="props">
      <div class="props-h"><b>{cat.name}</b><span class="muted">{cat.desc}</span></div>
      <div class="frm">
        <label>标题</label><input value={w.title || ''} placeholder="默认标题" onInput={(e) => update((x) => { x.title = (e.target as HTMLInputElement).value || undefined; })} />
        <label>隐藏标题</label><label class="sw"><input type="checkbox" checked={!!w.hideTitle} onChange={(e) => update((x) => { x.hideTitle = (e.target as HTMLInputElement).checked; })} /><span /></label>
        <label>位置 / 大小</label>
        <div class="xywh">
          {(['x', 'y', 'w', 'h'] as const).map((k) => <input type="number" value={w[k]} title={k} onInput={(e) => update((x) => { x[k] = Math.max(k === 'w' || k === 'h' ? 1 : 0, Number((e.target as HTMLInputElement).value) || 0); })} />)}
        </div>
        {cat.fields.map((f) => (
          <>
            <label title={f.hint} class={f.type === 'symbols' ? 'frm-wide' : ''}>{f.label}</label>
            <div class={f.type === 'symbols' ? 'frm-wide' : ''}><FieldInput f={f} value={w.props[f.key]} onChange={(v) => update((x) => { x.props[f.key] = v; })} />{f.hint ? <div class="hint">{f.hint}</div> : null}</div>
          </>
        ))}
      </div>
      {w.type === 'weather' || w.type === 'header' || w.type === 'focus' ? <div class="hint">天气位置在左侧“设备 → 位置”统一设置。</div> : null}
      <div class="row gap">
        <button onClick={refresh}>刷新数据</button>
        <button onClick={duplicate}>复制</button>
        <button class="danger" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

function TasksPanel({ google, toast }: { google: boolean; toast: (s: string, k?: string) => void }) {
  const [list, setList] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [toGoogle, setToGoogle] = useState(false);
  const load = () => api('/api/admin/tasks').then(setList);
  useEffect(() => { load(); }, []);
  const add = async (e: Event) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api('/api/admin/tasks', { method: 'POST', body: { title: title.trim(), due: due || null, google: toGoogle } });
    setTitle(''); setDue(''); load(); toast('已添加');
  };
  const [smart, setSmart] = useState('');
  const [busy, setBusy] = useState(false);
  const addSmart = async () => {
    if (!smart.trim()) return;
    setBusy(true);
    try {
      const r = await api('/api/admin/ai/tasks', { method: 'POST', body: { text: smart.trim(), google: toGoogle } });
      setSmart(''); load(); toast(`AI 添加了 ${r.tasks.length} 项：${r.tasks.map((t: any) => t.title + (t.due ? `（${t.due}）` : '')).join('、')}`);
    } catch (e: any) { toast('AI 解析失败：' + e.message, 'err'); }
    setBusy(false);
  };
  return (
    <div class="panel">
      <div class="add smart">
        <textarea rows={2} value={smart} placeholder="用一句话说，AI 帮你拆成待办：周三下午前把场景清单发给导师，顺便约下周组会（⌘↩）"
          onInput={(e) => setSmart((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addSmart(); } }} />
        <button class="primary" disabled={busy || !smart.trim()} onClick={addSmart}>{busy ? 'AI 解析中…' : '✦ AI 添加'}</button>
      </div>
      <h4>手动添加</h4>
      <form class="add" onSubmit={add}>
        <input value={title} placeholder="新任务，回车添加" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        <div class="row gap"><input type="date" value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} />
          {google ? <label class="chk"><input type="checkbox" checked={toGoogle} onChange={(e) => setToGoogle((e.target as HTMLInputElement).checked)} />加到 Google Tasks</label> : null}
          <button class="primary">添加</button></div>
      </form>
      <div class="list">
        {list.map((t) => (
          <div class={`li ${t.done ? 'done' : ''}`}>
            <input type="checkbox" checked={!!t.done} onChange={async () => { await api(`/api/admin/tasks/${t.id}`, { method: 'PATCH', body: { done: !t.done } }); load(); }} />
            <span class="li-t" contentEditable onBlur={async (e) => { const v = (e.target as HTMLElement).innerText.trim(); if (v && v !== t.title) { await api(`/api/admin/tasks/${t.id}`, { method: 'PATCH', body: { title: v } }); load(); } }}>{t.title}</span>
            {t.due ? <span class="tag">{t.due.slice(0, 10)}</span> : null}
            <span class={`tag ${t.source}`}>{t.source === 'google' ? 'Google' : '自带'}</span>
            {t.source === 'local' ? <button class="x" onClick={async () => { await api(`/api/admin/tasks/${t.id}`, { method: 'DELETE' }); load(); }}>×</button> : null}
          </div>
        ))}
        {!list.length ? <div class="muted">还没有任务</div> : null}
      </div>
    </div>
  );
}

function MemosPanel({ toast }: { toast: (s: string) => void }) {
  const [list, setList] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const load = () => api('/api/admin/memos').then(setList);
  useEffect(() => { load(); }, []);
  return (
    <div class="panel">
      <div class="add">
        <textarea rows={3} value={body} placeholder="写一条备忘（⌘↩ 保存）" onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          onKeyDown={async (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (body.trim()) { await api('/api/admin/memos', { method: 'POST', body: { body: body.trim(), pinned: true } }); setBody(''); load(); toast('已保存'); } } }} />
        <button class="primary" onClick={async () => { if (!body.trim()) return; await api('/api/admin/memos', { method: 'POST', body: { body: body.trim(), pinned: true } }); setBody(''); load(); toast('已保存'); }}>保存并置顶</button>
      </div>
      <div class="list">
        {list.map((m) => (
          <div class="memo-li">
            <textarea rows={2} defaultValue={m.body} onBlur={async (e) => { const v = (e.target as HTMLTextAreaElement).value.trim(); if (v && v !== m.body) { await api(`/api/admin/memos/${m.id}`, { method: 'PATCH', body: { body: v } }); load(); } }} />
            <div class="row gap">
              <label class="chk"><input type="checkbox" checked={!!m.pinned} onChange={async () => { await api(`/api/admin/memos/${m.id}`, { method: 'PATCH', body: { pinned: !m.pinned } }); load(); }} />置顶</label>
              <span class="muted">{ago(m.updated_at)}</span>
              <button class="x" onClick={async () => { await api(`/api/admin/memos/${m.id}`, { method: 'DELETE' }); load(); }}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SecretRow({ k, label, masked, hint, multiline, save }: { k: string; label: string; masked?: string; hint?: string; multiline?: boolean; save: (k: string, v: string | null) => Promise<void> }) {
  const [v, setV] = useState('');
  return (
    <div class="sec">
      <div class="sec-h"><b>{label}</b>{masked ? <span class="tag ok">已设置 {masked}</span> : <span class="tag">未设置</span>}</div>
      {hint ? <div class="hint">{hint}</div> : null}
      <div class="row gap">
        {multiline ? <textarea rows={2} value={v} placeholder="粘贴后点保存" onInput={(e) => setV((e.target as HTMLTextAreaElement).value)} />
          : <input type="password" value={v} placeholder={masked ? '输入新值以替换' : '粘贴后点保存'} onInput={(e) => setV((e.target as HTMLInputElement).value)} />}
        <button onClick={async () => { await save(k, v); setV(''); }} disabled={!v}>保存</button>
        {masked ? <button class="x" onClick={() => save(k, null)}>清除</button> : null}
      </div>
    </div>
  );
}

function SourcesPanel({ meta, reloadMeta, toast }: { meta: any; reloadMeta: () => void; toast: (s: string, k?: string) => void }) {
  const save = async (k: string, v: string | null) => { await api('/api/admin/secrets', { method: 'PUT', body: { [k]: v } }); reloadMeta(); toast(v ? '已保存，正在拉取数据' : '已清除'); };
  const s = meta?.secrets || {};
  return (
    <div class="panel">
      <h4>AI（DeepSeek）</h4>
      <SecretRow k="deepseek_key" label="DeepSeek API key" masked={s.deepseek_key} hint="用于今日简报、论文雷达、Agent 完成摘要、AI 添加待办，同时显示 DeepSeek 余额。" save={save} />
      <div class="btns">
        <button onClick={async () => { toast('正在生成简报…'); try { await api('/api/admin/ai/brief', { method: 'POST' }); toast('简报已更新'); } catch (e: any) { toast('失败：' + e.message, 'err'); } }}>重新生成今日简报</button>
        <button onClick={async () => { toast('正在扫描 arXiv…'); try { const r = await api('/api/admin/ai/papers', { method: 'POST' }); toast(`论文雷达已更新（${r.items?.length ?? 0} 篇）`); } catch (e: any) { toast('失败：' + e.message, 'err'); } }}>立即扫描论文</button>
      </div>
      {meta?.aiUsage ? <div class="hint">今天 AI 调用 {meta.aiUsage.calls} 次，{meta.aiUsage.tokens} tokens。</div> : null}

      <h4>日历（ICS 订阅）</h4>
      <div class="sec">
        <div class="sec-h"><b>日历</b>{meta?.outlook?.ics?.ok ? <span class="tag ok">已同步 {meta.outlook.ics.n} 项</span> : meta?.outlook?.ics?.error ? <span class="tag">出错</span> : <span class="tag">未连接</span>}</div>
        <div class="hint">Outlook、Google、iCloud、飞书、钉钉等日历都能导出 ICS 订阅链接（Outlook 网页版：设置 → 日历 → 共享日历 → 发布日历）。复制 <b>.ics</b> 链接贴到下面，云端每 15 分钟拉一次，Mac 关机也照常更新。{meta?.outlook?.ics?.error ? ` 上次出错：${meta.outlook.ics.error}` : ''}</div>
      </div>
      <SecretRow k="outlook_ics" label="日历 ICS 链接" masked={s.outlook_ics} save={save} />
      <div class="sec">
        <div class="sec-h"><b>邮件</b>{meta?.outlook?.mails?.n ? <span class="tag ok">已收 {meta.outlook.mails.n} 封</span> : <span class="tag">还没收到</span>}</div>
        <div class="hint">邮件由 Mac 上的 InkBoard 从苹果“邮件”读取，只看发给或来自 <code>MAIL_DOMAIN</code>（在 <code>~/.inkboard/config.env</code> 里设置，比如学校或公司的域名）的邮件。如果你的邮箱不让苹果“邮件”直接登录，在网页版邮箱里加一条“转寄/重定向到”规则，转到一个能登录的邮箱即可。</div>
      </div>

      <h4>Google 日历 + Tasks（可选）</h4>
      <div class="sec">
        <div class="sec-h"><b>账号连接</b>{meta?.googleConnected ? <span class="tag ok">已连接</span> : <span class="tag">未连接</span>}</div>
        <div class="hint">在 Google Cloud Console 建一个 OAuth 客户端（Web 应用），授权回调地址填：<code>{boot.origin}/admin/google/callback</code>；“OAuth 同意屏幕”发布到 In production，否则授权 7 天失效。</div>
      </div>
      <SecretRow k="google_client_id" label="Client ID" masked={s.google_client_id} save={save} />
      <SecretRow k="google_client_secret" label="Client Secret" masked={s.google_client_secret} save={save} />
      <a class={`btn primary ${s.google_client_id && s.google_client_secret ? '' : 'disabled'}`} href="/admin/google/start">{meta?.googleConnected ? '重新连接 Google' : '连接 Google'}</a>
      <SecretRow k="ics_urls" label="或者：iCal 私密地址" multiline masked={s.ics_urls} hint="Google 日历 → 设置 → 某个日历 → “iCal 格式的私密地址”。多个地址用空格或换行分隔。不连接 Google 账号时使用。" save={save} />

      <h4>GitHub</h4>
      <SecretRow k="github_token" label="个人仓库令牌" masked={s.github_token} hint="fine-grained token，只读：Contents、Issues、Pull requests、Metadata、Commit statuses。" save={save} />
      <SecretRow k="github_token_org" label="组织仓库令牌" masked={s.github_token_org} hint="Resource owner 选组织的那一个 token，权限同上。两个都填时合并显示。" save={save} />

      <h4>API 余额 / 花费</h4>
      {(meta?.balanceSecrets || []).map((b: any) => <SecretRow k={b.key} label={b.label} masked={s[b.key]} hint={b.key.includes('admin') ? 'Admin key（组织管理员密钥），只用于读取本月花费。' : undefined} save={save} />)}
      <div class="hint">订阅额度（Claude / Codex / Cursor / Copilot / Gemini）由 Mac 上的采集器上传，不在这里填。</div>
    </div>
  );
}

function DevicePanel({ layout, change, meta, command, toast, locate, setOrientation }: { layout: Layout; change: (fn: (l: Layout) => void) => void; meta: any; command: (c: string, a?: string) => void; toast: (s: string) => void; locate: () => void; setOrientation: (o: Orientation) => void }) {
  const d = layout.device;
  const dv = meta?.device;
  const num = (label: string, get: () => number, set: (v: number) => void, hint?: string) => (
    <><label>{label}</label><div><input type="number" value={get()} onInput={(e) => change(() => set(Number((e.target as HTMLInputElement).value)))} />{hint ? <div class="hint">{hint}</div> : null}</div></>
  );
  return (
    <div class="panel">
      <h4>设备状态</h4>
      {dv ? (
        <div class="kv">
          <span>最后在线</span><b>{ago(dv.seenAt)}</b>
          <span>电量</span><b>{dv.battery}%{dv.charging ? ' · 充电中' : ''}</b>
          <span>Wi-Fi</span><b>{dv.ssid} ({dv.rssi} dBm)</b>
          <span>InkBoard</span><b>{dv.app}</b>
          <span>WebView</span><b>{dv.webview}</b>
          <span>刷新接口</span><b>{dv.einkApi ? '可用' : '不可用'}</b>
          <span>时区</span><b>{dv.timezone}</b>
          <span>运行</span><b>{Math.round((dv.uptimeMin || 0) / 60)} 小时</b>
        </div>
      ) : <div class="muted">设备还没上报过状态</div>}
      <div class="btns">
        <button onClick={() => command('fullRefresh')}>全屏刷新</button>
        <button onClick={() => command('reload')}>重载看板</button>
        <button onClick={() => command('menu')}>弹出菜单</button>
        <button class="danger" onClick={() => confirm('重启阅读器？') && command('reboot')}>重启设备</button>
      </div>
      <div class="hint">指令在设备下一次同步时执行（{d.pollSec} 秒内）。</div>

      <h4>关于你</h4>
      <div class="frm">
        <label>城市</label><input value={layout.profile?.city || ''} onInput={(e) => change((l) => { l.profile.city = (e.target as HTMLInputElement).value; })} />
        <label>记账：我的名字</label><input value={layout.profile?.me || ''} onInput={(e) => change((l) => { l.profile.me = (e.target as HTMLInputElement).value; })} />
        <label>记账：另一位</label><input value={layout.profile?.partner || ''} onInput={(e) => change((l) => { l.profile.partner = (e.target as HTMLInputElement).value; })} />
        <label>记账币种</label><input value={layout.profile?.currency || ''} placeholder="CNY" onInput={(e) => change((l) => { l.profile.currency = (e.target as HTMLInputElement).value.toUpperCase(); })} />
      </div>
      <textarea class="about" rows={3} value={layout.profile?.about || ''} placeholder="一两句话告诉 AI 你是谁、在做什么，比如：在读研究生，做机器学习方向，常用 Claude Code。"
        onInput={(e) => change((l) => { l.profile.about = (e.target as HTMLTextAreaElement).value; })} />
      <div class="btns">
        <button onClick={async () => { try { const r = await api('/api/admin/money/invite'); await navigator.clipboard?.writeText(r.url).catch(() => {}); prompt('另一位的记账链接（已复制）：', r.url); } catch (e: any) { toast('失败：' + e.message); } }}>复制另一位的记账链接</button>
      </div>
      <div class="hint">这段话会放进每次 AI 调用的开头。记账页 /m 用上面的名字和币种；另一位用自己的链接打开，只能看到账本。</div>

      <h4>屏幕方向</h4>
      <div class="seg">
        {([['landscape', '横屏'], ['reverseLandscape', '横屏（反向）'], ['portrait', '竖屏'], ['reversePortrait', '竖屏（反向）']] as [Orientation, string][]).map(([o, n]) => (
          <span class={layout.orientation === o ? 'on' : ''} onClick={() => setOrientation(o)}>{n}</span>
        ))}
      </div>
      <div class="hint">“反向”= 旋转 180°，按支架上的摆放方向选。</div>

      <h4>位置（天气用）</h4>
      <div class="sec">
        {layout.location ? <div class="kv"><span>地点</span><b>{layout.location.name}</b><span>坐标</span><b>{layout.location.lat}, {layout.location.lon}</b><span>精度</span><b>±{layout.location.accuracy ?? '?'} 米</b></div> : <div class="muted">还没有定位，天气用的是组件里填的经纬度。</div>}
        <div class="btns"><button class="primary" onClick={locate}>📍 定位到这台 Mac 的位置</button></div>
        <div class="hint">用 macOS 定位服务（Wi-Fi 定位，通常几十米内）。阅读器和 Mac 在同一张桌子上，所以就是阅读器的位置。</div>
      </div>

      <h4>前光与对比度</h4>
      <div class="seg">
        {([['system', '系统控制'], ['off', '关闭'], ['fixed', '固定'], ['schedule', '按时间']] as [string, string][]).map(([m, n]) => (
          <span class={(d.light?.mode || 'system') === m ? 'on' : ''} onClick={() => change((l) => { l.device.light.mode = m as any; })}>{n}</span>
        ))}
      </div>
      {d.light?.mode === 'fixed' ? (
        <div class="frm" style={{ marginTop: '10px' }}>
          <label>亮度 {d.light.brightness}%</label><input type="range" min="0" max="100" value={d.light.brightness} onInput={(e) => change((l) => { l.device.light.brightness = +(e.target as HTMLInputElement).value; })} />
          <label>色温 {d.light.warmth}%</label><input type="range" min="0" max="100" value={d.light.warmth} onInput={(e) => change((l) => { l.device.light.warmth = +(e.target as HTMLInputElement).value; })} />
        </div>
      ) : null}
      {d.light?.mode === 'schedule' ? (
        <div class="sched">
          {(d.light.schedule || []).map((x, i) => (
            <div class="sched-i">
              <input type="time" value={x.from} onInput={(e) => change((l) => { l.device.light.schedule[i].from = (e.target as HTMLInputElement).value; })} />
              <span>–</span>
              <input type="time" value={x.to} onInput={(e) => change((l) => { l.device.light.schedule[i].to = (e.target as HTMLInputElement).value; })} />
              <label>亮 {x.brightness}%<input type="range" min="0" max="100" value={x.brightness} onInput={(e) => change((l) => { l.device.light.schedule[i].brightness = +(e.target as HTMLInputElement).value; })} /></label>
              <label>暖 {x.warmth}%<input type="range" min="0" max="100" value={x.warmth} onInput={(e) => change((l) => { l.device.light.schedule[i].warmth = +(e.target as HTMLInputElement).value; })} /></label>
              <button class="x" onClick={() => change((l) => { l.device.light.schedule.splice(i, 1); })}>×</button>
            </div>
          ))}
          <button onClick={() => change((l) => { l.device.light.schedule.push({ from: '07:00', to: '08:30', brightness: 25, warmth: 30 }); })}>＋ 时间段</button>
          <div class="hint">时间段之外前光关闭（墨水屏白天靠环境光就够了）。</div>
        </div>
      ) : null}
      <div class="hint">{d.light?.mode === 'system' ? '不接管：用阅读器下拉栏里的滑块调节。' : '下拉栏的滑块仍然可用，手动调节会保持到下一次时间段切换。'}{dv?.light ? ` 当前：亮度约 ${dv.light.brightness}% · 暖光 ${dv.light.warmth}%` : ''}</div>
      <div class="frm" style={{ marginTop: '10px' }}>
        <label>对比度</label>
        <select value={d.contrast ?? -1} onChange={(e) => change((l) => { l.device.contrast = +(e.target as HTMLSelectElement).value; })}>
          <option value={-1}>不控制</option>{[0, 1, 2, 3, 4, 5].map((v) => <option value={v}>{v}{v === 3 ? '（出厂）' : ''}</option>)}
        </select>
      </div>

      <h4>电池保养</h4>
      <div class="frm">
        <label>启用</label><label class="sw"><input type="checkbox" checked={d.battery?.care !== false} onChange={(e) => change((l) => { l.device.battery.care = (e.target as HTMLInputElement).checked; })} /><span /></label>
        {num('充到（%）停', () => d.battery?.upper ?? 80, (v) => (layout.device.battery.upper = v))}
        {num('低于（%）充', () => d.battery?.lower ?? 70, (v) => (layout.device.battery.lower = v))}
      </div>
      <div class="hint">常年插电时把电池保持在区间内，比一直 100% 更耐用。暂停充电期间阅读器用电池供电，USB 数据连接会断开，这是正常的。{dv ? ` 当前：${dv.battery}%，${dv.chargeInput ? '正在充电' : '充电已暂停'}` : ''}</div>

      <h4>刷新与同步</h4>
      <div class="frm">
        {num('同步间隔（秒）', () => d.pollSec, (v) => (layout.device.pollSec = v))}
        {num('Agent 运行时（秒）', () => d.activePollSec, (v) => (layout.device.activePollSec = v), '有任务在跑时更频繁地同步')}
        {num('定时全刷（分钟）', () => d.fullRefreshMin, (v) => (layout.device.fullRefreshMin = v), '清残影；0 = 关闭')}
        {num('局刷上限（次）', () => d.partialLimit, (v) => (layout.device.partialLimit = v), '驱动层累计 N 次局刷后自动全刷；0 = 驱动默认')}
        {num('自动回首页（秒）', () => d.returnHomeSec, (v) => (layout.device.returnHomeSec = v), '0 = 不返回')}
        {num('前光亮度', () => d.brightness, (v) => (layout.device.brightness = v), '0–255，-1 = 不控制')}
        <label>时区</label>
        <select value={d.timezone} onChange={(e) => change((l) => { l.device.timezone = (e.target as HTMLSelectElement).value; })}>
          {['Asia/Shanghai', 'Australia/Sydney', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'America/Los_Angeles', 'America/New_York'].map((z) => <option>{z}</option>)}
        </select>
      </div>

      <h4>夜间模式</h4>
      <div class="frm">
        <label>启用</label><label class="sw"><input type="checkbox" checked={d.night.enabled} onChange={(e) => change((l) => { l.device.night.enabled = (e.target as HTMLInputElement).checked; })} /><span /></label>
        <label>开始</label><input type="time" value={d.night.start} onInput={(e) => change((l) => { l.device.night.start = (e.target as HTMLInputElement).value; })} />
        <label>结束</label><input type="time" value={d.night.end} onInput={(e) => change((l) => { l.device.night.end = (e.target as HTMLInputElement).value; })} />
      </div>

      <h4>网格与字体</h4>
      <div class="frm">
        {num('列数', () => layout.grid.cols, (v) => (layout.grid.cols = Math.max(4, v)))}
        {num('行数', () => layout.grid.rows, (v) => (layout.grid.rows = Math.max(4, v)))}
        {num('间距', () => layout.grid.gap, (v) => (layout.grid.gap = v))}
        {num('边距', () => layout.grid.padding, (v) => (layout.grid.padding = v))}
        <label>字号缩放</label><input type="number" step="0.05" value={layout.theme.fontScale} onInput={(e) => change((l) => { l.theme.fontScale = Number((e.target as HTMLInputElement).value) || 1; })} />
        <label>卡片边框</label><label class="sw"><input type="checkbox" checked={layout.theme.cards !== false} onChange={(e) => change((l) => { l.theme.cards = (e.target as HTMLInputElement).checked; })} /><span /></label>
        <label>大数字字体</label>
        <select value={layout.theme.displayFont || 'smiley'} onChange={(e) => change((l) => { l.theme.displayFont = (e.target as HTMLSelectElement).value as any; })}>
          <option value="smiley">得意黑</option><option value="inter">Inter 细体</option>
        </select>
        <label>标题样式</label>
        <select value={layout.theme.titleStyle} onChange={(e) => change((l) => { l.theme.titleStyle = (e.target as HTMLSelectElement).value as any; })}>
          <option value="tab">黑底标签</option><option value="rule">文字 + 横线</option><option value="plain">纯文字</option>
        </select>
      </div>
      <div class="btns"><button class="danger" onClick={async () => { if (confirm('恢复当前方向的默认布局？当前布局会被覆盖。')) { await api('/api/admin/layout/reset', { method: 'POST', body: { orientation: layout.orientation } }); location.reload(); } }}>恢复默认布局</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- memory
const KIND_ZH: Record<string, string> = { person: '人物', project: '项目', research: '研究', preference: '偏好', routine: '习惯', goal: '目标', date: '日期', fact: '事实' };

function QR({ text, size = 168 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), cell = size / (n + 4);
  const rects: any[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) rects.push(<rect x={(c + 2) * cell} y={(r + 2) * cell} width={cell + 0.3} height={cell + 0.3} />);
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ background: '#fff', borderRadius: '8px' }}><g fill="#111">{rects}</g></svg>;
}

function MemoryPanel({ toast }: { toast: (s: string, k?: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [showHist, setShowHist] = useState(false);
  const [form, setForm] = useState({ kind: 'fact', subject: '用户', predicate: '', value: '' });
  const [busy, setBusy] = useState('');
  const load = () => api('/api/admin/memory').then(setData);
  useEffect(() => { load(); }, []);
  if (!data) return <div class="panel muted">加载中…</div>;
  const active = data.facts.filter((f: any) => f.status === 'active');
  const hist = data.facts.filter((f: any) => f.status !== 'active');
  const groups: Record<string, any[]> = {};
  for (const f of active) (groups[f.kind] ||= []).push(f);
  const run = async (path: string, label: string) => { setBusy(label); try { await api(path, { method: 'POST' }); await load(); toast(label + '完成'); } catch (e: any) { toast('失败：' + e.message, 'err'); } setBusy(''); };
  return (
    <div class="panel">
      <div class="hint">AI 从你的快速捕获、邮件、研究笔记和 Agent 工作里提炼的长期记忆。改变的事实不会被覆盖，而是把旧的标成“历史”；越久没被提起越模糊，置顶的永远清楚。每次 AI 调用只带一份按 token 预算裁剪的记忆摘要。</div>

      <h4>研究焦点 <span class="muted small">{data.research?.updatedAt ? ago(data.research.updatedAt) : ''}</span></h4>
      {data.research ? <div class="mem-box"><p>{data.research.summary}</p><ul>{data.research.questions.map((q: any) => <li>{q.q}<div class="muted small">{q.keywords.join(' · ')}</div></li>)}</ul></div> : <div class="muted small">还没生成：需要研究笔记或几次快速捕获。</div>}
      <div class="btns"><button disabled={!!busy} onClick={() => run('/api/admin/ai/research', '重新提炼研究焦点')}>重新提炼</button><button disabled={!!busy} onClick={() => run('/api/admin/ai/papers', '按新焦点扫描论文')}>按焦点扫论文</button></div>

      <h4>近况观察 <span class="muted small">{data.observation?.updatedAt ? ago(data.observation.updatedAt) : '每晚 23:00 更新'}</span></h4>
      {data.observation ? <div class="mem-box pre">{data.observation.summary}</div> : <div class="muted small">每晚自动把当天的计划、完成情况、Agent 和邮件压缩进来。</div>}
      <div class="btns"><button disabled={!!busy} onClick={() => run('/api/admin/ai/observation', '更新近况观察')}>现在更新</button></div>

      <h4>长期记忆 <span class="muted small">{active.length} 条</span></h4>
      {!active.length ? <div class="muted small">还没有。去手机上写几次“今天想做的事”，AI 会自动记下稳定的事实。</div> : null}
      {Object.entries(groups).map(([k, list]) => (
        <div class="mem-g">
          <div class="mem-k">{KIND_ZH[k] || k}</div>
          {list.map((f: any) => (
            <div class={`mem-i ${f.pinned ? 'pinned' : ''}`}>
              <div class="mem-t"><b>{f.subject}</b> {f.predicate}：<span contentEditable onBlur={async (e) => { const v = (e.target as HTMLElement).innerText.trim(); if (v && v !== f.value) { await api(`/api/admin/memory/${f.id}`, { method: 'PATCH', body: { value: v } }); load(); } }}>{f.value}</span></div>
              <div class="mem-m">{f.evidence ? `「${f.evidence}」 · ` : ''}{f.source} · 提到 {f.hits} 次 · {ago(f.seenAt)}</div>
              <div class="mem-a">
                <button class="x" title="置顶：永不淡忘" onClick={async () => { await api(`/api/admin/memory/${f.id}`, { method: 'PATCH', body: { pinned: !f.pinned } }); load(); }}>{f.pinned ? '取消置顶' : '置顶'}</button>
                <button class="x" onClick={async () => { await api(`/api/admin/memory/${f.id}`, { method: 'DELETE' }); load(); }}>删除</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {hist.length ? <><h4 onClick={() => setShowHist(!showHist)} style={{ cursor: 'pointer' }}>历史 {hist.length} 条 {showHist ? '▴' : '▾'}</h4>
        {showHist ? hist.map((f: any) => <div class="mem-i hist"><div class="mem-t"><b>{f.subject}</b> {f.predicate}：{f.value}</div><div class="mem-m">{f.validFrom?.slice(0, 10)} → {f.validTo?.slice(0, 10)}</div></div>) : null}</> : null}

      <h4>手动告诉 AI</h4>
      <div class="frm">
        <label>类型</label><select value={form.kind} onChange={(e) => setForm({ ...form, kind: (e.target as HTMLSelectElement).value })}>{Object.entries(KIND_ZH).map(([k, v]) => <option value={k}>{v}</option>)}</select>
        <label>主语</label><input value={form.subject} onInput={(e) => setForm({ ...form, subject: (e.target as HTMLInputElement).value })} />
        <label>关系</label><input value={form.predicate} placeholder="如：导师是 / 偏好的工作时段" onInput={(e) => setForm({ ...form, predicate: (e.target as HTMLInputElement).value })} />
        <label>内容</label><input value={form.value} onInput={(e) => setForm({ ...form, value: (e.target as HTMLInputElement).value })} />
      </div>
      <button class="primary" disabled={!form.predicate || !form.value} onClick={async () => { await api('/api/admin/memory', { method: 'POST', body: form }); setForm({ ...form, predicate: '', value: '' }); load(); toast('已记住'); }}>记住</button>
    </div>
  );
}

// ---------------------------------------------------------------- app
type Tab = 'widgets' | 'tasks' | 'memos' | 'memory' | 'sources' | 'device';

function App() {
  const [saved, setSaved] = useState<Layout | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [history, setHistory] = useState<Layout[]>([]);
  const [pageId, setPageId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<StatePayload | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'widgets');
  const [scale, setScale] = useState(0.8);
  const [saving, setSaving] = useState(false);
  const { msg, show } = useToast();
  const stageRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  layoutRef.current = layout;

  const loadState = () => api('/api/device/state').then(setState).catch(() => {});
  const loadMeta = () => api('/api/admin/meta').then(setMeta).catch(() => {});

  useEffect(() => {
    api<Layout>('/api/admin/layout').then((l) => { setSaved(l); setLayout(clone(l)); setPageId(l.pages[0].id); });
    loadState(); loadMeta();
    const t = setInterval(() => { loadState(); loadMeta(); }, 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { location.hash = tab; }, [tab]);

  useEffect(() => {
    const fit = () => {
      const el = stageRef.current; if (!el) return;
      const { w: DEV_W, h: DEV_H } = screenSize(layoutRef.current?.orientation || 'landscape');
      const s = Math.min((el.clientHeight - 100) / DEV_H, (el.clientWidth - 60) / DEV_W);
      setScale(Math.max(0.35, Math.min(1.2, s)));
    };
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [layout != null, layout?.orientation]);

  const dirty = useMemo(() => !!layout && !!saved && JSON.stringify({ ...layout, version: 0, updatedAt: '' }) !== JSON.stringify({ ...saved, version: 0, updatedAt: '' }), [layout, saved]);

  function change(fn: (l: Layout) => void, commit = true) {
    setLayout((cur) => {
      if (!cur) return cur;
      if (commit) setHistory((h) => [...h.slice(-49), clone(cur)]);
      const next = clone(cur); fn(next); return next;
    });
  }
  const undo = () => setHistory((h) => { if (!h.length) return h; setLayout(h[h.length - 1]); return h.slice(0, -1); });

  async function save() {
    if (!layout) return;
    setSaving(true);
    try {
      const s = await api<Layout>('/api/admin/layout', { method: 'PUT', body: layout });
      setSaved(s); setLayout(clone(s));
      show(`已保存（v${s.version}），设备 ${s.device.pollSec} 秒内更新`);
      setTimeout(loadState, 1500);
    } catch (e: any) { show('保存失败：' + e.message, 'err'); }
    setSaving(false);
  }

  async function locate() {
    if (!navigator.geolocation) { show('这个浏览器不支持定位', 'err'); return; }
    show('正在定位…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = +pos.coords.latitude.toFixed(5), lon = +pos.coords.longitude.toFixed(5);
      let name = '当前位置';
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=zh-CN`);
        const j: any = await r.json();
        const a = j.address || {};
        name = a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city || name;
      } catch { /* keep generic name */ }
      const next = clone(layoutRef.current!);
      next.location = { lat, lon, name, accuracy: Math.round(pos.coords.accuracy), updatedAt: new Date().toISOString() };
      for (const p of next.pages) for (const w of p.widgets) if (w.type === 'weather') w.props.useLocation = true;
      setLayout(next);
      try {
        const s2 = await api<Layout>('/api/admin/layout', { method: 'PUT', body: next });
        setSaved(s2); setLayout(clone(s2));
        await api('/api/admin/refresh', { method: 'POST', body: {} });
        loadState();
        show(`已定位到 ${name}（±${Math.round(pos.coords.accuracy)} 米），天气已更新`);
      } catch (e: any) { show('保存失败：' + e.message, 'err'); }
    }, (err) => show('定位失败：' + err.message + '（在系统设置里允许浏览器使用定位）', 'err'), { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
  }

  async function setOrientation(o: Orientation) {
    if (!layout || o === layout.orientation) return;
    const land = (x: Orientation) => x.toLowerCase().includes('landscape');
    if (land(o) !== land(layout.orientation) && confirm(`切换到${land(o) ? '横屏' : '竖屏'}：套用该方向的默认排版？\n（取消 = 只旋转，保留现有组件位置）`)) {
      const s2 = await api<Layout>('/api/admin/layout/reset', { method: 'POST', body: { orientation: o } });
      setSaved(s2); setLayout(clone(s2)); setPageId(s2.pages[0].id); loadState();
      show('已套用新方向的排版');
      return;
    }
    change((l) => {
      const swap = land(o) !== land(l.orientation);
      l.orientation = o;
      if (swap) { const c = l.grid.cols; l.grid.cols = l.grid.rows; l.grid.rows = c; }
      for (const p of l.pages) for (const w of p.widgets) { w.w = Math.min(w.w, l.grid.cols); w.h = Math.min(w.h, l.grid.rows); w.x = Math.min(w.x, l.grid.cols - w.w); w.y = Math.min(w.y, l.grid.rows - w.h); }
    });
  }

  async function command(cmd: string, arg?: string) {
    await api('/api/admin/command', { method: 'POST', body: { cmd, arg } });
    show('指令已发送');
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); return; }
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (!selected || !layout) return;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (mv[e.key]) {
        e.preventDefault();
        change((l) => {
          const w = l.pages.find((p) => p.id === pageId)!.widgets.find((x) => x.id === selected)!;
          if (e.shiftKey) { w.w = Math.max(1, Math.min(l.grid.cols - w.x, w.w + mv[e.key][0])); w.h = Math.max(1, Math.min(l.grid.rows - w.y, w.h + mv[e.key][1])); }
          else { w.x = Math.max(0, Math.min(l.grid.cols - w.w, w.x + mv[e.key][0])); w.y = Math.max(0, Math.min(l.grid.rows - w.h, w.y + mv[e.key][1])); }
        });
      }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeWidget(selected); }
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!layout) return <div class="loading">加载中…</div>;
  const page = layout.pages.find((p) => p.id === pageId) || layout.pages[0];
  const sel = page.widgets.find((w) => w.id === selected) || null;

  function addWidget(type: WidgetType) {
    const cat = catalogOf(type);
    const id = `${type}_${Math.random().toString(36).slice(2, 7)}`;
    change((l) => {
      const p = l.pages.find((x) => x.id === pageId)!;
      // first free slot scanning rows top-down
      const busy = (x: number, y: number) => p.widgets.some((w) => x < w.x + w.w && w.x < x + cat.w && y < w.y + w.h && w.y < y + cat.h);
      let pos = { x: 0, y: Math.max(0, l.grid.rows - cat.h) };
      outer: for (let y = 0; y <= l.grid.rows - cat.h; y++) for (let x = 0; x <= l.grid.cols - cat.w; x++) if (!busy(x, y)) { pos = { x, y }; break outer; }
      p.widgets.push({ id, type, ...pos, w: cat.w, h: cat.h, props: clone(cat.props) });
    });
    setSelected(id);
  }
  function removeWidget(id: string) {
    change((l) => { const p = l.pages.find((x) => x.id === pageId)!; p.widgets = p.widgets.filter((w) => w.id !== id); });
    setSelected(null);
  }
  function duplicateWidget(id: string) {
    const nid = `${id.split('_')[0]}_${Math.random().toString(36).slice(2, 7)}`;
    change((l) => {
      const p = l.pages.find((x) => x.id === pageId)!;
      const w = clone(p.widgets.find((x) => x.id === id)!);
      w.id = nid; w.y = Math.min(l.grid.rows - w.h, w.y + 1); w.x = Math.min(l.grid.cols - w.w, w.x + 1);
      p.widgets.push(w);
    });
    setSelected(nid);
  }
  function addPage() {
    const id = 'p_' + Math.random().toString(36).slice(2, 7);
    const name = prompt('新页面名称', '新页面');
    if (!name) return;
    change((l) => { l.pages.push({ id, name, widgets: [{ id: 'nav_' + id, type: 'nav', x: 0, y: l.grid.rows - 1, w: l.grid.cols, h: 1, props: clone(catalogOf('nav').props), hideTitle: true }] }); });
    setPageId(id);
  }

  const data = state?.data || {};
  const dv = meta?.device;
  const online = dv?.seenAt && Date.now() - Date.parse(dv.seenAt) < 10 * 60_000;

  return (
    <div class="app">
      <header>
        <div class="brand"><span class="logo">▦</span> InkBoard <span class="muted">编辑器</span></div>
        <div class={`dev-pill ${online ? 'on' : ''}`} onClick={() => setTab('device')}>
          <i />{dv ? `${online ? '在线' : '离线'} · ${dv.battery ?? '?'}% · ${ago(dv.seenAt)}` : '设备未连接'}
        </div>
        <div class="spacer" />
        <details class="phone"><summary>📱 手机快速捕获</summary>
          <div class="phone-pop">
            <QR text={`${boot.origin}/c`} />
            <div><b>扫码在手机上打开</b><div class="muted small">{boot.origin}/c</div><div class="hint">首次打开输入同一个管理口令，之后一年免登录。Safari 里“分享 → 添加到主屏幕”，就像一个 App。</div><a class="btn" href="/c" target="_blank">在这台电脑上打开</a></div>
          </div>
        </details>
        <button onClick={undo} disabled={!history.length} title="⌘Z">撤销</button>
        <button onClick={() => command('fullRefresh')}>刷新屏幕</button>
        <button class="primary" onClick={save} disabled={!dirty || saving} title="⌘S">{saving ? '保存中…' : dirty ? '保存并推送' : '已同步'}</button>
      </header>
      <div class="main">
        <aside class="left">
          <nav class="tabs">
            {([['widgets', '组件'], ['tasks', '任务'], ['memory', '记忆'], ['memos', '备忘'], ['sources', '数据源'], ['device', '设备']] as [Tab, string][]).map(([k, n]) => (
              <span class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</span>
            ))}
          </nav>
          <div class="left-body">
            {tab === 'widgets' ? (
              <div class="panel">
                <div class="muted small">点击把组件加到「{page.name}」，在右侧画布拖动/拉右下角调整大小。方向键移动，Shift+方向键改大小，Delete 删除。</div>
                <div class="cat">
                  {CATALOG.map((c) => (
                    <div class="cat-i" onClick={() => addWidget(c.type)}><b>{c.name}</b><span>{c.desc}</span></div>
                  ))}
                </div>
                <h4>本页组件</h4>
                <div class="list">
                  {page.widgets.map((w) => <div class={`li click ${selected === w.id ? 'on' : ''}`} onClick={() => setSelected(w.id)}><span class="li-t">{w.title || catalogOf(w.type).name}</span><span class="tag">{w.x},{w.y} · {w.w}×{w.h}</span></div>)}
                </div>
              </div>
            ) : tab === 'tasks' ? <TasksPanel google={!!meta?.googleConnected} toast={show} />
              : tab === 'memos' ? <MemosPanel toast={show} />
              : tab === 'memory' ? <MemoryPanel toast={show} />
              : tab === 'sources' ? <SourcesPanel meta={meta} reloadMeta={loadMeta} toast={show} />
              : <DevicePanel layout={layout} change={change} meta={meta} command={command} toast={show} locate={locate} setOrientation={setOrientation} />}
          </div>
        </aside>
        <section class="stage" ref={stageRef}>
          <div class="pages">
            {layout.pages.map((p, i) => (
              <span class={`pg ${p.id === page.id ? 'on' : ''}`} onClick={() => { setPageId(p.id); setSelected(null); }}
                onDblClick={() => { const n = prompt('页面名称', p.name); if (n) change((l) => { l.pages[i].name = n; }); }}>
                {p.name}
                {p.id === page.id && layout.pages.length > 1 ? (
                  <>
                    <em title="左移" onClick={(e) => { e.stopPropagation(); if (i > 0) change((l) => { const [x] = l.pages.splice(i, 1); l.pages.splice(i - 1, 0, x); }); }}>‹</em>
                    <em title="右移" onClick={(e) => { e.stopPropagation(); if (i < layout.pages.length - 1) change((l) => { const [x] = l.pages.splice(i, 1); l.pages.splice(i + 1, 0, x); }); }}>›</em>
                    <em title="删除页面" onClick={(e) => { e.stopPropagation(); if (confirm(`删除页面「${p.name}」？`)) { change((l) => { l.pages.splice(i, 1); }); setPageId(layout.pages[i === 0 ? 1 : 0].id); } }}>×</em>
                  </>
                ) : null}
              </span>
            ))}
            <span class="pg add" onClick={addPage}>＋ 页面</span>
          </div>
          <Canvas layout={layout} pageId={page.id} data={data} selected={selected} onSelect={setSelected} onChange={change} scale={scale} />
          <div class="stage-foot muted">{screenSize(layout.orientation).w} × {screenSize(layout.orientation).h} · {layout.grid.cols}×{layout.grid.rows} 网格 · 双击页名改名{dirty ? ' · 有未保存的修改' : ''}</div>
        </section>
        <aside class="right">
          {sel ? (
            <WidgetProps w={sel}
              update={(fn) => change((l) => fn(l.pages.find((p) => p.id === page.id)!.widgets.find((x) => x.id === sel.id)!))}
              remove={() => removeWidget(sel.id)} duplicate={() => duplicateWidget(sel.id)}
              refresh={async () => { if (dirty) await save(); await api('/api/admin/refresh', { method: 'POST', body: { widgetId: sel.id } }); loadState(); show('已刷新'); }} />
          ) : (
            <div class="props">
              <div class="props-h"><b>页面：{page.name}</b><span class="muted">{page.widgets.length} 个组件</span></div>
              <div class="hint">点选画布上的组件编辑属性。新加的组件保存后才会拉取真实数据。</div>
              <h4>快捷操作</h4>
              <div class="btns">
                <button onClick={() => command('page', page.id)}>让设备切到这一页</button>
                <button onClick={async () => { await api('/api/admin/refresh', { method: 'POST', body: {} }); loadState(); show('数据已全部刷新'); }}>刷新全部数据</button>
              </div>
            </div>
          )}
        </aside>
      </div>
      {msg ? <div class={`toast ${msg.kind}`}>{msg.text}</div> : null}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
