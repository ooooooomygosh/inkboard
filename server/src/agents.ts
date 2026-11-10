import type { AgentSession, AgentState } from '../shared/types';
import { Env, kvGet, kvSet, nowIso } from './util';

export interface AgentEvent {
  tool: 'claude' | 'codex' | 'dsh';
  session: string;
  event: string;            // SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | PermissionRequest | Notification | Stop | SubagentStop | SessionEnd | TurnComplete | ToolCall
  host?: string;
  cwd?: string;
  branch?: string;
  title?: string;
  toolName?: string;
  summary?: string;
  message?: string;
  ts?: string;
}

const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : undefined);
const base = (p?: string) => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '');

export async function ingestAgentEvent(env: Env, e: AgentEvent) {
  const id = `${e.tool}:${e.session}`;
  const ts = e.ts || nowIso();
  const cur = await env.DB.prepare('SELECT * FROM agent_sessions WHERE id = ?').bind(id).first<any>();
  // Title only (the Mac reads it from the Claude desktop app): never creates a session or changes its state.
  if (e.event === 'Meta') {
    if (!e.title) return;
    if (cur) { if (e.title !== cur.title) await env.DB.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?').bind(clip(e.title, 60), id).run(); }
    else await kvSet(env, `title:${id}`, clip(e.title, 60)); // the session may report later
    return;
  }
  const remembered = cur ? null : (await kvGet<string>(env, `title:${id}`))?.value || null;
  const s = cur || {
    id, tool: e.tool, host: e.host || '', project: base(e.cwd), branch: e.branch || null, title: remembered,
    state: 'idle', step: null, message: null, tool_calls: 0, turn_started_at: null, last_turn_sec: null, started_at: ts, updated_at: ts,
  };
  if (e.host) s.host = e.host;
  if (e.cwd) s.project = base(e.cwd);
  if (e.branch) s.branch = e.branch;
  if (e.title) s.title = clip(e.title, 60);

  const step = e.toolName ? clip(`${e.toolName}${e.summary ? ': ' + e.summary : ''}`, 90) : clip(e.summary, 90);
  let kind = e.event;
  switch (e.event) {
    case 'SessionStart':
      s.state = 'idle'; s.step = null; s.message = null; break;
    case 'UserPromptSubmit':
      s.state = 'running'; s.turn_started_at = ts; s.tool_calls = 0; s.step = '思考中'; s.message = null; break;
    case 'PreToolUse':
    case 'ToolCall':
      // tools that stop and wait for the person: a multiple-choice question, or approving a plan
      if (/^(AskUserQuestion|ExitPlanMode|request_user_input)$/.test(e.toolName || '')) {
        s.state = 'waiting'; s.message = clip(e.toolName === 'ExitPlanMode' ? '计划写好了，等你批准' : `在问你：${e.summary || '一个问题'}`, 80);
        if (!s.turn_started_at) s.turn_started_at = ts;
        break;
      }
      if (s.state !== 'running') { s.state = 'running'; if (!s.turn_started_at || s.state === 'done') s.turn_started_at = ts; }
      s.tool_calls = (s.tool_calls || 0) + 1; s.step = step || s.step; s.message = null; break;
    case 'PostToolUse':
      if (s.state === 'waiting') s.state = 'running';
      break;
    case 'PermissionRequest':
      s.state = 'waiting'; s.message = clip(e.message || (step ? `请求批准 ${step}` : '请求你批准一个操作'), 80); break;
    case 'Notification': {
      const m = e.message || '';
      // Permission prompts are the ones that need you; idle reminders are informational.
      if (/permission|approve|允许|确认/i.test(m)) { s.state = 'waiting'; s.message = clip(m, 80); }
      else if (s.state !== 'running') { s.state = 'idle'; s.message = clip(m, 80); }
      break;
    }
    case 'Stop':
    case 'TurnComplete':
      if (s.turn_started_at) s.last_turn_sec = Math.max(0, Math.round((Date.parse(ts) - Date.parse(s.turn_started_at)) / 1000));
      s.state = 'done'; s.step = null; s.message = clip(e.summary || e.message, 90) || null; break;
    case 'SubagentStop':
      break;
    case 'SessionEnd':
      await env.DB.prepare('DELETE FROM agent_sessions WHERE id = ?').bind(id).run();
      return;
  }
  s.updated_at = ts;

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO agent_sessions (id, tool, host, project, branch, title, state, step, message, tool_calls, turn_started_at, last_turn_sec, started_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host, project=excluded.project, branch=excluded.branch, title=excluded.title,
      state=excluded.state, step=excluded.step, message=excluded.message, tool_calls=excluded.tool_calls, turn_started_at=excluded.turn_started_at,
      last_turn_sec=excluded.last_turn_sec, updated_at=excluded.updated_at`)
      .bind(s.id, s.tool, s.host, s.project, s.branch, s.title, s.state, s.step, s.message, s.tool_calls, s.turn_started_at, s.last_turn_sec, s.started_at, s.updated_at),
    env.DB.prepare('INSERT INTO agent_events (session_id, kind, summary, ts) VALUES (?,?,?,?)').bind(id, kind, step || e.message || null, ts),
  ]);
}

export async function listAgents(env: Env): Promise<AgentSession[]> {
  const rows = (await env.DB.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT 30').all<any>()).results;
  const now = Date.now();
  return rows
    .map((r): AgentSession => {
      let state = r.state as AgentState;
      const age = now - Date.parse(r.updated_at);
      if ((state === 'running' || state === 'waiting') && age > 30 * 60_000) state = 'stale';
      return {
        id: r.id, tool: r.tool, host: r.host, project: r.project, branch: r.branch || undefined, title: r.title || undefined,
        state, step: r.step || undefined, message: r.message || undefined, toolCalls: r.tool_calls,
        turnStartedAt: r.turn_started_at || undefined, startedAt: r.started_at, updatedAt: r.updated_at, lastTurnSec: r.last_turn_sec ?? undefined,
      };
    })
    // done sessions fade after 20 minutes, idle ones after 2 hours
    .filter((a) => {
      const age = now - Date.parse(a.updatedAt);
      if (a.state === 'done') return age < 20 * 60_000;
      if (a.state === 'idle' || a.state === 'stale') return age < 2 * 3600_000;
      return true;
    });
}

export async function agentTimeline(env: Env, sessionId: string, limit = 8) {
  return (await env.DB.prepare('SELECT kind, summary, ts FROM agent_events WHERE session_id = ? ORDER BY id DESC LIMIT ?').bind(sessionId, limit).all<any>()).results;
}

export async function pruneAgentEvents(env: Env) {
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_events WHERE ts < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM agent_sessions WHERE updated_at < ?').bind(cutoff),
  ]);
}
