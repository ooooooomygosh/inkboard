import type { Balance } from '../../shared/types';
import { fetchJson, nowIso } from '../util';

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
const money = (v: number, cur = '$') => `${cur}${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

type Probe = { id: string; label: string; secret: string; run: (key: string) => Promise<{ value: string; sub?: string }> };

const PROBES: Probe[] = [
  {
    id: 'openrouter', label: 'OpenRouter', secret: 'openrouter_key',
    run: async (k) => {
      const r = await fetchJson<any>('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${k}` } });
      return { value: money(r.data.total_credits - r.data.total_usage), sub: '余额' };
    },
  },
  {
    id: 'deepseek', label: 'DeepSeek', secret: 'deepseek_key',
    run: async (k) => {
      const r = await fetchJson<any>('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${k}` } });
      const infos: any[] = r.balance_infos || [];
      const b = infos.find((x) => +x.total_balance > 0) || infos.find((x) => x.currency === 'CNY') || infos[0];
      return { value: `${b?.currency === 'CNY' ? '¥' : '$'}${(+b?.total_balance || 0).toFixed(2)}`, sub: '余额' };
    },
  },
  {
    id: 'moonshot', label: 'Kimi', secret: 'moonshot_key',
    run: async (k) => {
      const r = await fetchJson<any>('https://api.moonshot.cn/v1/users/me/balance', { headers: { Authorization: `Bearer ${k}` } });
      return { value: `¥${(+r.data?.available_balance || 0).toFixed(2)}`, sub: '余额' };
    },
  },
  {
    id: 'siliconflow', label: '硅基流动', secret: 'siliconflow_key',
    run: async (k) => {
      const r = await fetchJson<any>('https://api.siliconflow.cn/v1/user/info', { headers: { Authorization: `Bearer ${k}` } });
      return { value: `¥${(+r.data?.totalBalance || 0).toFixed(2)}`, sub: '余额' };
    },
  },
  {
    id: 'anthropic', label: 'Anthropic API', secret: 'anthropic_admin_key',
    run: async (k) => {
      const q = new URLSearchParams({ starting_at: monthStart().toISOString(), bucket_width: '1d', limit: '31' });
      const r = await fetchJson<any>(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } });
      let cents = 0;
      for (const b of r.data || []) for (const x of b.results || []) cents += parseFloat(typeof x.amount === 'object' ? x.amount.value : x.amount) || 0;
      return { value: money(cents / 100), sub: '本月花费' };
    },
  },
  {
    id: 'openai', label: 'OpenAI API', secret: 'openai_admin_key',
    run: async (k) => {
      const q = new URLSearchParams({ start_time: String(Math.floor(monthStart().getTime() / 1000)), bucket_width: '1d', limit: '31' });
      const r = await fetchJson<any>(`https://api.openai.com/v1/organization/costs?${q}`, { headers: { Authorization: `Bearer ${k}` } });
      let usd = 0;
      for (const b of r.data || []) for (const x of b.results || []) usd += +x.amount?.value || 0;
      return { value: money(usd), sub: '本月花费' };
    },
  },
];

export const BALANCE_SECRETS = PROBES.map((p) => ({ key: p.secret, label: p.label }));

export async function fetchBalances(secrets: Record<string, string>): Promise<Balance[]> {
  const active = PROBES.filter((p) => secrets[p.secret]);
  return Promise.all(active.map(async (p) => {
    try { return { id: p.id, label: p.label, ...(await p.run(secrets[p.secret])), capturedAt: nowIso() }; }
    catch (e: any) { return { id: p.id, label: p.label, value: '—', error: String(e?.message || e), capturedAt: nowIso() }; }
  }));
}
