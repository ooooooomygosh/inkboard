import { parse } from 'yaml';
import { Env, fetchJson, kvGet, kvSet } from '../util';

export interface Deadline { name: string; detail?: string; at: string; tz?: string; kind: 'conf' | 'custom'; link?: string; rank?: string }

const RAW = 'https://raw.githubusercontent.com/ccfddl/ccf-deadlines/main/';

// Map "ICC" -> "conference/NW/icc.yml" using the repo tree (cached for a week).
async function confPaths(env: Env): Promise<Record<string, string>> {
  const cached = await kvGet<Record<string, string>>(env, 'cache:ccfddl:paths');
  if (cached && Date.now() - Date.parse(cached.updatedAt) < 7 * 86400_000) return cached.value;
  const tree = await fetchJson<any>('https://api.github.com/repos/ccfddl/ccf-deadlines/git/trees/main?recursive=1', { headers: { Accept: 'application/vnd.github+json' } }, 20000);
  const map: Record<string, string> = {};
  for (const t of tree.tree || []) {
    const m = /^conference\/[^/]+\/([^/]+)\.yml$/.exec(t.path);
    if (m) map[m[1].toLowerCase()] = t.path;
  }
  await kvSet(env, 'cache:ccfddl:paths', map);
  return map;
}

// "2026-11-02 23:59:59" in "AoE" / "UTC-12" / "UTC+8" -> ISO
function toIso(local: string, tz: string | undefined) {
  let off = -12; // AoE default
  const m = /UTC([+-]\d+)/i.exec(tz || '');
  if (m) off = parseInt(m[1], 10);
  else if (tz && /^UTC$/i.test(tz)) off = 0;
  const t = Date.parse(local.replace(' ', 'T') + 'Z') - off * 3600_000;
  return new Date(t).toISOString();
}

export const deadlinesSource = {
  key: (p: any) => `deadlines:${(p.conferences || []).join(',').toLowerCase()}`,
  ttlSec: 12 * 3600,
  async fetch(p: any, env: Env): Promise<Deadline[]> {
    const want: string[] = (p.conferences || []).map((s: string) => s.toLowerCase().trim()).filter(Boolean);
    if (!want.length) return [];
    const paths = await confPaths(env);
    const out: Deadline[] = [];
    const now = Date.now();
    await Promise.all(want.map(async (w) => {
      const path = paths[w];
      if (!path) return;
      const r = await fetch(RAW + path, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const doc = parse(await r.text());
      for (const conf of doc || []) {
        for (const c of conf.confs || []) {
          for (const tl of c.timeline || []) {
            for (const [kind, label] of [['abstract_deadline', '摘要'], ['deadline', '全文']] as const) {
              const v = tl[kind];
              if (!v || v === 'TBD') continue;
              const at = toIso(String(v), c.timezone);
              if (Date.parse(at) < now - 86400_000) continue;
              out.push({ name: `${conf.title} ${c.year}`, detail: label + (tl.comment ? ` · ${tl.comment}` : ''), at, tz: c.timezone, kind: 'conf', link: c.link, rank: conf.rank?.ccf });
            }
          }
        }
      }
    }));
    return out.sort((a, b) => a.at.localeCompare(b.at));
  },
};
