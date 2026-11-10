// Widget catalog: what the Mac editor offers, default sizes and editable props.
import type { WidgetType } from './types';

export type FieldType = 'text' | 'textarea' | 'number' | 'bool' | 'select' | 'list' | 'json' | 'symbols';
export interface Field { key: string; label: string; type: FieldType; options?: { value: string; label: string }[]; hint?: string; placeholder?: string }

export interface CatalogEntry {
  type: WidgetType; name: string; desc: string;
  w: number; h: number; minW: number; minH: number;
  props: Record<string, any>;
  fields: Field[];
}

export const METRICS = [
  { value: 'quota:claude', label: 'Claude 额度' }, { value: 'quota:codex', label: 'Codex 额度' }, { value: 'quota:cursor', label: 'Cursor 额度' },
  { value: 'quota:gemini', label: 'Gemini 额度' }, { value: 'quota:copilot', label: 'Copilot 额度' },
  { value: 'quota:grok', label: 'Grok 额度' }, { value: 'quota:deepseek', label: 'DeepSeek 余额（CodexBar）' }, { value: 'tokens:deepseek', label: 'DeepSeek 今日 Token' },
  { value: 'tokens:all', label: '今日 Token（合计）' }, { value: 'tokens:claude', label: 'Claude Code 今日 Token' }, { value: 'tokens:codex', label: 'Codex 今日 Token' },
  { value: 'needs', label: '需要你（行动中心）' }, { value: 'mail', label: '待处理邮件' }, { value: 'agents', label: 'Agent 状态' }, { value: 'tasks', label: '待办数量' }, { value: 'deadline', label: '最近的截止日' },
  { value: 'balance:openrouter', label: 'OpenRouter 余额' }, { value: 'balance:deepseek', label: 'DeepSeek 余额' }, { value: 'balance:moonshot', label: 'Kimi 余额' },
  { value: 'balance:siliconflow', label: '硅基流动余额' }, { value: 'balance:anthropic', label: 'Anthropic API 本月' }, { value: 'balance:openai', label: 'OpenAI API 本月' },
];

