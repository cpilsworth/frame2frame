-- Cached file metadata resolved from Frame.io's API after a file.* webhook.
-- The webhook itself only carries IDs, so the worker fetches the file record
-- and upserts here. Used by the UI to render names and sizes, and by the
-- watched-asset panel to populate metadata.

CREATE TABLE IF NOT EXISTS assets (
  file_id          TEXT PRIMARY KEY,
  name             TEXT,
  account_id       TEXT,
  workspace_id     TEXT,
  project_id       TEXT,
  parent_folder_id TEXT,
  file_size        INTEGER,
  media_type       TEXT,
  status           TEXT,
  resolved_at      TEXT NOT NULL DEFAULT (datetime('now')),
  raw              TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
