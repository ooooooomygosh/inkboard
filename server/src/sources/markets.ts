import { fetchJson } from '../util';

interface Item { symbol: string; label?: string }
/** Extended-hours trade for US stocks: pre-market (vs the previous close) or after-hours (vs today's close). */
export interface ExtQuote { session: 'pre' | 'post'; price: number; changePct: number; at: number }
export interface Quote { symbol: string; label: string; price: number | null; change: number | null; changePct: number | null; currency?: string; spark: number[]; marketState?: string; ext?: ExtQuote; error?: string }

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

async function yahoo(symbol: string): Promise<Omit<Quote, 'label'>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const r = await fetchJson<any>(url, { headers: UA });
  const res = r?.chart?.result?.[0];
  if (!res) throw new Error(r?.chart?.error?.description || 'no data');
  const m = res.meta;
  const closes: number[] = (res.indicators?.quote?.[0]?.close || []).filter((x: any) => typeof x === 'number');
  const price = m.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  // previous trading day's close
  const prev = closes.length >= 2 ? closes[closes.length - 2] : m.chartPreviousClose;
  const change = price != null && prev ? price - prev : null;
  const ext = m.exchangeTimezoneName === 'America/New_York' && /EQUITY|ETF/.test(m.instrumentType || '') ? price != null ? await extended(symbol, price).catch(() => undefined) : undefined : undefined;
  return { symbol, price, change, changePct: change != null && prev ? (change / prev) * 100 : null, currency: m.currency, spark: closes.slice(-30), marketState: m.marketState, ext };
}

/** Latest pre-market or after-hours trade from Yahoo's 5-minute bars (includePrePost). In Asia-Pacific the US
 *  session is overnight, so outside trading hours this shows the last after-hours price. */
async function extended(symbol: string, lastClose: number): Promise<ExtQuote | undefined> {
  const r = await fetchJson<any>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true`, { headers: UA });
  const res = r?.chart?.result?.[0];
  const reg = res?.meta?.currentTradingPeriod?.regular;
  if (!res?.timestamp || !reg) return undefined;
  const closes: (number | null)[] = res.indicators?.quote?.[0]?.close || [];
  let i = res.timestamp.length - 1;
  while (i >= 0 && typeof closes[i] !== 'number') i--;
  if (i < 0) return undefined;
  const t: number = res.timestamp[i], price = closes[i] as number;
  const session = t < reg.start ? 'pre' : t >= reg.end ? 'post' : null;
  if (!session) return undefined; // regular session is trading: the main price is already live
  // both against the latest regular-session close (pre: yesterday's, post: today's); the intraday
  // chart's own chartPreviousClose is the close BEFORE that one, which made the sign wrong
  return { session, price, changePct: ((price - lastClose) / lastClose) * 100, at: t * 1000 };
}

// Fallback for FX pairs like AUDCNY=X: Frankfurter (ECB reference rates).
async function frankfurter(symbol: string): Promise<Omit<Quote, 'label'>> {
  const mm = symbol.match(/^([A-Z]{3})([A-Z]{3})=X$/);
  if (!mm) throw new Error('not fx');
  const [, b, q] = mm;
  const start = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
  const r = await fetchJson<any>(`https://api.frankfurter.dev/v1/${start}..?base=${b}&symbols=${q}`);
  const series = Object.keys(r.rates).sort().map((d) => r.rates[d][q] as number);
  const price = series[series.length - 1], prev = series[series.length - 2];
  return { symbol, price, change: price - prev, changePct: ((price - prev) / prev) * 100, currency: q, spark: series.slice(-30) };
}

export const marketsSource = {
  key: (p: any) => `markets:${(p.items || []).map((i: Item) => i.symbol).join(',')}`,
  ttlSec: 15 * 60,
  async fetch(p: any): Promise<Quote[]> {
    const items: Item[] = p.items || [];
    return Promise.all(items.map(async (it) => {
      const label = it.label || it.symbol;
      try { return { ...(await yahoo(it.symbol)), label }; }
      catch (e: any) {
        try { return { ...(await frankfurter(it.symbol)), label }; }
        catch { return { symbol: it.symbol, label, price: null, change: null, changePct: null, spark: [], error: String(e?.message || e) }; }
      }
    }));
  },
};

const KIND: Record<string, string> = { EQUITY: '股票', ETF: 'ETF', INDEX: '指数', CURRENCY: '汇率', CRYPTOCURRENCY: '加密货币', FUTURE: '期货', MUTUALFUND: '基金' };

/** Symbol search for the editor (Yahoo autocomplete). Plain "AUD CNY" / "aud/cny" also yields the FX pair. */
export async function searchSymbols(q: string) {
  const out: { symbol: string; name: string; kind: string; exchange?: string }[] = [];
  const fx = q.toUpperCase().replace(/[^A-Z]/g, '');
  const CUR = 'AUD CNY USD EUR GBP JPY HKD SGD NZD CAD CHF KRW TWD INR THB MYR'.split(' ');
  if (fx.length === 6 && CUR.includes(fx.slice(0, 3)) && CUR.includes(fx.slice(3))) out.push({ symbol: `${fx}=X`, name: `${fx.slice(0, 3)}/${fx.slice(3)} 汇率`, kind: '汇率' });
  const r = await fetchJson<any>(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { headers: UA });
  for (const x of r?.quotes || []) {
    if (!x.symbol || out.some((o) => o.symbol === x.symbol)) continue;
    out.push({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, kind: KIND[x.quoteType] || x.quoteType || '', exchange: x.exchDisp || x.exchange });
  }
  return out.slice(0, 10);
}
