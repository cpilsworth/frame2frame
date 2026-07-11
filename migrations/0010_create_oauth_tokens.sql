-- Stores the operator's Adobe IMS user-OAuth tokens (authorization-code flow,
-- "Web App" credential type in the Developer Console). Single row: the worker
-- mints fresh access tokens from the refresh token without re-prompting until
-- the refresh token itself expires.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL, -- epoch milliseconds
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
