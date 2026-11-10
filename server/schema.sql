CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due TEXT, done INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'local', ext_id TEXT, list TEXT, sort REAL NOT NULL DEFAULT 0,
  done_at TEXT, updated_at TEXT NOT NULL, day TEXT, priority INTEGER, est_min INTEGER, ai_ok INTEGER, ai_how TEXT
);
CREATE TABLE IF NOT EXISTS memos (id TEXT PRIMARY KEY, body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, host TEXT, project TEXT, branch TEXT, title TEXT,
  state TEXT NOT NULL, step TEXT, message TEXT, tool_calls INTEGER NOT NULL DEFAULT 0,
  turn_started_at TEXT, last_turn_sec INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT, summary TEXT, ts TEXT);
CREATE INDEX IF NOT EXISTS agent_events_session ON agent_events(session_id, id);
CREATE TABLE IF NOT EXISTS quotas (provider TEXT PRIMARY KEY, json TEXT NOT NULL, captured_at TEXT NOT NULL);
-- ① raw inputs (append-only)
CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'phone', day TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS captures_day ON captures(day, ts);
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
  evidence TEXT, confidence REAL NOT NULL DEFAULT 0.8, importance REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active', source TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL, valid_to TEXT, seen_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS memory_key ON memory(subject, predicate, status);

-- mail triage results (from the Mac collector)
CREATE TABLE IF NOT EXISTS mails (
  id TEXT PRIMARY KEY, sender TEXT, subject TEXT, received TEXT, snippet TEXT,
  important INTEGER, action TEXT, summary TEXT, done INTEGER NOT NULL DEFAULT 0, triaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mails_received ON mails(received);
-- ⑤ feedback
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, ref TEXT, vote INTEGER NOT NULL, note TEXT, ts TEXT NOT NULL);

-- existing databases: apply migrate_001.sql and migrate_003.sql once
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL, detail TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'queued',
  event_id INTEGER, run_id INTEGER, summary TEXT, result TEXT, seen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_answers (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, choice INTEGER, text TEXT, status TEXT NOT NULL DEFAULT 'pending', ts TEXT NOT NULL);
-- 记账：一次性花费 + 固定支出（房租、订阅……按周期自动计入）
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, ts TEXT NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CNY', aud REAL NOT NULL, -- aud = amount in the ledger's base currency (name kept from v1)
  category TEXT, note TEXT, shared INTEGER NOT NULL DEFAULT 0, capture_id TEXT,
  who TEXT NOT NULL DEFAULT 'me', kind TEXT NOT NULL DEFAULT 'spend' -- who: me | partner
);
CREATE INDEX IF NOT EXISTS expenses_day ON expenses(day);
CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CNY',
  period TEXT NOT NULL, anchor TEXT NOT NULL, start TEXT NOT NULL,
  category TEXT, shared INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, note TEXT, updated_at TEXT,
  who TEXT NOT NULL DEFAULT 'me'
);
-- 记账页上另一位写给看板主人的小纸条
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, from_who TEXT NOT NULL DEFAULT 'partner', text TEXT NOT NULL, title TEXT NOT NULL, due TEXT,
  status TEXT NOT NULL DEFAULT 'sent', task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
