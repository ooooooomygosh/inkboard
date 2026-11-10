// 记账：在快速捕获里说一句“午饭 18”“Claude 每月 20 美元”“房租每月 3000，下次 15 号”，
// AI 拆成一次性花费和固定支出。固定支出按周期自动计入，不用每次再报；报了也不会重复算。
// 两个人共用一本账（me / partner，名字在编辑器“关于你”里改），金额统一换算成基础货币汇总。
// 表里的 aud 列存的是换算成基础货币后的金额（列名沿用早期版本）。
import type { Layout } from '../shared/types';
import { deepseek, localNow } from './ai';
import { Env, fetchJson, kvGet, kvSet, nowIso, uid } from './util';

export type Period = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly';
const PERIODS: Period[] = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
export const PERIOD_ZH: Record<Period, string> = { weekly: '每周', fortnightly: '每两周', monthly: '每月', quarterly: '每季度', yearly: '每年' };
const PER_MONTH: Record<Period, number> = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
export type Who = 'me' | 'partner';
const other = (w: Who): Who => (w === 'me' ? 'partner' : 'me');
export const peopleOf = (l: Layout): Record<Who, string> => ({ me: l.profile?.me || '我', partner: l.profile?.partner || 'TA' });
export const baseOf = (l: Layout) => (l.profile?.currency || 'CNY').toUpperCase();

export const CATEGORIES = ['餐饮', '买菜', '交通', '房租', '水电网', '订阅', '购物', '娱乐', '医疗', '学习', '人情', '其他'];

/** Quick test: is there anything about money in this text? Avoids an AI call for ordinary captures. */
export function mentionsMoney(t: string) {
  return /\d/.test(t) && /[$¥￥元块刀]|澳元|美元|人民币|澳币|\b(AUD|USD|CNY|RMB)\b|花了|买了|付了|交了|充了|扣了|订阅|房租|租金|水电|电费|水费|网费|话费|账单|月费|年费|会员|退订|取消订阅|一共|总共|报销/i.test(t);
}

// ---------------------------------------------------------------- currency
/** Rates against the base currency (1 base = rates[X] X), refreshed daily from Frankfurter (ECB). */
export async function fxRates(env: Env, base: string): Promise<Record<string, number>> {
  const c = await kvGet<{ day: string; base?: string; rates: Record<string, number> }>(env, 'fx:base');
  const day = new Date().toISOString().slice(0, 10);
  if (c && c.value.day === day && c.value.base === base) return c.value.rates;
  try {
    const r = await fetchJson<any>(`https://api.frankfurter.dev/v1/latest?base=${base}`);
    const rates = { [base]: 1, ...r.rates };
    await kvSet(env, 'fx:base', { day, base, rates });
    return rates;
  } catch {
    return c?.value.base === base ? c.value.rates : { [base]: 1 };
  }
}
const toBase = (amount: number, cur: string, rates: Record<string, number>) => Math.round((amount / (rates[cur] || 1)) * 100) / 100;

