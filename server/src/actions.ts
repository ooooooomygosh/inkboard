// Action center: one list of everything that needs the user, one list of everything in progress.
// Sources: AI plan questions, agent-autoloop cards (any AI tool can ask via autoloop), Claude Code /
// Codex sessions waiting for approval, important mail, near deadlines, finished AI jobs to review.
import type { Layout } from '../shared/types';
import { getPlan, localNow } from './ai';
import { listAgents } from './agents';
import { peopleOf } from './money';
import { REPLIES } from './notes';
import { Env, kvGet } from './util';

export const TOOL_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };

export interface ActionItem {
  id: string;               // stable ref used for answering, e.g. q:abc / card:56 / mail:x / job:y
  kind: 'question' | 'card' | 'notice' | 'agent' | 'mail' | 'deadline' | 'review' | 'failed';
  title: string;
  detail?: string;
  source: string;           // 显示用：AI 规划 / Claude Code / 邮件 …
  options?: string[];
  recommend?: number;
  urgent?: boolean;
  ts?: string;
}

export interface DoingItem {
  id: string; kind: 'agent' | 'job' | 'block';
  title: string; detail?: string; source: string; state: string; since?: string;
}

export interface AutoloopState {
  cards: { id: number; kind: string; state: string; title: string; text?: string; options?: string[]; recommend?: number; created?: string; rule?: string; fyi?: boolean }[];
  runs: { id: number; rule: string; state: string; lane?: string; summary?: string; started?: string }[];
  at: string;
}

export async function actionItems(env: Env, layout: Layout): Promise<ActionItem[]> {
  const day = localNow(layout.device.timezone).day;
  const [plan, auto, agents, mails, jobs, ddlRow] = await Promise.all([
    getPlan(env, day),
    kvGet<AutoloopState>(env, 'autoloop:state'),
    listAgents(env),
    env.DB.prepare("SELECT id, sender, summary, subject, action, received FROM mails WHERE important = 1 AND done = 0 AND action IN ('reply','deadline','meeting') ORDER BY received DESC LIMIT 6").all<any>().then((r) => r.results),
    env.DB.prepare("SELECT id, title, status, summary, updated_at FROM jobs WHERE (status = 'done' AND seen = 0) OR status = 'failed' ORDER BY updated_at DESC LIMIT 6").all<any>().then((r) => r.results),
    env.DB.prepare("SELECT json FROM kv WHERE key LIKE 'cache:deadlines:%' LIMIT 1").first<{ json: string }>(),
  ]);
  const out: ActionItem[] = [];
  // 1. agents blocked on an approval: most urgent, the work is literally stopped
  for (const a of agents.filter((x) => x.state === 'waiting')) {
    out.push({ id: `agent:${a.id}`, kind: 'agent', title: `${TOOL_NAME[a.tool] || a.tool} ${/^在问你|^计划写好了/.test(a.message || '') ? '在等你回答' : '等你批准'}`, detail: `${a.title || a.project} · ${a.message || a.step || ''}`, source: a.host || 'Mac', urgent: true, ts: a.updatedAt });
  }
  // 2. agent-autoloop cards (background agents and any AI tool using `agent-autoloop ask/tell`)
  const dismissed = new Set((await kvGet<number[]>(env, 'autoloop:dismissed'))?.value || []);
  for (const c of (auto?.value?.cards || []).filter((x) => x.state === 'open' || (x.fyi && !dismissed.has(x.id)))) {
    const ask = (c.options || []).length > 0;
    if (c.fyi && c.state !== 'open') { out.push({ id: `card:${c.id}`, kind: 'notice', title: c.text || c.title, source: c.title || '通知', options: ['知道了'], ts: c.created }); continue; }
    out.push({ id: `card:${c.id}`, kind: 'card', title: c.title, detail: c.text, source: c.rule || '后台 Agent', options: ask ? c.options : ['已处理'], recommend: c.recommend, urgent: ask, ts: c.created });
  }
  // 2b. Claude desktop sessions whose last turn ended with a question for you (read on the Mac from the app)
  const asks = (await kvGet<{ id: string; title: string; ask: string; at: string; host?: string }[]>(env, 'app:asks'))?.value || [];
  const askGone = new Set((await kvGet<string[]>(env, 'app:asks:dismissed'))?.value || []);
  for (const a of asks) {
    const key = `${a.id}:${hash(a.ask)}`;
    if (askGone.has(key)) continue;
    out.push({ id: `ask:${key}`, kind: 'agent', title: a.ask, detail: a.title, source: `Claude 会话${a.host ? ' · ' + a.host : ''}`, options: ['知道了'], urgent: true, ts: a.at });
  }
  // 2c. GitHub: a PR waiting for your review, a default branch whose CI went red
  const gh = (await kvGet<any>(env, 'cache:github'))?.value?.value;
  const ghGone = new Set((await kvGet<string[]>(env, 'gh:dismissed'))?.value || []);
  for (const r of gh?.reviews || []) {
    const key = `review:${r.repo}#${r.number}`;
    if (!ghGone.has(key)) out.push({ id: `gh:${key}`, kind: 'card', title: `等你 review：${r.title}`, detail: `${r.repo} #${r.number} · ${r.author || ''}`, source: 'GitHub', options: ['知道了'], urgent: true });
  }
  for (const r of (gh?.repos || []).filter((x: any) => x.ci === 'FAILURE' || x.ci === 'ERROR')) {
    const key = `ci:${r.repo}:${r.pushedAt}`; // a new push that fails again shows up again
    if (!ghGone.has(key)) out.push({ id: `gh:${key}`, kind: 'failed', title: `${r.repo} 主分支 CI 失败`, detail: `最近推送 ${r.pushedAt.slice(5, 16).replace('T', ' ')}`, source: 'GitHub', options: ['知道了'], ts: r.pushedAt });
  }
  // 2d. little notes from the ledger page, until they get an answer
  const P = peopleOf(layout);
  const notes = (await env.DB.prepare("SELECT id, title, due, from_who, created_at FROM notes WHERE status = 'sent' ORDER BY created_at").all<any>()).results;
  for (const n of notes) {
    const when = n.due ? ` · ${+n.due.slice(5, 7)}/${+n.due.slice(8, 10)}${n.due.includes('T') ? ' ' + n.due.slice(11, 16) : ''}` : '';
    out.push({ id: `note:${n.id}`, kind: 'card', title: `${P[n.from_who === 'me' ? 'me' : 'partner']}：${n.title}`, detail: `小纸条${when}`, source: `${P[n.from_who === 'me' ? 'me' : 'partner']} 的小纸条`, options: REPLIES.map((r) => r.label), recommend: 0, urgent: true, ts: n.created_at });
  }
  // 3. the planner's own questions
  for (const q of plan?.questions || []) out.push({ id: `q:${q.id}`, kind: 'question', title: q.q, source: 'AI 规划', options: q.options });
  // 4. finished / failed AI jobs to look at
  for (const j of jobs) {
    out.push(j.status === 'failed'
      ? { id: `job:${j.id}`, kind: 'failed', title: `AI 没做成：${j.title}`, detail: j.summary || '', source: '交给 AI', options: ['知道了'], urgent: true, ts: j.updated_at }
      : { id: `job:${j.id}`, kind: 'review', title: j.summary || `AI 做完了：${j.title}`, detail: j.title, source: '交给 AI', options: ['收到'], ts: j.updated_at });
  }
  // 5. mail that needs a reply / has a deadline
  for (const m of mails) out.push({ id: `mail:${m.id}`, kind: 'mail', title: m.summary || m.subject, detail: String(m.sender || '').replace(/<.*>/, '').trim(), source: '邮件', options: ['处理了'], urgent: m.action === 'deadline', ts: m.received });
  // 6. deadlines within 3 days
  const ddl = ddlRow ? (JSON.parse(ddlRow.json).value || []) as any[] : [];
  for (const d of ddl.filter((x) => Date.parse(x.at) > Date.now() && Date.parse(x.at) - Date.now() < 3 * 86400_000)) {
    out.push({ id: `ddl:${d.name}`, kind: 'deadline', title: `${d.name} ${d.detail || ''} 截止`, source: '截止日', urgent: true, ts: d.at });
  }
  return out;
}