export const CATALOG: CatalogEntry[] = [
  {
    type: 'inbox', name: '需要你', desc: '所有要你本人回答、批准、处理的事：AI 提问、Agent 等批准、后台卡片、邮件、截止、AI 成果', w: 6, h: 6, minW: 4, minH: 3,
    props: {}, fields: [],
  },
  {
    type: 'doing', name: '进行中', desc: '你和所有 AI 正在做的事：Claude Code、Codex、后台代办、当前计划块', w: 10, h: 6, minW: 4, minH: 3,
    props: {}, fields: [],
  },
  {
    type: 'plan', name: '今日安排', desc: '手机快速捕获 → AI 排好的时间块 + 日程 + 需要你确认的问题', w: 5, h: 6, minW: 4, minH: 3,
    props: { showQuestions: true, showNotes: true },
    fields: [
      { key: 'showQuestions', label: '显示 AI 的提问', type: 'bool' },
      { key: 'showNotes', label: '显示备注', type: 'bool' },
    ],
  },
  {
    type: 'mail', name: '重要邮件', desc: '学校或公司邮箱的邮件，AI 筛出需要你处理的', w: 6, h: 4, minW: 3, minH: 2,
    props: { max: 5 },
    fields: [{ key: 'max', label: '最多条数', type: 'number' }],
  },
  {
    type: 'ai', name: 'AI 卡片', desc: 'DeepSeek：今日简报 / 论文雷达', w: 6, h: 6, minW: 4, minH: 3,
    props: { mode: 'brief', keywords: [] },
    fields: [
      { key: 'mode', label: '内容', type: 'select', options: [{ value: 'brief', label: '今日简报（早/午/傍晚自动生成）' }, { value: 'papers', label: '论文雷达（每天早上扫描 arXiv）' }] },
      { key: 'keywords', label: '论文关键词', type: 'list', hint: '仅论文雷达；留空时用 AI 从你的笔记和会话里归纳的研究问题' },
      { key: 'feeds', label: 'arXiv 分类', type: 'text', hint: '仅论文雷达；用 + 连接，默认 cs.AI+cs.LG' },
    ],
  },
  {
    type: 'header', name: '顶栏', desc: '大号时间 + 日期 + 天气 + 设备状态', w: 16, h: 2, minW: 6, minH: 2,
    props: { title: '', showWeather: true, showStatus: true },
    fields: [
      { key: 'title', label: '标题', type: 'text', placeholder: '留空显示问候语' },
      { key: 'showWeather', label: '显示天气', type: 'bool' },
      { key: 'showStatus', label: '显示电量/网络', type: 'bool' },
    ],
  },
  {
    type: 'stat', name: '数字卡片', desc: '一个关键数字：额度剩余、今日 Token、Agent、余额…', w: 4, h: 3, minW: 3, minH: 2,
    props: { metric: 'quota:claude', show: 'remaining' },
    fields: [
      { key: 'metric', label: '指标', type: 'select', options: METRICS },
      { key: 'show', label: '额度显示', type: 'select', options: [{ value: 'remaining', label: '剩余' }, { value: 'used', label: '已用' }] },
    ],
  },
  {
    type: 'focus', name: '专注模式', desc: '超大时间 + 最重要的几件事，点时间开始番茄钟', w: 16, h: 12, minW: 6, minH: 5,
    props: { showEvent: true, showTask: true, showAgents: true, showWeather: true, pomodoroMin: 25 },
    fields: [
      { key: 'showEvent', label: '显示当前/下一个日程', type: 'bool' },
      { key: 'showTask', label: '显示最重要的任务', type: 'bool' },
      { key: 'showAgents', label: '显示 Agent 状态', type: 'bool' },
      { key: 'showWeather', label: '显示天气', type: 'bool' },
      { key: 'pomodoroMin', label: '番茄钟分钟数', type: 'number' },
    ],
  },
  {
    type: 'clock', name: '时间日期', desc: '大号时间、日期、星期', w: 7, h: 4, minW: 3, minH: 2,
    props: { style: 'big', showSeconds: false, showWeek: true, greeting: true },
    fields: [
      { key: 'style', label: '样式', type: 'select', options: [{ value: 'big', label: '大号' }, { value: 'compact', label: '紧凑' }] },
      { key: 'showWeek', label: '显示第几周', type: 'bool' },
      { key: 'greeting', label: '显示问候语', type: 'bool' },
    ],
  },
  {
    type: 'weather', name: '天气', desc: 'Open-Meteo，含逐小时和多日预报', w: 5, h: 4, minW: 3, minH: 2,
    props: { useLocation: true, name: '上海', lat: 31.2304, lon: 121.4737, hours: 0, days: 0 },
    fields: [
      { key: 'useLocation', label: '用看板定位', type: 'bool', hint: '开启时使用“设备”里定位到的精确位置；关闭则用下面的经纬度' },
      { key: 'name', label: '地点名称', type: 'text' },
      { key: 'lat', label: '纬度', type: 'number' },
      { key: 'lon', label: '经度', type: 'number' },
      { key: 'hours', label: '逐小时个数', type: 'number', hint: '0 = 不显示' },
      { key: 'days', label: '多日预报天数', type: 'number', hint: '0 = 不显示' },
    ],
  },
  {
    type: 'agents', name: 'Agent 进度', desc: 'Claude Code / Codex 实时状态', w: 12, h: 4, minW: 4, minH: 2,
    props: { max: 4, showDone: true, showHost: true },
    fields: [
      { key: 'max', label: '最多显示', type: 'number' },
      { key: 'showDone', label: '显示刚完成的', type: 'bool' },
      { key: 'showHost', label: '显示主机名', type: 'bool' },
    ],
  },
  {
    type: 'money', name: '记账', desc: '两个人一本账：本月花销、谁该给谁、下一笔固定支出（在 /m 页面说一句就记上）', w: 6, h: 5, minW: 4, minH: 3,
    props: { upcoming: 2 },
    fields: [{ key: 'upcoming', label: '显示几笔即将到期的固定支出', type: 'number' }],
  },
  {
    type: 'quotas', name: 'AI 额度', desc: '订阅额度（Mac 采集）+ API 余额', w: 12, h: 4, minW: 4, minH: 2,
    props: { providers: [], showBalances: true, compact: false },
    fields: [
      { key: 'providers', label: '只显示这些（留空 = 全部）', type: 'list', hint: '按顺序显示：claude / codex / grok / deepseek / cursor …' },
      { key: 'showBalances', label: '显示 API 余额/花费', type: 'bool' },
      { key: 'compact', label: '紧凑模式', type: 'bool' },
    ],
  },
  {
    type: 'calendar', name: '日程', desc: 'Google 日历（OAuth 或私密 iCal 地址）', w: 6, h: 5, minW: 3, minH: 2,
    props: { days: 1, max: 6, source: 'auto' },
    fields: [
      { key: 'days', label: '显示几天', type: 'number' },
      { key: 'max', label: '最多条数', type: 'number' },
      { key: 'source', label: '来源', type: 'select', options: [{ value: 'auto', label: '自动' }, { value: 'google', label: 'Google 账号' }, { value: 'ics', label: 'iCal 地址' }] },
    ],
  },
  {
    type: 'tasks', name: '任务', desc: '自带任务 + Google Tasks，可在屏上勾选', w: 6, h: 5, minW: 3, minH: 2,
    props: { source: 'all', max: 8, showDone: true },
    fields: [
      { key: 'source', label: '来源', type: 'select', options: [{ value: 'all', label: '全部' }, { value: 'local', label: '看板自带' }, { value: 'google', label: 'Google Tasks' }] },
      { key: 'max', label: '最多条数', type: 'number' },
      { key: 'showDone', label: '显示今天完成的', type: 'bool' },
    ],
  },
  {
    type: 'memo', name: '备忘', desc: '置顶备忘，在 Mac 上编辑', w: 12, h: 2, minW: 3, minH: 1,
    props: { mode: 'pinned', max: 3 },
    fields: [
      { key: 'mode', label: '显示', type: 'select', options: [{ value: 'pinned', label: '置顶的' }, { value: 'latest', label: '最新的' }] },
      { key: 'max', label: '最多条数', type: 'number' },
    ],
  },
  {
    type: 'markets', name: '汇率行情', desc: 'Yahoo 代码：USDCNY=X、^GSPC、NVDA、BTC-USD、0700.HK…', w: 7, h: 3, minW: 3, minH: 1,
    props: { items: [{ symbol: 'USDCNY=X', label: 'USD/CNY' }, { symbol: '^GSPC', label: '标普 500' }, { symbol: 'BTC-USD', label: 'BTC' }, { symbol: 'NVDA', label: 'NVDA' }], sparkline: true },
    fields: [
      { key: 'items', label: '显示哪些', type: 'symbols', hint: '搜名字或代码；横版 2×2 放得下 4 个，加高卡片能放更多' },
      { key: 'sparkline', label: '显示 30 天走势', type: 'bool' },
    ],
  },
  {
    type: 'deadlines', name: '截止日', desc: '会议 DDL（ccf-deadlines）+ 自定义', w: 5, h: 3, minW: 3, minH: 1,
    props: { conferences: ['NeurIPS', 'ICML', 'ICLR', 'CVPR', 'ACL'], custom: [], max: 4 },
    fields: [
      { key: 'conferences', label: '关注的会议（简称）', type: 'list' },
      { key: 'custom', label: '自定义', type: 'json', hint: '[{"name":"论文返修","date":"2026-12-01"}]' },
      { key: 'max', label: '最多条数', type: 'number' },
    ],
  },
  {
    type: 'github', name: 'GitHub', desc: '待你 review 的 PR、你的 PR 的 CI', w: 6, h: 3, minW: 3, minH: 1,
    props: { max: 4 },
    fields: [{ key: 'max', label: '最多条数', type: 'number' }],
  },
  {
    type: 'text', name: '文字', desc: '任意一段固定文字/座右铭', w: 12, h: 1, minW: 1, minH: 1,
    props: { text: '把注意力花在真正重要的问题上。', size: 22, align: 'center', bold: false },
    fields: [
      { key: 'text', label: '内容', type: 'textarea' },
      { key: 'size', label: '字号', type: 'number' },
      { key: 'align', label: '对齐', type: 'select', options: [{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }] },
      { key: 'bold', label: '加粗', type: 'bool' },
    ],
  },
  {
    type: 'nav', name: '底部导航', desc: '翻页、打开阅读 App、刷新、菜单', w: 12, h: 1, minW: 4, minH: 1,
    props: { showPages: true, buttons: [{ label: '刷新', action: 'fullRefresh' }, { label: '菜单', action: 'menu' }] },
    fields: [
      { key: 'showPages', label: '显示页面切换', type: 'bool' },
      { key: 'buttons', label: '按钮', type: 'json', hint: '[{"label":"阅读","action":"launch:com.example.reader"}]，action：launch:包名 / fullRefresh / menu / reload / wifi' },
    ],
  },
  {
    type: 'status', name: '设备状态', desc: '电量、Wi-Fi、同步时间', w: 4, h: 1, minW: 2, minH: 1,
    props: {},
    fields: [],
  },
];

export const catalogOf = (t: WidgetType) => CATALOG.find((c) => c.type === t)!;
