CREATE TABLE team_demo_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member','auditor')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  balance_cents INTEGER NOT NULL CHECK(balance_cents BETWEEN 0 AND 100000000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE team_demo_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES team_demo_users(id),
  public_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX team_demo_session_expiry ON team_demo_sessions(expires_at);
CREATE TABLE team_demo_transfers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES team_demo_users(id),
  recipient_id TEXT NOT NULL REFERENCES team_demo_users(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0 AND amount_cents <= 100000000),
  created_at TEXT NOT NULL,
  CHECK(sender_id <> recipient_id),
  UNIQUE(sender_id, request_id)
);
CREATE TABLE team_demo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES team_demo_users(id),
  action TEXT NOT NULL,
  subject_id TEXT,
  created_at TEXT NOT NULL
);
