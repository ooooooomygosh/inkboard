// Demo data: a fictional user ("阿哲") and partner ("小满") so every screen has something to show.
// Everything is made up and relative to the moment you run it. Prints SQL for a *separate* local database:
//   npm run demo:seed && npm run demo     → http://localhost:8788
import { catalogOf } from '../shared/catalog';
import { defaultLayout } from '../shared/defaults';
import type { Widget } from '../shared/types';

const TZ = process.env.DEMO_TZ || 'America/New_York';
const now = Date.now();
const iso = (minFromNow: number) => new Date(now + minFromNow * 60_000).toISOString();
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
const day = `${parts.year}-${parts.month}-${parts.day}`;
const nowMin = +parts.hour * 60 + +parts.minute;
const offDay = (d: number) => new Date(Date.parse(day + 'T12:00:00Z') + d * 86400_000).toISOString().slice(0, 10);
/** "HH:MM" today in TZ, as minutes from now, so calendar events line up with the board's clock. */
const at = (hm: string, dayOffset = 0) => { const [h, m] = hm.split(':').map(Number); return iso(h * 60 + m - nowMin + dayOffset * 1440); };
const hm = (min: number) => { const t = ((Math.round((nowMin + min) / 10) * 10) % 1440 + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

const sql: string[] = [];
const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = (table: string, o: Record<string, unknown>) => sql.push(`INSERT OR REPLACE INTO ${table} (${Object.keys(o).join(', ')}) VALUES (${Object.values(o).map(q).join(', ')});`);
const kv = (key: string, value: unknown) => row('kv', { key, json: JSON.stringify(value), updated_at: iso(0) });
const cache = (key: string, value: unknown) => kv('cache:' + key, { value, fetchedAt: '2099-01-01T00:00:00.000Z' }); // far future: never refetched

for (const t of ['tasks', 'memos', 'agent_sessions', 'agent_events', 'quotas', 'captures', 'memory', 'mails', 'feedback', 'jobs', 'expenses', 'recurring', 'notes', 'kv']) sql.push(`DELETE FROM ${t};`);

// ---------------------------------------------------------------- layout: defaults + one page with the remaining widgets
const layout = defaultLayout('landscape');
layout.device.timezone = TZ;
layout.location = { lat: 40.7128, lon: -74.006, name: '纽约', updatedAt: iso(-120) };
layout.profile = { about: '在读研究生，做多模态大模型方向，同时维护两个开源项目，常用 Claude Code 和 Codex。', city: '纽约', currency: 'USD', me: '阿哲', partner: '小满' };
const w = (id: string, type: Widget['type'], x: number, y: number, ww: number, h: number, props: Record<string, unknown> = {}, extra: Partial<Widget> = {}): Widget =>
  ({ id, type, x, y, w: ww, h, props: { ...catalogOf(type).props, ...props }, ...extra });
layout.pages.push({
  id: 'more', name: '更多',
  widgets: [
    w('m_clock', 'clock', 0, 0, 4, 3, { greeting: false }),
    w('m_tokens', 'stat', 4, 0, 4, 3, { metric: 'tokens:all' }),
    w('m_agents', 'stat', 8, 0, 4, 3, { metric: 'agents' }),
    w('m_ddl', 'stat', 12, 0, 4, 3, { metric: 'deadline' }),
    w('m_mail', 'mail', 0, 3, 8, 5, { max: 4 }),
    w('m_agentlist', 'agents', 8, 3, 8, 5, { max: 4 }),
    w('m_deadlines', 'deadlines', 0, 8, 6, 3, { max: 3, custom: [{ name: '开题报告修改稿', date: offDay(2) }] }),
    w('m_memo', 'memo', 6, 8, 5, 3, { mode: 'latest' }),
    w('m_text', 'text', 11, 8, 5, 3, { text: '先做最难的那件事。', size: 26 }),
    w('nav6', 'nav', 0, 11, 16, 1, {}, { hideTitle: true }),
  ],
});
for (const p of layout.pages) for (const x of p.widgets) if (x.type === 'ai' && x.props.mode === 'papers') x.props.feeds = 'cs.CV+cs.CL+cs.LG';
layout.updatedAt = iso(-60);
kv('layout', layout);
kv('secrets', { deepseek_key: 'sk-demo-not-a-real-key', github_token: 'demo', github_token_org: 'demo', money_partner: 'demo-partner-link' });
kv('device:status', { battery: 86, charging: true, batteryTemp: 27, ssid: 'Studio-5G', rssi: -51, wifiLevel: 4, app: '1.0.451568', webview: '108.0.5359.156', einkApi: true, timezone: TZ, uptimeMin: 4210, heapMb: 3, light: { a: 40, b: 60, brightness: 30, warmth: 60 }, chargeInput: false, batteryCare: true, contrast: 2, page: 'home', seenAt: iso(-0.3) });
kv('outlook:ics', { ok: iso(-6), n: 9 });
kv('mail:sync', { at: iso(-4), n: 23 });
kv('ai:usage', { day: new Date(now).toISOString().slice(0, 10), tokens: 48210, reasoning: 21034, calls: 17 });

// ---------------------------------------------------------------- plan, brief, research, observation
const b = (from: number, to: number, title: string, kind: 'task' | 'event' | 'break') => ({ start: hm(from), end: hm(to), title, kind });
kv(`plan:${day}`, {
  day, summary: '上午评审数据管线重构，下午组会后写实验部分', updatedAt: iso(-35), captures: 2,
  blocks: [b(-120, -50, '读两篇视频理解论文', 'task'), b(-40, 50, '评审数据加载重构的 PR', 'task'), b(50, 70, '休息', 'break'), b(70, 120, '回合作者邮件', 'task'),
    b(240, 300, '组会：消融实验进展', 'event'), b(320, 440, '写论文实验部分', 'task'), b(560, 620, '和小满去健身', 'event')],
  notes: ['组会前把第 3 组消融的曲线更新进 slides', '合作者在等对比实验的时间安排'],
  questions: [{ id: 'q1', q: '组会要准备几页 slides？', options: ['3 页', '5 页', '只讲口头进展'] }],
});
kv('ai:brief', { headline: '上午评审重构，下午组会讲消融', focus: '评审数据加载重构的 PR', bullets: ['Codex 在等你批准清理临时目录', '王老师要求周四前交开题修改稿', 'Codex 本周额度按当前速度会提前用完'], tip: '傍晚有阵雨，健身记得带伞', phase: '早上（规划今天）', generatedAt: iso(-50) });
kv('ai:research', { summary: '在做长视频理解的高效 token 压缩，近期重点是消融实验和数据加载管线的提速。', questions: [{ q: '长视频里哪些帧可以安全丢弃？', keywords: ['token pruning', 'long video understanding', 'frame selection'] }, { q: '多模态模型的数据加载瓶颈', keywords: ['data loading', 'multimodal pretraining', 'throughput'] }], avoid: ['robotics'], updatedAt: iso(-300) });
kv('ai:observation', { summary: '这周主线是长视频 token 压缩的消融实验，第 3 组在实验室服务器上跑。数据加载重构已提 PR，等阿哲评审。开题报告修改稿周四截止。和合作者约对比实验时间还没定。', updatedAt: iso(-600) });
kv('ai:papers', {
  scanned: 214, matched: 11, generatedAt: iso(-90), basedOn: '长视频理解的高效 token 压缩',
  items: [
    { id: '2611.04127', en: 'Skim then Focus: Query-Aware Frame Selection for Hour-Long Video QA', title: '先略读再细看：面向小时级视频问答的查询感知选帧', gist: '用轻量模型先给每帧打分，只把前 8% 的帧交给大模型，精度几乎不降。', why: '和你的帧丢弃问题直接相关，可作为消融基线', score: 9, authors: ['L. Chen', 'M. Okafor', 'R. Silva'] },
    { id: '2611.03881', en: 'Token Merging Revisited for Multimodal Transformers', title: '多模态 Transformer 中的 token 合并再研究', gist: '系统比较 6 种合并策略，指出位置编码处理是性能差异的主因。', why: '可以解释你第 3 组消融的异常', score: 8, authors: ['A. Novak', 'K. Ito'] },
    { id: '2611.02560', en: 'StreamLoader: Saturating GPUs in Video-Language Pretraining', title: 'StreamLoader：让视频-语言预训练跑满 GPU', gist: '解码与增强放到独立进程池，吞吐提升 2.3 倍。', why: '正好对应数据加载重构', score: 7, authors: ['J. Park', 'D. Müller', 'S. Rao'] },
  ],
});

// ---------------------------------------------------------------- tasks, memos, captures, memory
const task = (id: string, title: string, o: Record<string, unknown> = {}) => row('tasks', { id, title, done: 0, source: 'local', sort: 0, updated_at: iso(-30), day, priority: 2, ...o });
task('t1', '评审数据加载重构的 PR', { priority: 1, due: day, est_min: 90 });
task('t2', '开题报告修改稿发给王老师', { priority: 1, due: offDay(2), est_min: 120 });
task('t3', '回 Li Wei：约对比实验时间', { priority: 2, due: day, est_min: 15, ai_ok: 1, ai_how: '起草回复，列出三个可选时间' });
task('t4', '更新组会 slides 的消融曲线', { priority: 2, due: day, est_min: 40 });
task('t5', '整理本周 arXiv 论文摘要', { priority: 3, ai_ok: 1, ai_how: '按研究焦点挑 5 篇写摘要' });
task('t6', '给开源项目写 0.3 版本说明', { priority: 3, due: offDay(3), ai_ok: 1, ai_how: '根据提交记录起草更新日志' });
task('t7', '小满：周五晚上一起去看展', { priority: 1, due: offDay(2), source: 'partner' });
task('t8', '续费云服务器', { done: 1, done_at: iso(-80), priority: 2 });
row('memos', { id: 'm1', body: '实验室服务器维护：周六 02:00–06:00，别排长任务', pinned: 1, updated_at: iso(-2000) });
row('memos', { id: 'm2', body: '房东电话贴在冰箱上', pinned: 0, updated_at: iso(-5000) });
row('captures', { id: 'c1', text: '今天上午先评审那个数据加载的 PR，下午三点组会，晚上和小满去健身。顺便回一下 Li Wei 的邮件，开题报告周四要交。', source: 'phone', day, processed: 1, ts: iso(-60) });
const fact = (id: string, kind: string, subject: string, predicate: string, value: string, o: Record<string, unknown> = {}) =>
  row('memory', { id, kind, subject, predicate, value, evidence: null, confidence: 0.9, importance: 0.6, status: 'active', source: 'capture', pinned: 0, valid_from: iso(-20000), seen_at: iso(-200), hits: 3, ...o });
fact('f1', 'person', '王老师', '是', '用户的导师', { importance: 0.9, pinned: 1, evidence: '开题报告周四要交给王老师' });
fact('f2', 'person', 'Li Wei', '是', '合作者，负责对比实验', { evidence: '回一下 Li Wei 的邮件' });
fact('f3', 'research', '用户', '研究方向', '长视频理解的高效 token 压缩', { importance: 0.8 });
fact('f4', 'routine', '用户', '偏好的工作时段', '上午做需要专注的事，下午开会和沟通', { kind: 'preference' });
fact('f5', 'routine', '用户', '运动', '每周二、四晚上和小满去健身');
fact('f6', 'project', 'vision-lab', '当前阶段', '数据加载重构，等待评审', { source: 'agent' });

// ---------------------------------------------------------------- agents, autoloop, desktop-app asks, jobs
const agent = (id: string, tool: string, o: Record<string, unknown>) => row('agent_sessions', { id, tool, host: 'Mac', branch: 'main', tool_calls: 0, started_at: iso(-90), updated_at: iso(-1), ...o });
agent('a1', 'claude', { project: 'vision-lab', title: '重构数据加载管线', state: 'running', step: '运行 pytest tests/test_loader.py', tool_calls: 37, turn_started_at: iso(-12), branch: 'refactor/loader' });
agent('a2', 'codex', { project: 'paper-figures', title: '给论文图表脚本加单元测试', state: 'waiting', message: '要执行 rm -rf outputs/tmp，等你批准', tool_calls: 14, turn_started_at: iso(-6), updated_at: iso(-2) });
agent('a3', 'claude', { project: 'ablation', host: '实验室服务器', title: '消融实验第 3 组', state: 'running', step: 'tail -f logs/run3.log', tool_calls: 22, turn_started_at: iso(-41) });
agent('a4', 'dsh', { project: 'weekly', title: '整理周报素材', state: 'idle', message: '已汇总本周 14 次提交和 3 次组会记录', tool_calls: 9, last_turn_sec: 384, updated_at: iso(-18) });
agent('a5', 'claude', { project: 'website', title: '修复官网 lint 报错', state: 'done', message: '修好 6 处 lint，CI 已通过', tool_calls: 11, last_turn_sec: 212, updated_at: iso(-8) });
kv('autoloop:state', {
  at: iso(-1),
  cards: [{ id: 41, kind: 'ask', state: 'open', title: '下周组会要改到周四吗？', text: '王老师周三出差，日历上周四 14:00 空着。', options: ['改到周四 14:00', '保持周三，线上开', '先问王老师'], recommend: 0, created: iso(-25), rule: '日程助理' }],
  runs: [{ id: 902, rule: '每日论文摘要', state: 'claimed', lane: 'codex', started: iso(-4) }],
});
kv('app:asks', [{ id: 'app-1', title: '开源项目官网改版', ask: '首页改好了，要我直接推到 preview 分支吗？', at: iso(-9) }]);
row('jobs', { id: 'j1', task_id: 't5', title: '整理本周 arXiv 论文摘要', agent: 'claude', status: 'done', seen: 0, summary: '已整理 6 篇论文摘要，2 篇和消融直接相关', created_at: iso(-140), updated_at: iso(-20) });
row('jobs', { id: 'j2', task_id: 't3', title: '回 Li Wei：约对比实验时间', agent: 'dsh', status: 'running', seen: 0, created_at: iso(-7), updated_at: iso(-3) });

// ---------------------------------------------------------------- quotas, usage, balances
const win = (name: string, label: string, usedPct: number, resetMin: number, willLast = true) => ({ name, label, usedPct, resetsAt: iso(resetMin), pace: { willLast, expectedPct: usedPct - 6 } });
const quota = (provider: string, label: string, plan: string, windows: unknown[]) => row('quotas', { provider, json: JSON.stringify({ provider, label, plan, windows, capturedAt: iso(-2) }), captured_at: iso(-2) });
quota('claude', 'Claude', 'Max', [win('session', '5 小时', 38, 170), win('weekly', '本周', 61, 3 * 1440)]);
quota('codex', 'Codex', 'Plus', [win('session', '5 小时', 72, 95), win('weekly', '本周', 84, 4 * 1440, false)]);
quota('cursor', 'Cursor', 'Pro', [win('monthly', '本月', 27, 19 * 1440)]);
const usageDays = (base: number) => Array.from({ length: 7 }, (_, i) => ({ date: offDay(i - 6), tokens: Math.round(base * (0.6 + ((i * 37) % 7) / 10)), cost: 0 }));
kv('usage', {
  claude: { provider: 'claude', label: 'Claude Code', today: { date: day, tokens: 1830000, cost: 4.1 }, daily: usageDays(2_400_000), last30Tokens: 61_000_000, last30Cost: 132, capturedAt: iso(-3) },
  codex: { provider: 'codex', label: 'Codex', today: { date: day, tokens: 640000, cost: 1.2 }, daily: usageDays(900_000), last30Tokens: 22_000_000, last30Cost: 41, capturedAt: iso(-3) },
});
cache('balances', [
  { id: 'deepseek', label: 'DeepSeek', value: '¥128.40', sub: '余额', capturedAt: iso(-20) },
  { id: 'openrouter', label: 'OpenRouter', value: '$23.10', sub: '余额', capturedAt: iso(-20) },
  { id: 'moonshot', label: 'Kimi', value: '¥56.00', sub: '余额', capturedAt: iso(-20) },
]);

// ---------------------------------------------------------------- GitHub, markets, deadlines, calendar
cache('github', {
  login: 'azhe-dev', reviewCount: 1,
  reviews: [{ title: '数据加载改用多进程解码', repo: 'lumen-lab/vision-lab', number: 128, author: 'kai-w', url: 'https://github.com/' }],
  mine: [],
  repos: [
    { repo: 'lumen-lab/vision-lab', private: true, pushedAt: iso(-15), issues: 7, prs: 3, ci: 'PENDING', account: 'org' },
    { repo: 'azhe-dev/paper-figures', private: false, pushedAt: iso(-48), issues: 1, prs: 0, ci: 'FAILURE', account: 'personal' },
    { repo: 'lumen-lab/website', private: false, pushedAt: iso(-130), issues: 0, prs: 1, ci: 'SUCCESS', account: 'org' },
    { repo: 'azhe-dev/token-prune', private: false, pushedAt: iso(-1500), issues: 4, prs: 2, ci: 'SUCCESS', account: 'personal' },
    { repo: 'azhe-dev/dotfiles', private: false, pushedAt: iso(-4300), issues: 0, prs: 0, ci: null, account: 'personal' },
    { repo: 'lumen-lab/datasets-index', private: true, pushedAt: iso(-7200), issues: 2, prs: 0, ci: 'SUCCESS', account: 'org' },
  ],
});
const spark = (start: number, drift: number, n = 24) => Array.from({ length: n }, (_, i) => +(start * (1 + drift * (i / n) + 0.004 * Math.sin(i * 1.7))).toFixed(4));
const QUOTES: Record<string, any> = {
  'USDCNY=X': { price: 7.1268, changePct: 0.12, currency: 'CNY', spark: spark(7.11, 0.002) },
  '^GSPC': { price: 6842.3, changePct: 0.48, currency: 'USD', spark: spark(6800, 0.006) },
  'BTC-USD': { price: 96410, changePct: -1.85, currency: 'USD', spark: spark(98200, -0.02) },
  NVDA: { price: 182.4, changePct: 1.32, currency: 'USD', spark: spark(179, 0.013), ext: { session: 'pre', price: 184.1, changePct: 0.93, at: now - 5 * 60_000 } },
};
for (const p of layout.pages) for (const x of p.widgets) {
  if (x.type === 'markets') {
    const items = x.props.items || [];
    cache(`markets:${items.map((i: any) => i.symbol).join(',')}`, items.map((i: any) => {
      const v = QUOTES[i.symbol] || { price: 100, changePct: 0, currency: 'USD', spark: spark(100, 0) };
      return { symbol: i.symbol, label: i.label, change: +(v.price * v.changePct / 100).toFixed(4), ...v };
    }));
  }
  if (x.type === 'deadlines') cache(`deadlines:${(x.props.conferences || []).join(',').toLowerCase()}`, [
    { name: 'CVPR', detail: '2027 摘要', at: at('23:59', 1), tz: 'AoE', kind: 'conf', rank: 'A' },
    { name: 'ICML', detail: '2027 全文', at: iso(40 * 1440), tz: 'AoE', kind: 'conf', rank: 'A' },
    { name: 'ACL', detail: '2027 ARR', at: iso(68 * 1440), tz: 'AoE', kind: 'conf', rank: 'A' },
  ]);
}
const ev = (title: string, start: string, end: string, location?: string, calendar = '日历') => ({ title, start, end, allDay: false, location, calendar });
const events = [
  ev('组会：消融实验进展', at(hm(240)), at(hm(300)), '实验楼 512'),
  ev('和小满去健身', at(hm(560)), at(hm(620)), '健身房', '小满'),
  ev('研究生论坛彩排', at('14:00', 1), at('15:30', 1), '学术报告厅'),
  ev('和 Li Wei 对比实验', at('10:00', 2), at('11:00', 2), 'Zoom'),
  ev('牙医复查', at('09:30', 3), at('10:00', 3), '社区诊所'),
  ev('开源项目周会', at('20:00', 3), at('20:45', 3), 'Teams'),
  ev('看展', at('19:00', 2), at('21:00', 2), '美术馆', '小满'),
  { title: '王老师出差', start: at('00:00', 1), end: at('00:00', 2), allDay: true, calendar: '日历' },
].sort((a, b) => a.start.localeCompare(b.start));
kv('outlook:events', events);
for (const k of ['calendar:auto:1', 'calendar:auto:7']) cache(k, events);

// ---------------------------------------------------------------- mail
const mail = (id: string, sender: string, subject: string, summary: string, action: string, minAgo: number) =>
  row('mails', { id, sender, subject, received: iso(-minAgo), snippet: '', important: 1, action, summary, done: 0, triaged: 1 });
mail('ml1', '王老师 <wang@example.edu>', '开题报告修改意见', '周四前交开题报告修改稿，重点补实验设计', 'deadline', 140);
mail('ml2', 'Li Wei <liwei@example.com>', 'Re: comparison runs', '问下周能否一起跑一组对比实验', 'reply', 75);
mail('ml3', '研究生办公室 <grad@example.edu>', '研究生论坛彩排安排', '明天 14:00 论坛彩排，需带 8 分钟 slides', 'meeting', 300);
mail('ml4', 'Conference Committee <noreply@example.org>', 'Camera-ready reminder', '下月 3 日前上传 camera-ready 版本', 'read', 900);

// ---------------------------------------------------------------- ledger + notes
const spend = (id: string, dOff: number, amount: number, category: string, note: string, who: 'me' | 'partner', shared = 0, currency = 'USD', base = amount) =>
  row('expenses', { id, day: offDay(dOff), ts: iso(dOff * 1440), amount, currency, aud: base, category, note, shared, who, kind: 'spend' });
spend('e1', 0, 6.5, '餐饮', '咖啡', 'me');
spend('e2', 0, 64.3, '买菜', '一起买菜', 'partner', 1);
spend('e3', -1, 38, '交通', '打车去机场', 'me');
spend('e4', -1, 120, '餐饮', '火锅', 'me', 1);
spend('e5', -2, 280, '购物', '奶茶和零食', 'partner', 0, 'CNY', 39.3);
spend('e6', -3, 15.99, '学习', '电子书', 'me');
spend('e7', -4, 89, '娱乐', '音乐节门票', 'partner', 1);
spend('e8', -5, 22, '医疗', '药店', 'partner');
row('expenses', { id: 's1', day: offDay(-6), ts: iso(-6 * 1440), amount: 1000, currency: 'USD', aud: 1000, category: '结算', note: '小满 转给 阿哲', shared: 0, who: 'partner', kind: 'settle' });
const rec = (id: string, name: string, amount: number, period: string, anchorOff: number, category: string, who: 'me' | 'partner', shared = 0, currency = 'USD') =>
  row('recurring', { id, name, amount, currency, period, anchor: offDay(anchorOff), start: offDay(-40), category, shared, active: 1, updated_at: iso(-3000), who });
rec('r1', '房租', 2400, 'monthly', 4, '房租', 'me', 1);
rec('r2', '水电网', 160, 'monthly', 9, '水电网', 'partner', 1);
rec('r3', 'Claude Max', 100, 'monthly', 12, '订阅', 'me');
rec('r4', '视频会员', 15.49, 'monthly', 6, '订阅', 'partner', 1);
rec('r5', '健身房', 45, 'fortnightly', 3, '娱乐', 'me', 1);
const note = (id: string, title: string, status: string, due: string | null, minAgo: number, taskId?: string) =>
  row('notes', { id, from_who: 'partner', text: title, title, due, status, task_id: taskId || null, created_at: iso(-minAgo), updated_at: iso(-minAgo / 2) });
note('n1', '周五晚上一起去看展', 'sent', offDay(2) + 'T19:00', 30, 't7');
note('n2', '给我买杯奶茶', 'done', null, 600);
note('n3', '今晚早点睡', 'ack', null, 1500);
note('n4', '周末陪我看电影', 'later', null, 3000);

process.stdout.write(sql.join('\n') + '\n');
