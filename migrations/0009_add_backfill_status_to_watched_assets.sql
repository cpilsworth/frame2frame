-- Surface backfill/reconciliation health per watched asset: when it last ran
-- and, if it failed, why (e.g. FRAMEIO_TOKEN unset, API error).
ALTER TABLE watched_assets ADD COLUMN last_backfill_at TEXT;
ALTER TABLE watched_assets ADD COLUMN last_backfill_error TEXT;