export function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function doingItems(env: Env, layout: Layout): Promise<DoingItem[]> {
  const tz = layout.device.timezone;
  const now = localNow(tz);
  const [plan, auto, agents, jobs] = await Promise.all([
    getPlan(env, now.day),
    kvGet<AutoloopState>(env, 'autoloop:state'),
    listAgents(env),
    env.DB.prepare("SELECT id, title, status, updated_at, created_at FROM jobs WHERE status IN ('queued','sent','running','asking') ORDER BY created_at").all<any>().then((r) => r.results),
  ]);
  const out: DoingItem[] = [];
  for (const a of agents.filter((x) => x.state === 'running' || x.state === 'waiting')) {
    out.push({ id: `agent:${a.id}`, kind: 'agent', title: a.title || a.project, detail: a.state === 'waiting' ? a.message || '等你批准' : a.step || '思考中', source: `${TOOL_NAME[a.tool] || a.tool}${a.host && a.host !== 'Mac' ? ' · ' + a.host : ''}`, state: a.state, since: a.turnStartedAt || a.updatedAt });
  }
  const STATE: Record<string, string> = { queued: '排队中', sent: '已派出', running: '后台执行中', asking: '等你回答' };
  for (const j of jobs) out.push({ id: `job:${j.id}`, kind: 'job', title: j.title, source: '交给 AI', state: STATE[j.status] || j.status, since: j.created_at });
  // other autoloop runs (rules other than InkBoard's own jobs, e.g. a morning brief or issue triage)
  for (const r of (auto?.value?.runs || []).filter((x) => (x.state === 'claimed' || x.state === 'queued') && x.rule !== 'InkBoard 代办')) {
    out.push({ id: `run:${r.id}`, kind: 'job', title: r.rule, detail: r.lane || '', source: '自动化', state: r.state === 'claimed' ? '执行中' : '排队中', since: r.started });
  }
  const m = now.hour * 60 + now.minute;
  const toMin = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + (mm || 0); };
  const cur = (plan?.blocks || []).find((b) => toMin(b.start) <= m && (b.end ? toMin(b.end) : toMin(b.start) + 30) > m && b.kind !== 'break');
  if (cur) out.push({ id: 'block:now', kind: 'block', title: cur.title, detail: `${cur.start}–${cur.end}`, source: '你 · 按计划', state: '进行中' });
  return out;
}
