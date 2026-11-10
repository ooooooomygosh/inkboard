export const pad = (n: number) => String(n).padStart(2, '0');
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const weekday = (d: Date) => '星期' + WEEK[d.getDay()];
export const weekShort = (d: Date) => '周' + WEEK[d.getDay()];
export const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
export const mdSlash = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dayLabel(d: Date, now = new Date()) {
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0) / 86400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  return `${mdSlash(d)} ${weekShort(d)}`;
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function dur(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function durWords(sec: number) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

export function until(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  const d = Math.floor(ms / 86400_000);
  if (ms < 0) return { n: '已过', unit: '' };
  if (d >= 1) return { n: String(d), unit: '天' };
  const h = Math.floor(ms / 3600_000);
  if (h >= 1) return { n: String(h), unit: '小时' };
  return { n: String(Math.max(1, Math.floor(ms / 60_000))), unit: '分钟' };
}

export function resetLabel(iso: string | null | undefined, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return '已重置';
  if (ms < 24 * 3600_000 && sameDay(d, now)) return `${hm(d)} 重置`;
  if (ms < 48 * 3600_000) return `${dayLabel(d, now)} ${hm(d)}`;
  return `${weekShort(d)} ${hm(d)}`;
}

export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400_000 + 1) / 7);
}

const LDAY = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
export function lunar(d: Date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(d);
    const month = parts.find((p) => p.type === 'month')?.value || '';
    const day = parseInt(parts.find((p) => p.type === 'day')?.value || '', 10);
    return day ? `${month}${LDAY[day - 1] || ''}` : '';
  } catch { return ''; }
}

export function greeting(d: Date) {
  const h = d.getHours();
  if (h < 5) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

export function fmtNum(v: number | null | undefined, digits?: number) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  const dgt = digits ?? (a >= 10000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4);
  if (a >= 100000) return (v / 1000).toFixed(1) + 'k';
  return v.toLocaleString('en-US', { minimumFractionDigits: dgt, maximumFractionDigits: dgt });
}

/** 173461230 -> "1.73 亿", 3855137 -> "386 万" */
export function cnBig(n: number | null | undefined) {
  if (n == null || isNaN(n)) return { v: '—', u: '' };
  if (n >= 1e8) return { v: (n / 1e8).toFixed(n >= 1e9 ? 1 : 2), u: '亿' };
  if (n >= 1e4) return { v: (n / 1e4).toFixed(n >= 1e6 ? 0 : 1), u: '万' };
  return { v: String(Math.round(n)), u: '' };
}
export const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
