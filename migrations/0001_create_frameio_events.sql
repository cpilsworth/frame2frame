CREATE TABLE IF NOT EXISTS frameio_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  account_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  user_id TEXT,
  payload TEXT NOT NULL
);