// ---------------------------------------------------------------- dates
const D = (s: string) => new Date(s + 'T00:00:00Z');
const ymd = (d: Date) => d.toISOString().slice(0, 10);
function addMonths(base: Date, n: number) {
  const day = base.getUTCDate();
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Charge dates of a fixed item between from..to (inclusive, YYYY-MM-DD), never before it was tracked. */
export function occurrences(r: { period: Period; anchor: string; start: string }, from: string, to: string): string[] {
  const out: string[] = [];
  const lo = from > r.start ? from : r.start;
  const a = D(r.anchor);
  const days = r.period === 'weekly' ? 7 : r.period === 'fortnightly' ? 14 : 0;
  if (days) {
    const step = days * 86400_000;
    let t = a.getTime() + Math.ceil((D(lo).getTime() - a.getTime()) / step) * step;
    for (; t <= D(to).getTime(); t += step) out.push(ymd(new Date(t)));
  } else {
    const months = r.period === 'monthly' ? 1 : r.period === 'quarterly' ? 3 : 12;
    const span = (D(lo).getUTCFullYear() - a.getUTCFullYear()) * 12 + D(lo).getUTCMonth() - a.getUTCMonth();
    let k = Math.floor(span / months) - 1;
    for (let i = 0; i < 40; i++, k++) {
      const d = ymd(addMonths(a, k * months));
      if (d > to) break;
      if (d >= lo) out.push(d);
    }
  }
  return out;
}
/** Next charge after today (today's charge is already counted in "spent"). */
export const nextDue = (r: { period: Period; anchor: string; start: string }, today: string) => {
  const tomorrow = ymd(new Date(D(today).getTime() + 86400_000));
  return occurrences({ ...r, start: tomorrow }, tomorrow, ymd(new Date(D(today).getTime() + 400 * 86400_000)))[0] || null;
};

// ---------------------------------------------------------------- AI parse
interface Parsed {
  expenses?: { amount: number; currency?: string; category?: string; note?: string; date?: string | null; shared?: boolean; who?: string }[];
  recurring?: { op: 'add' | 'update' | 'stop'; id?: string; name?: string; amount?: number; currency?: string; period?: string; next_due?: string | null; last_paid?: string | null; category?: string; shared?: boolean; who?: string }[];
  paid?: { id: string; date?: string | null; amount?: number }[];
  rest?: string;
}

/** Pull the money parts out of a capture. Returns the leftover text for the day planner. */
export async function recordMoney(env: Env, layout: Layout, text: string, speaker: Who = 'me', captureId?: string) {
  const now = localNow(layout.device.timezone);
  const recs = (await env.DB.prepare('SELECT id, name, amount, currency, period, anchor, who, shared FROM recurring WHERE active = 1').all<any>()).results;
  const P = peopleOf(layout), base = baseOf(layout);
  const me = P[speaker], you = P[other(speaker)];
  const where = layout.profile?.city ? `他们在${layout.profile.city}。` : '';
  const r: Parsed = await deepseek(env, `你是 ${P.me} 和 ${P.partner} 两个人的共同记账助手。${where}现在说话的是 ${me}（“我”指 ${me}，“男朋友/女朋友/室友/你/TA”通常指 ${you}）。把这段话整理成 JSON：
{"expenses":[{"amount":18,"currency":"${base}","category":"餐饮","note":"午饭","date":null,"shared":false,"who":"${speaker}"}],
 "recurring":[{"op":"add","name":"房租","amount":3000,"currency":"${base}","period":"monthly","next_due":"2026-12-15","last_paid":null,"category":"房租","shared":true,"who":"me"}],
 "paid":[{"id":"已有固定项的 id","date":null}],
 "rest":"文字里和花钱无关的部分，原样保留；全是记账就写空字符串"}
规则：
- 币种默认 ${base}；“人民币/RMB”是 CNY；“美元/USD/美金”是 USD；“元/块/刀”这类口语按用户所在地的本币理解，拿不准就用 ${base}。
- 一次性的花费放 expenses。date 只在用户说了“昨天/周一/11 号”这类时填 YYYY-MM-DD，否则 null（表示今天）。
- “每周/每两周/每月/每季度/每年/订阅/月费/年费”这类会重复的放 recurring，period 只能是 weekly、fortnightly、monthly、quarterly、yearly。用户说了下次哪天交写 next_due，说了上次哪天交写 last_paid，都没说就都写 null。
- 下面的“已有固定支出”里有的项目：用户说金额变了、周期变了就 op=update 并带上 id；说退订、不交了、搬走了就 op=stop；只是说这期交了/扣了，放 paid，不要再记进 expenses，也不要新建。
- who 是谁付的钱，只能是 me（${P.me}）或 partner（${P.partner}）；没说就是说话的人（${speaker}）。“${P.partner} 付的”→ partner，“${P.me} 付的”→ me；“他/她付的”指说话人之外的那个人。
- shared：两个人共同的开销为 true（“我们/一起/AA/共同/两个人的”，房租、水电、网费、一起买菜默认 true）；只为自己花的为 false。
- category 只能从这些里选：${CATEGORIES.join('、')}。
- 没说金额的不要编；不确定是不是花钱的话留在 rest 里。`,
    `今天：${now.text}\n已有固定支出：${recs.length ? recs.map((x) => `${x.id} ${x.name} ${x.amount}${x.currency} ${x.period} 锚定日${x.anchor} ${x.who}付${x.shared ? ' 共同' : ''}`).join('；') : '无'}\n\n用户说：${text}`,
    { maxTokens: 700, effort: 'low' });

  const rates = await fxRates(env, base);
  const st: D1PreparedStatement[] = [];
  const ts = nowIso();
  const valid = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  for (const e of r.expenses || []) {
    const amount = Number(e.amount);
    if (!(amount > 0)) continue;
    const cur = String(e.currency || base).toUpperCase();
    st.push(env.DB.prepare('INSERT INTO expenses (id, day, ts, amount, currency, aud, category, note, shared, capture_id, who) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind('e_' + uid(8), valid(e.date) || now.day, ts, amount, cur, toBase(amount, cur, rates), CATEGORIES.includes(e.category || '') ? e.category : '其他', String(e.note || '').slice(0, 60), e.shared ? 1 : 0, captureId || null, whoOf(e.who, speaker)));
  }
  for (const x of r.recurring || []) {
    const period = PERIODS.includes(x.period as Period) ? (x.period as Period) : null;
    if (x.op === 'stop' && x.id) { st.push(env.DB.prepare('UPDATE recurring SET active = 0, updated_at = ? WHERE id = ?').bind(ts, x.id)); continue; }
    if (x.op === 'update' && x.id) {
      const cur = recs.find((y) => y.id === x.id);
      if (!cur) continue;
      const anchor = valid(x.next_due) || valid(x.last_paid) || cur.anchor;
      st.push(env.DB.prepare('UPDATE recurring SET name = ?, amount = ?, currency = ?, period = ?, anchor = ?, who = ?, shared = ?, updated_at = ? WHERE id = ?')
        .bind(x.name || cur.name, Number(x.amount) > 0 ? Number(x.amount) : cur.amount, String(x.currency || cur.currency).toUpperCase(), period || cur.period, anchor,
          x.who ? whoOf(x.who, cur.who) : cur.who, x.shared === undefined ? cur.shared : x.shared ? 1 : 0, ts, x.id));
      continue;
    }
    if (x.op === 'add' && x.name && Number(x.amount) > 0 && period) {
      const anchor = valid(x.next_due) || valid(x.last_paid) || now.day;
      // counted from today, or from the last payment the user mentioned
      const start = anchor < now.day ? anchor : now.day;
      st.push(env.DB.prepare('INSERT INTO recurring (id, name, amount, currency, period, anchor, start, category, shared, active, updated_at, who) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)')
        .bind('r_' + uid(6), String(x.name).slice(0, 30), Number(x.amount), String(x.currency || base).toUpperCase(), period, anchor, start, CATEGORIES.includes(x.category || '') ? x.category : '订阅', x.shared ? 1 : 0, ts, whoOf(x.who, speaker)));
    }
  }
  for (const p of r.paid || []) {
    const cur = recs.find((y) => y.id === p.id);
    if (cur && valid(p.date)) st.push(env.DB.prepare('UPDATE recurring SET anchor = ?, updated_at = ? WHERE id = ?').bind(valid(p.date), ts, p.id));
  }
  if (st.length) await env.DB.batch(st);
  return { rest: typeof r.rest === 'string' ? r.rest.trim() : text, changed: st.length };
}

const whoOf = (w: any, fallback: Who): Who => (w === 'me' || w === 'partner' ? w : fallback);

// ---------------------------------------------------------------- summary
export async function moneySummary(env: Env, layout: Layout) {
  const tz = layout.device.timezone, base = baseOf(layout);
  const today = localNow(tz).day;
  const monthStart = today.slice(0, 8) + '01';
  const monthEnd = ymd(new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)));
  const [all, recs, recent, rates] = await Promise.all([
    env.DB.prepare('SELECT day, aud, category, shared, who, kind FROM expenses').all<any>().then((r) => r.results),
    env.DB.prepare('SELECT * FROM recurring ORDER BY active DESC, amount DESC').all<any>().then((r) => r.results),
    env.DB.prepare("SELECT id, day, amount, currency, aud, category, note, shared, who, kind FROM expenses ORDER BY day DESC, ts DESC LIMIT 30").all<any>().then((r) => r.results),
    fxRates(env, base),
  ]);
  const round = (n: number) => Math.round(n * 100) / 100;
  // one list of "charges": one-off expenses + every occurrence of fixed items so far
  type Charge = { day: string; aud: number; category: string; shared: boolean; who: Who };
  const charges: Charge[] = all.filter((x) => x.kind !== 'settle').map((x) => ({ day: x.day, aud: x.aud, category: x.category || '其他', shared: !!x.shared, who: whoOf(x.who, 'me') }));
  let fixedMonthly = 0, fixedLeft = 0;
  const fixed = recs.map((r) => {
    const aud = toBase(r.amount, r.currency, rates);
    if (r.active) {
      // a stopped item still counts for the charges it already made
      for (const d of occurrences(r, r.start, today)) charges.push({ day: d, aud, category: r.category || '订阅', shared: !!r.shared, who: whoOf(r.who, 'me') });
      fixedMonthly += aud * PER_MONTH[r.period as Period];
      fixedLeft += occurrences(r, ymd(new Date(D(today).getTime() + 86400_000)), monthEnd).length * aud;
    }
    return { id: r.id, name: r.name, amount: r.amount, currency: r.currency, aud, period: r.period, periodZh: PERIOD_ZH[r.period as Period], monthly: round(aud * PER_MONTH[r.period as Period]),
      next: r.active ? nextDue(r, today) : null, category: r.category, shared: !!r.shared, who: whoOf(r.who, 'me'), active: !!r.active };
  });
  const month = charges.filter((x) => x.day >= monthStart && x.day <= today);
  const sum = (xs: Charge[]) => round(xs.reduce((s, x) => s + x.aud, 0));
  // personal cost: own non-shared + half of every shared charge, whoever paid
  const costOf = (w: Who) => round(month.filter((x) => !x.shared && x.who === w).reduce((s, x) => s + x.aud, 0) + month.filter((x) => x.shared).reduce((s, x) => s + x.aud / 2, 0));
  // balance (all time): for shared charges the payer covered the other's half; settlements move money back
  let owedToMe = 0; // >0: partner owes me
  for (const x of charges) if (x.shared) owedToMe += x.who === 'me' ? x.aud / 2 : -x.aud / 2;
  for (const x of all) if (x.kind === 'settle') owedToMe += x.who === 'partner' ? -x.aud : x.aud; // who = the person who paid the other back
  const byCat: Record<string, number> = {};
  for (const x of month) byCat[x.category] = (byCat[x.category] || 0) + x.aud;
  const fixedFixed = fixed.filter((f) => f.active);
  return {
    people: peopleOf(layout), currency: base, month: today.slice(0, 7), today,
    total: sum(month), shared: sum(month.filter((x) => x.shared)),
    me: costOf('me'), partner: costOf('partner'),
    todaySpent: sum(month.filter((x) => x.day === today)),
    fixedMonthly: round(fixedMonthly), forecast: round(sum(month) + fixedLeft), // so far + fixed charges still to come this month
    balance: round(owedToMe),
    byCategory: Object.entries(byCat).map(([k, v]) => ({ k, v: round(v) })).sort((a, b) => b.v - a.v),
    fixed: fixedFixed, upcoming: fixedFixed.filter((f) => f.next).sort((a, b) => a.next!.localeCompare(b.next!)).slice(0, 3), recent,
  };
}

/** One of them paid the other back: clears the balance by that amount. */
export async function settle(env: Env, layout: Layout, payer: Who, amount: number) {
  if (!(amount > 0)) return;
  const P = peopleOf(layout);
  await env.DB.prepare("INSERT INTO expenses (id, day, ts, amount, currency, aud, category, note, shared, who, kind) VALUES (?,?,?,?,?,?, '结算', ?, 0, ?, 'settle')")
    .bind('s_' + uid(8), localNow(layout.device.timezone).day, nowIso(), amount, baseOf(layout), amount, `${P[payer]} 转给 ${P[other(payer)]}`, payer).run();
}
