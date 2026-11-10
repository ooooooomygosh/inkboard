import type { Layout, Orientation, Page, Widget, WidgetType } from './types';
import { catalogOf } from './catalog';

const w = (id: string, type: WidgetType, x: number, y: number, ww: number, h: number, props: Record<string, any> = {}, extra: Partial<Widget> = {}): Widget => ({
  id, type, x, y, w: ww, h, props: { ...catalogOf(type).props, ...props }, ...extra,
});

const DEVICE = {
  pollSec: 30, activePollSec: 10, fullRefreshMin: 30, partialLimit: 0, returnHomeSec: 300,
  brightness: -1, timezone: 'Asia/Shanghai',
  night: { enabled: true, start: '23:30', end: '06:30' },
  light: { mode: 'system' as const, brightness: 40, warmth: 35, schedule: [{ from: '18:30', to: '23:30', brightness: 30, warmth: 70 }] },
  contrast: -1,
  battery: { care: true, upper: 80, lower: 70 },
};

export const PROFILE = { about: '', city: '上海', currency: 'CNY', me: '我', partner: 'TA' };

// Landscape: 998 x 749 CSS px, 16 x 12 grid.
const LANDSCAPE_PAGES: Page[] = [
  {
    id: 'home', name: '概览',
    widgets: [
      w('header', 'header', 0, 0, 16, 2, {}, { hideTitle: true }),
      w('k_claude', 'stat', 0, 2, 4, 3, { metric: 'quota:claude' }),
      w('k_codex', 'stat', 4, 2, 4, 3, { metric: 'quota:codex' }),
      w('k_mail', 'stat', 8, 2, 4, 3, { metric: 'mail' }),
      w('k_needs', 'stat', 12, 2, 4, 3, { metric: 'needs' }),
      w('plan', 'plan', 0, 5, 6, 6),
      w('tasks', 'tasks', 6, 5, 5, 6),
      w('brief', 'ai', 11, 5, 5, 6, { mode: 'brief' }),
      w('nav', 'nav', 0, 11, 16, 1, {}, { hideTitle: true }),
    ],
  },
  {
    id: 'focus', name: '专注',
    widgets: [w('focus', 'focus', 0, 0, 16, 12, {}, { hideTitle: true })],
  },
  {
    id: 'work', name: '工作',
    widgets: [
      w('doing', 'doing', 0, 0, 10, 6),
      w('inbox', 'inbox', 10, 0, 6, 11),
      w('papers', 'ai', 0, 6, 10, 5, { mode: 'papers' }),
      w('nav2', 'nav', 0, 11, 16, 1, {}, { hideTitle: true }),
    ],
  },
  {
    id: 'dev', name: '开发',
    widgets: [
      w('doing5', 'doing', 0, 0, 9, 5),
      w('inbox5', 'inbox', 9, 0, 7, 5),
      w('github5', 'github', 0, 5, 9, 6, { max: 8 }),
      w('quotas5', 'quotas', 9, 5, 7, 6, { showBalances: true }),
      w('nav5', 'nav', 0, 11, 16, 1, {}, { hideTitle: true }),
    ],
  },
  {
    id: 'life', name: '生活',
    widgets: [
      w('weather3', 'weather', 0, 0, 10, 5, { hours: 8, days: 0 }),
      w('calendar3', 'calendar', 10, 0, 6, 6, { days: 7, max: 8 }),
      w('money3', 'money', 10, 6, 6, 5, { upcoming: 2 }),
      w('markets', 'markets', 0, 5, 6, 6, { sparkline: true }),
      w('quotas3', 'quotas', 6, 5, 4, 6, { compact: true }),
      w('nav3', 'nav', 0, 11, 16, 1, {}, { hideTitle: true }),
    ],
  },
];

// Portrait: 749 x 998 CSS px, 12 x 16 grid.
const PORTRAIT_PAGES: Page[] = [
  {
    id: 'home', name: '概览',
    widgets: [
      w('header', 'header', 0, 0, 12, 2, {}, { hideTitle: true }),
      w('k_claude', 'stat', 0, 2, 4, 3, { metric: 'quota:claude' }),
      w('k_codex', 'stat', 4, 2, 4, 3, { metric: 'quota:codex' }),
      w('k_needs', 'stat', 8, 2, 4, 3, { metric: 'needs' }),
      w('plan', 'plan', 0, 5, 6, 5),
      w('tasks', 'tasks', 6, 5, 6, 5),
      w('brief', 'ai', 0, 10, 8, 5, { mode: 'brief' }),
      w('k_mail', 'stat', 8, 10, 4, 5, { metric: 'mail' }),
      w('nav', 'nav', 0, 15, 12, 1, {}, { hideTitle: true }),
    ],
  },
  {
    id: 'focus', name: '专注',
    widgets: [w('focus', 'focus', 0, 0, 12, 16, {}, { hideTitle: true })],
  },
  {
    id: 'work', name: '工作',
    widgets: [
      w('agents2', 'agents', 0, 0, 12, 6, { max: 5 }),
      w('github', 'github', 0, 6, 12, 4, { max: 4 }),
      w('deadlines', 'deadlines', 0, 10, 6, 5, { max: 5 }),
      w('quotas2', 'quotas', 6, 10, 6, 5, { compact: true }),
      w('nav2', 'nav', 0, 15, 12, 1, {}, { hideTitle: true }),
    ],
  },
  {
    id: 'life', name: '生活',
    widgets: [
      w('weather3', 'weather', 0, 0, 12, 5, { hours: 8, days: 4 }),
      w('calendar3', 'calendar', 0, 5, 7, 7, { days: 7, max: 12 }),
      w('money3', 'money', 7, 5, 5, 7, { upcoming: 3 }),
      w('markets', 'markets', 0, 12, 12, 3, { sparkline: true }),
      w('nav3', 'nav', 0, 15, 12, 1, {}, { hideTitle: true }),
    ],
  },
];

export const isLandscape = (o: Orientation) => o === 'landscape' || o === 'reverseLandscape';
export const screenSize = (o: Orientation) => (isLandscape(o) ? { w: 998, h: 749 } : { w: 749, h: 998 });

export function defaultLayout(orientation: Orientation = 'landscape'): Layout {
  const land = isLandscape(orientation);
  return JSON.parse(JSON.stringify({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    orientation,
    grid: land ? { cols: 16, rows: 12, gap: 12, padding: 22 } : { cols: 12, rows: 16, gap: 12, padding: 22 },
    theme: { fontScale: 1, titleStyle: 'rule', clockWeight: 300, cards: true, displayFont: 'smiley' },
    device: DEVICE,
    profile: PROFILE,
    pages: land ? LANDSCAPE_PAGES : PORTRAIT_PAGES,
  } satisfies Layout));
}

export const DEFAULT_LAYOUT: Layout = defaultLayout('landscape');
