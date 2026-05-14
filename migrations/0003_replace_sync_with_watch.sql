-- Replace the unused two-instance sync schema (0002) with the single-instance
-- watch/comment schema for the asset-watch UI.

DROP TABLE IF EXISTS failed_events;
DROP TABLE IF EXISTS comment_mapping;
DROP TABLE IF EXISTS file_mapping;
DROP TABLE IF EXISTS event_log;
DROP TABLE IF EXISTS project_mapping;

CREATE TABLE IF NOT EXISTS watched_assets (
  file_id        TEXT PRIMARY KEY,
  name           TEXT,
  account_id     TEXT,
  workspace_id   TEXT,
  project_id     TEXT,
  watched_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captured_comments (
  comment_id     TEXT PRIMARY KEY,
  file_id        TEXT NOT NULL,
  parent_id      TEXT,
  author_name    TEXT,
  author_email   TEXT,
  text           TEXT,
  timecode       TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  raw_payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captured_comments_file ON captured_comments(file_id, received_at DESC);
