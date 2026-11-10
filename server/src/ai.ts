// AI layer (DeepSeek Flash, high reasoning effort by default).
// Token economy: compact context (token-budgeted memory view), incremental plan merges,
// results cached in D1, model runs only on new input or at fixed local times.
import type { Layout, QuotaProvider, UsageProvider } from '../shared/types';
import { FACT_RULES, UNTRUSTED, getObservation, memoryView, upsertFacts } from './memory';
import { Env, getSecrets, kvGet, kvSet, nowIso, uid } from './util';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
type Effort = 'high' | 'low' | 'off';

export async function deepseek(env: Env, system: string, user: string, opts: { maxTokens?: number; effort?: Effort } = {}): Promise<any> {
  const s = await getSecrets(env);
  if (!s.deepseek_key) throw new Error('未配置 DeepSeek API key');
  const effort: Effort = opts.effort || (s.ai_effort as Effort) || 'high';
  if (system.includes('{{ABOUT}}')) {
    const p = (await kvGet<Layout>(env, 'layout'))?.value?.profile;
    const about = [p?.city ? `用户在${p.city}。` : '', p?.about || ''].join('').trim();
    system = system.replace('{{ABOUT}}', about);
  }
  const body: any = {
    model: s.ai_model || 'deepseek-flash',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    // reasoning tokens count toward max_tokens, so leave headroom when thinking
    max_tokens: (opts.maxTokens || 800) + (effort === 'high' ? 6000 : effort === 'low' ? 1500 : 0),
  };
  if (effort === 'off') body.thinking = { type: 'disabled' };
  else body.reasoning_effort = effort;
  const r = await fetch(ENDPOINT, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${s.deepseek_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || `DeepSeek ${r.status}`);
  const day = new Date().toISOString().slice(0, 10);
  const prev = (await kvGet<any>(env, 'ai:usage'))?.value;
  const u = prev && prev.day === day ? prev : { day, tokens: 0, reasoning: 0, calls: 0 };
  u.tokens += j.usage?.total_tokens || 0;
  u.reasoning = (u.reasoning || 0) + (j.usage?.completion_tokens_details?.reasoning_tokens || 0);
  u.calls += 1;
  await kvSet(env, 'ai:usage', u);
  const text = j.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(text); } catch { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
}

// {{ABOUT}} is filled from the editor's "关于你" (layout.profile) when the prompt is sent.
const ROLE = `你是用户的个人助理，内容会显示在用户书桌上的墨水屏看板和手机上。{{ABOUT}}
写作要求：中文，短、具体、可执行；不用 emoji；不说教；不编造资料里没有的事实。`;

export function localNow(tz: string) {
  const f = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p: any = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: +p.hour, minute: +p.minute, text: `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute}` };
}
const fmtT = (iso: string, tz: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export async function calendarEvents(env: Env, tz: string, days = 2) {
  const out: string[] = [];
  const outlook = (await kvGet<any[]>(env, 'outlook:events'))?.value || [];
  const until = Date.now() + days * 86400_000;
  for (const e of outlook) if (Date.parse(e.end) > Date.now() && Date.parse(e.start) < until) out.push(`${e.allDay ? e.start.slice(0, 10) + ' 全天' : fmtT(e.start, tz) + '-' + fmtT(e.end, tz).slice(-5)} ${e.title}${e.location ? ' @' + e.location : ''}`);
  return out.slice(0, 15);
}

// ================================================================ ② day planner (quick capture → plan)
export interface PlanBlock { start: string; end: string; title: string; kind?: 'task' | 'event' | 'break' }
export interface PlanQuestion { id: string; q: string; options: string[] }
export interface DayPlan { day: string; summary: string; blocks: PlanBlock[]; notes: string[]; questions: PlanQuestion[]; updatedAt: string; captures: number }

export async function getPlan(env: Env, day: string): Promise<DayPlan | null> {
  return (await kvGet<DayPlan>(env, `plan:${day}`))?.value || null;
}

/** Merge new free text into today's plan. One call also extracts long-term facts. */
export async function updatePlan(env: Env, layout: Layout, newText: string, opts: { answer?: { q: string; a: string } } = {}) {
  const tz = layout.device.timezone;
  const now = localNow(tz);
  const plan = await getPlan(env, now.day);
  const open = (await env.DB.prepare("SELECT id, title, due, priority, est_min, day, done FROM tasks WHERE (done = 0 OR (done = 1 AND day = ?)) AND source IN ('plan','local') ORDER BY done, priority, sort LIMIT 40").bind(now.day).all<any>()).results;
  const ctx = {
    现在: now.text,
    今天已有计划: plan ? { 主线: plan.summary, 时间块: plan.blocks, 备注: plan.notes } : null,
    现有任务: open.map((t: any) => ({ id: t.id, 标题: t.title, 截止: t.due, 优先级: t.priority, 预计分钟: t.est_min, 来自: t.day && t.day !== now.day ? `${t.day} 遗留` : '今天', 已完成: !!t.done })),
    日历: await calendarEvents(env, tz, 2),
    长期记忆: await memoryView(env, 600),
    新输入: opts.answer ? `（回答助理的问题「${opts.answer.q}」）${opts.answer.a}` : newText,
  };
  const system = `${ROLE}
你在维护用户“今天”的计划。用户会随时用一大段话补充想做的事。把新输入合并进已有计划，输出完整的新计划（不是增量）。${UNTRUSTED}
只输出 JSON：
{"summary": "今天的主线，≤24字",
 "tasks": [{"id": "沿用已有任务 id；新任务给 null", "title": "动词开头，≤24字", "due": "YYYY-MM-DD 或 YYYY-MM-DDTHH:MM 或 null", "priority": 1-3（1最高）, "estMin": 预计分钟数或 null, "done": 是否已完成, "ai": 这件事能否交给 Mac 上的 AI Agent 独立完成（起草邮件/文字、查资料写摘要、整理笔记、写或跑脚本、做表格计算等算 true；需要用户本人到场、做决定、做实验判断、线下办事算 false）, "aiHow": "ai 为 true 时写 AI 会产出什么，≤30字，否则 null"}],
 "blocks": [{"start": "HH:MM", "end": "HH:MM", "title": "≤16字", "kind": "task|event|break"}],
 "notes": ["不是任务但值得记下的事，≤30字"],
 "questions": [{"q": "真正拿不准、会影响安排的问题，≤24字", "options": ["2-4个简短选项"]}],
 ${FACT_RULES.replace('facts：', '"facts": ')}}
规则：
1. 现有任务除非用户说取消/已完成，都要保留（遗留任务可以改到今天或保留原截止日）；用户说做完了就 done=true。
2. blocks 从现在之后排到晚上，避开日历里的固定安排，把日历事件也作为 kind=event 放进去；按优先级和预计时长安排，留出休息。
3. questions 最多 2 个，没有就 []。不要为了问而问。`;
  const out = await deepseek(env, system, JSON.stringify(ctx), { maxTokens: 1800 });

  const keep = new Set<string>();
  const st: D1PreparedStatement[] = [];
  const ts = nowIso();
  (out.tasks || []).slice(0, 30).forEach((t: any, i: number) => {
    if (!t?.title) return;
    const existing = t.id && open.find((o: any) => o.id === t.id);
    if (existing) {
      keep.add(existing.id);
      st.push(env.DB.prepare('UPDATE tasks SET title = ?, due = ?, priority = ?, est_min = ?, done = ?, done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END, day = ?, sort = ?, ai_ok = ?, ai_how = ?, updated_at = ? WHERE id = ?')
        .bind(String(t.title).slice(0, 60), t.due || null, +t.priority || 2, t.estMin ? +t.estMin : null, t.done ? 1 : 0, t.done ? 1 : 0, ts, now.day, i, t.ai ? 1 : 0, t.ai && t.aiHow ? String(t.aiHow).slice(0, 60) : null, ts, existing.id));
    } else {
      const id = 't_' + uid();
      keep.add(id);
      st.push(env.DB.prepare("INSERT INTO tasks (id, title, due, done, source, sort, day, priority, est_min, done_at, ai_ok, ai_how, updated_at) VALUES (?,?,?,?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, String(t.title).slice(0, 60), t.due || null, t.done ? 1 : 0, i, now.day, +t.priority || 2, t.estMin ? +t.estMin : null, t.done ? ts : null, t.ai ? 1 : 0, t.ai && t.aiHow ? String(t.aiHow).slice(0, 60) : null, ts));
    }
  });
  // plan tasks the model dropped (not done) are removed; manual tasks are never deleted by AI
  for (const o of open) if (!keep.has(o.id) && !o.done) st.push(env.DB.prepare("DELETE FROM tasks WHERE id = ? AND source = 'plan'").bind(o.id));
  if (st.length) await env.DB.batch(st);

  const next: DayPlan = {
    day: now.day,
    summary: String(out.summary || plan?.summary || ''),
    blocks: (out.blocks || []).filter((b: any) => b?.start && b?.title).slice(0, 16).map((b: any) => ({ start: String(b.start).slice(0, 5), end: String(b.end || '').slice(0, 5), title: String(b.title).slice(0, 30), kind: b.kind })),
    notes: (out.notes || []).slice(0, 8).map(String),
    questions: (out.questions || []).slice(0, 2).filter((q: any) => q?.q).map((q: any) => ({ id: uid(6), q: String(q.q), options: (q.options || []).slice(0, 4).map(String) })),
    updatedAt: nowIso(),
    captures: (plan?.captures || 0) + 1,
  };
  await kvSet(env, `plan:${now.day}`, next);
  await upsertFacts(env, out.facts, 'capture');
  return next;
}

// ================================================================ daily brief
export async function generateBrief(env: Env, layout: Layout) {
  const tz = layout.device.timezone;
  const now = localNow(tz);
  const [plan, tasks, quotas, agents, usage, mails, research, obs, wx] = await Promise.all([
    getPlan(env, now.day),
    env.DB.prepare('SELECT title, due, priority FROM tasks WHERE done = 0 ORDER BY priority, CASE WHEN due IS NULL THEN 1 ELSE 0 END, due LIMIT 10').all<any>().then((r) => r.results),
    env.DB.prepare('SELECT json FROM quotas').all<any>().then((r) => r.results.map((x: any) => JSON.parse(x.json) as QuotaProvider)),
    env.DB.prepare('SELECT tool, project, state, message FROM agent_sessions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 8').bind(new Date(Date.now() - 24 * 3600_000).toISOString()).all<any>().then((r) => r.results),
    kvGet<Record<string, UsageProvider>>(env, 'usage'),
    env.DB.prepare('SELECT sender, summary, action FROM mails WHERE important = 1 AND done = 0 ORDER BY received DESC LIMIT 5').all<any>().then((r) => r.results),
    kvGet<any>(env, 'ai:research'),
    getObservation(env),
    env.DB.prepare("SELECT json FROM kv WHERE key LIKE 'cache:weather:%' LIMIT 1").first<{ json: string }>(),
  ]);
  const w = wx ? JSON.parse(wx.json).value : null;
  const ctx = {
    现在: now.text,
    今日计划: plan ? { 主线: plan.summary, 时间块: plan.blocks.slice(0, 8) } : null,
    待办: tasks.map((t: any) => `${t.title}${t.due ? `（截止 ${String(t.due).slice(0, 10)}）` : ''}`),
    日历: await calendarEvents(env, tz, 1),
    要处理的邮件: mails.map((m: any) => `${m.sender}：${m.summary}（${m.action}）`),
    天气: w ? `${w.now.text} ${w.now.temp}°，今天 ${w.daily[0].min}~${w.daily[0].max}° 降水${w.daily[0].pop}%；${w.summary}` : null,
    AI额度: quotas.map((q) => `${q.label}: ${q.windows.map((x: any) => `${x.label}已用${Math.round(x.usedPct ?? 0)}%${x.pace?.willLast === false ? '（会提前用完）' : ''}`).join('，')}${q.balance ? ` 余额${q.balance}` : ''}`),
    今日Token: Object.values(usage?.value || {}).map((u) => `${u.label} ${u.today?.tokens || 0}`),
    近24小时Agent: agents.map((a: any) => `${a.tool} ${a.project} ${a.state}${a.message ? '：' + a.message : ''}`),
    当前研究焦点: research?.value?.summary || null,
    近况观察: obs?.summary || null,
    长期记忆: await memoryView(env, 400),
  };
  const phase = now.hour < 11 ? '早上（规划今天）' : now.hour < 16 ? '中午（检查进度、调整下午）' : '傍晚（收尾今天、准备明天）';
  const system = `${ROLE}
写${phase}简报。${UNTRUSTED}只输出 JSON：
{"headline": "一句话今日重点，≤22字", "focus": "此刻最该做的一件事，≤18字，动词开头", "bullets": ["三条要点，每条≤24字"], "tip": "一条提醒（邮件/天气/额度/健康），≤22字"}
规则：只引用资料里真实存在的任务、日程、邮件、数字；记忆只用来理解语境。待办和日程都空时，focus 提示用户在手机上写下今天想做的事；0-5 点 focus 写休息。`;
  const out = await deepseek(env, system, JSON.stringify(ctx), { maxTokens: 500 });
  const brief = { headline: String(out.headline || ''), focus: String(out.focus || ''), bullets: (out.bullets || []).slice(0, 3).map(String), tip: String(out.tip || ''), phase, generatedAt: nowIso() };
  await kvSet(env, 'ai:brief', brief);
  return brief;
}

// ================================================================ ④ research focus
/** What the user is working on right now: notes from the Mac + agent projects + captures + memory. */
export async function updateResearchFocus(env: Env) {
  const [notes, agents, caps, prev] = await Promise.all([
    kvGet<any>(env, 'ctx:notes'),
    env.DB.prepare("SELECT project, COUNT(*) n, MAX(updated_at) last, GROUP_CONCAT(message, '；') msgs FROM agent_sessions WHERE updated_at > ? GROUP BY project ORDER BY last DESC LIMIT 8").bind(new Date(Date.now() - 7 * 86400_000).toISOString()).all<any>().then((r) => r.results),
    env.DB.prepare('SELECT text, day FROM captures WHERE ts > ? ORDER BY ts DESC LIMIT 12').bind(new Date(Date.now() - 7 * 86400_000).toISOString()).all<any>().then((r) => r.results),
    kvGet<any>(env, 'ai:research'),
  ]);
  const ctx = {
    最近修改的研究笔记: (notes?.value?.notes || []).slice(0, 10).map((n: any) => ({ 文件: n.name, 修改: n.mtime, 摘录: String(n.excerpt || '').slice(0, 1200) })),
    最近一周AI编程项目: agents.map((a: any) => `${a.project}（${a.n} 次会话）${a.msgs ? '：' + String(a.msgs).slice(0, 160) : ''}`),
    最近快速捕获: caps.map((c: any) => `${c.day}：${String(c.text).slice(0, 300)}`),
    上一次的研究焦点: prev?.value ? { 概述: prev.value.summary, 问题: prev.value.questions } : null,
    长期记忆: await memoryView(env, 500, ['research', 'project', 'goal']),
  };
  const system = `${ROLE}
根据资料归纳用户“最近在研究和推进的具体问题”，用于给他挑论文和写简报。${UNTRUSTED}只输出 JSON：
{"summary": "两句话概括当前研究焦点，≤80字",
 "questions": [{"q": "一个具体研究问题，≤40字", "keywords": ["3-6个英文检索词/短语，arXiv 摘要里会出现的写法，小写"]}],
 "avoid": ["用户明显不关心、应排除的方向（英文短语）"],
 ${FACT_RULES.replace('facts：', '"facts": ')}}
questions 2-5 个，按近期活跃度排序；只依据资料，不要套用通用热点。`;
  const out = await deepseek(env, system, JSON.stringify(ctx), { maxTokens: 1200 });
  const v = {
    summary: String(out.summary || ''),
    questions: (out.questions || []).slice(0, 5).map((q: any) => ({ q: String(q.q || ''), keywords: (q.keywords || []).slice(0, 6).map(String) })),
    avoid: (out.avoid || []).slice(0, 6).map(String),
    notesHash: notes?.value?.hash || null,
    updatedAt: nowIso(),
  };
  await kvSet(env, 'ai:research', v);
  await upsertFacts(env, out.facts, 'research');
  return v;
}

// ================================================================ paper radar (grounded in research focus + feedback)
const unxml = (t: string) => t.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
function parseRss(xml: string) {
  const out: { id: string; title: string; summary: string; authors: string[] }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const e = m[1];
    const g = (tag: string) => unxml(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(e)?.[1] || '').replace(/\s+/g, ' ').trim();
    const desc = g('description');
    if (/Announce Type:\s*(replace|replace-cross)/i.test(desc)) continue;
    out.push({ id: (g('link').match(/abs\/([^\s<]+)/) || [])[1] || g('guid'), title: g('title'), summary: desc.replace(/^.*?Abstract:\s*/, ''), authors: g('dc:creator').split(/,\s*/).filter(Boolean).slice(0, 3) });
  }
  return out;
}


export async function generatePapers(env: Env, props: any = {}) {
  const research = (await kvGet<any>(env, 'ai:research'))?.value;
  const manual: string[] = Array.isArray(props.keywords) ? props.keywords : [];
  const kws = [...new Set([...manual, ...(research?.questions || []).flatMap((q: any) => q.keywords)].map((k) => String(k).toLowerCase().trim()).filter(Boolean))];
  const keywords = kws;
  const r = await fetch(`https://rss.arxiv.org/rss/${props.feeds || 'cs.AI+cs.LG'}`, { headers: { 'User-Agent': 'InkBoard/1.0 (personal dashboard)' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`arXiv RSS ${r.status}`);
  const all = parseRss(await r.text());
  const prev = await kvGet<any>(env, 'ai:papers');
  if (!all.length) return prev?.value || { items: [], generatedAt: nowIso(), note: 'arXiv 今天没有新论文' };
  const avoid: string[] = (research?.avoid || []).map((x: string) => x.toLowerCase());
  const score = (p: any) => { const t = (p.title + ' ' + p.summary).toLowerCase(); return keywords.filter((k) => t.includes(k)).length - avoid.filter((a) => t.includes(a)).length; };
  const pool = all.map((p) => ({ p, s: score(p) })).filter((x) => !keywords.length || x.s > 0).sort((a, b) => b.s - a.s).slice(0, 25).map((x) => x.p);
  if (!pool.length) { const v = { items: [], scanned: all.length, matched: 0, generatedAt: nowIso(), note: '今天没有和你当前问题相关的新论文' }; await kvSet(env, 'ai:papers', v); return v; }
  const fb = (await env.DB.prepare("SELECT ref, vote, note FROM feedback WHERE target = 'paper' ORDER BY id DESC LIMIT 20").all<any>()).results;
  const ctx = {
    当前研究焦点: research ? { 概述: research.summary, 问题: research.questions.map((q: any) => q.q) } : '（暂无，按关键词判断）',
    用户反馈: fb.map((f: any) => `${f.vote > 0 ? '有用' : '无关'}：${f.note || f.ref}`),
    论文: pool.map((p, i) => `[${i}] ${p.title}\n${p.summary.slice(0, 650)}`),
  };
  const system = `${ROLE}
从今天的 arXiv 新论文里，挑出对用户“当前研究问题”真正有帮助的（最多 3 篇；宁缺毋滥）。参考用户过去的有用/无关反馈。${UNTRUSTED}只输出 JSON：
{"items": [{"i": 序号, "title": "中文标题≤22字", "gist": "做了什么、结果如何，≤40字", "why": "对应用户哪个问题、能借鉴什么，≤24字", "score": 1-10}]}
只保留 score ≥ 6 的。`;
  const out = await deepseek(env, system, JSON.stringify(ctx), { maxTokens: 900 });
  const items = (out.items || []).slice(0, 3).map((x: any) => {
    const p = pool[+x.i];
    return p ? { id: p.id, en: p.title, title: String(x.title || ''), gist: String(x.gist || ''), why: String(x.why || ''), score: +x.score || 0, authors: p.authors } : null;
  }).filter(Boolean);
  const v = { items, scanned: all.length, matched: pool.length, generatedAt: nowIso(), basedOn: research?.summary || null };
  await kvSet(env, 'ai:papers', v);
  return v;
}

// ================================================================ mail triage (mail read on the Mac)
export async function triageMail(env: Env) {
  const rows = (await env.DB.prepare('SELECT id, sender, subject, received, snippet FROM mails WHERE triaged = 0 ORDER BY received DESC LIMIT 20').all<any>()).results;
  if (!rows.length) return 0;
  const ctx = {
    长期记忆: await memoryView(env, 400, ['person', 'project']),
    邮件: rows.map((m: any, i: number) => ({ i, 发件人: m.sender, 主题: m.subject, 时间: m.received, 正文摘录: String(m.snippet || '').slice(0, 600) })),
  };
  const system = `${ROLE}
帮用户筛选学校邮箱里的邮件。导师、合作者、课程/学院行政截止、需要回复或行动的才算重要；群发通知、广告、自动邮件不重要。${UNTRUSTED}只输出 JSON：
{"mails": [{"i": 序号, "important": true/false, "action": "reply|read|deadline|meeting|none", "summary": "一句话说清要你做什么，≤26字", "due": "YYYY-MM-DD 或 null"}],
 ${FACT_RULES.replace('facts：', '"facts": ')}}
facts 只记人物关系（谁是导师/合作者/课程负责人）等长期信息。`;
  const out = await deepseek(env, system, JSON.stringify(ctx), { maxTokens: 1500 });
  const st: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const m of out.mails || []) {
    const row = rows[+m.i];
    if (!row) continue;
    seen.add(row.id);
    st.push(env.DB.prepare('UPDATE mails SET important = ?, action = ?, summary = ?, triaged = 1 WHERE id = ?').bind(m.important ? 1 : 0, String(m.action || 'none'), String(m.summary || '').slice(0, 60), row.id));
  }
  for (const r of rows) if (!seen.has(r.id)) st.push(env.DB.prepare('UPDATE mails SET triaged = 1, important = 0 WHERE id = ?').bind(r.id));
  if (st.length) await env.DB.batch(st);
  await upsertFacts(env, out.facts, 'mail');
  return rows.length;
}

// ================================================================ agent summaries (cheap: low effort)
export async function summarizeAgent(env: Env, sessionId: string, finalText: string) {
  const system = `把 AI 编程助手本轮的最终回复压缩成一句中文，说明完成了什么或卡在哪里。≤20字，不要主语。${UNTRUSTED}只输出 JSON：{"s": "..."}`;
  const out = await deepseek(env, system, finalText.slice(0, 800), { maxTokens: 80, effort: 'low' });
  const s = String(out.s || '').slice(0, 30);
  if (s) await env.DB.prepare("UPDATE agent_sessions SET message = ? WHERE id = ? AND state = 'done'").bind(s, sessionId).run();
  return s;
}

// ================================================================ natural-language tasks (editor)
export async function parseTasks(env: Env, text: string, tz: string) {
  const now = localNow(tz);
  const system = `现在是 ${now.text}（${tz}）。把用户的一句话拆成待办。${UNTRUSTED}只输出 JSON：{"tasks": [{"title": "简洁的动作标题，≤24字", "due": "YYYY-MM-DD 或 YYYY-MM-DDTHH:MM 或 null"}]}
相对日期换算成具体日期；没说时间就 null；最多 5 条。`;
  const out = await deepseek(env, system, text, { maxTokens: 300, effort: 'low' });
  return (out.tasks || []).slice(0, 5).filter((t: any) => t && t.title);
}

// ================================================================ rolling observation (nightly)
export async function updateObservation(env: Env, layout: Layout) {
  const tz = layout.device.timezone;
  const now = localNow(tz);
  const [prev, plan, done, caps, agents, mails] = await Promise.all([
    getObservation(env),
    getPlan(env, now.day),
    env.DB.prepare('SELECT title FROM tasks WHERE done = 1 AND done_at > ?').bind(new Date(Date.now() - 86400_000).toISOString()).all<any>().then((r) => r.results.map((t: any) => t.title)),
    env.DB.prepare('SELECT text FROM captures WHERE day = ?').bind(now.day).all<any>().then((r) => r.results.map((c: any) => String(c.text).slice(0, 400))),
    env.DB.prepare('SELECT project, message FROM agent_sessions WHERE updated_at > ? AND message IS NOT NULL').bind(new Date(Date.now() - 86400_000).toISOString()).all<any>().then((r) => r.results.map((a: any) => `${a.project}：${a.message}`)),
    env.DB.prepare('SELECT sender, summary FROM mails WHERE important = 1 AND received > ?').bind(new Date(Date.now() - 86400_000).toISOString()).all<any>().then((r) => r.results.map((m: any) => `${m.sender}：${m.summary}`)),
  ]);
  if (!plan && !done.length && !caps.length && !agents.length) return prev;
  const system = `${ROLE}
你在维护一份关于用户近况的连续观察记录（像助理的工作日志）：在做什么、推进到哪、卡在哪、在等谁、有哪些反复出现的模式。把“今天”的新资料并入旧记录，删掉已经过时的内容。${UNTRUSTED}
只输出 JSON：{"summary": "中文紧凑记录，≤600字，按主题分段，保留名字、时间线和未完成事项", ${FACT_RULES.replace('facts：', '"facts": ')}}`;
  const out = await deepseek(env, system, JSON.stringify({ 旧记录: prev?.summary || '', 今天: now.day, 今日计划: plan?.summary, 完成的任务: done, 快速捕获: caps, Agent: agents, 重要邮件: mails }), { maxTokens: 1000 });
  const v = { summary: String(out.summary || prev?.summary || '').slice(0, 900), updatedAt: nowIso() };
  await kvSet(env, 'ai:observation', v);
  await upsertFacts(env, out.facts, 'observation');
  return v;
}

/** Called from cron every 5 minutes; each job decides for itself whether it is due. */
export async function aiCron(env: Env, layout: Layout) {
  const s = await getSecrets(env);
  if (!s.deepseek_key) return;
  const now = localNow(layout.device.timezone);
  const age = async (key: string) => { const v = await kvGet<any>(env, key); return v ? Date.now() - Date.parse(v.value.generatedAt || v.value.updatedAt) : Infinity; };
  const at = (h: number, m: number) => now.hour === h && now.minute >= m && now.minute < m + 5;

  if ((at(6, 30) || at(12, 0) || at(17, 30)) && (await age('ai:brief')) > 30 * 60_000) await generateBrief(env, layout).catch(() => {});
  await triageMail(env).catch(() => {});
  const research = (await kvGet<any>(env, 'ai:research'))?.value;
  const notesHash = (await kvGet<any>(env, 'ctx:notes'))?.value?.hash;
  const rAge = research ? Date.now() - Date.parse(research.updatedAt) : Infinity;
  if ((at(5, 0) && rAge > 3600_000) || rAge > 30 * 3600_000 || (notesHash && notesHash !== research?.notesHash && rAge > 6 * 3600_000)) await updateResearchFocus(env).catch(() => {});
  if ((await age('ai:papers')) > 20 * 3600_000 && now.hour >= 10) {
    const props = layout.pages.flatMap((p) => p.widgets).find((w) => w.type === 'ai' && w.props?.mode === 'papers')?.props;
    await generatePapers(env, props).catch(() => {});
  }
  if (at(23, 0)) await updateObservation(env, layout).catch(() => {});
}
