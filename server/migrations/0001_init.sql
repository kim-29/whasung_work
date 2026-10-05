-- 사용자(관리자/직원/작업장). pin_hash = HMAC-SHA256(PIN_PEPPER, pin) 16진수. 중복 PIN 방지용 UNIQUE.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','workshop')),
  pin_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 등록된 기기 (토큰은 해시만 저장)
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked INTEGER NOT NULL DEFAULT 0
);

-- PIN 무차별 대입 방지 (기기/IP 키별)
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE bar_database (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kg_per_m REAL NOT NULL CHECK (kg_per_m > 0),
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- 작업지시서(오더) 헤더. 상태: pending(대기) / making(절단완료·제작중) / unpaid(미납) / paid(완납)
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cut','make')),
  content TEXT,
  request_note TEXT,
  drawing_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','making','unpaid','paid')),
  source TEXT NOT NULL CHECK (source IN ('front','blender','manual')),
  has_unknown_bar INTEGER NOT NULL DEFAULT 0,
  theory_weight REAL NOT NULL DEFAULT 0,
  actual_weight REAL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cut_done_at TEXT,
  completed_at TEXT,
  paid_at TEXT
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_company ON orders(company);
CREATE INDEX idx_orders_created ON orders(created_at);

-- 절단서 행 (work_list)
CREATE TABLE work_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  bar_name TEXT NOT NULL,
  length_mm INTEGER NOT NULL CHECK (length_mm > 0),
  qty INTEGER NOT NULL CHECK (qty > 0),
  color TEXT,
  kg_per_m REAL,          -- 저장 시점 스냅샷 (미등록 바는 NULL)
  theory_weight REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_work_list_order ON work_list(order_id);
CREATE INDEX idx_work_list_bar ON work_list(bar_name);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  order_id INTEGER,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
);
