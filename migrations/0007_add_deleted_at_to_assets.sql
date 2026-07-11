-- Track file deletions so the UI/reconciliation can distinguish a still-live
-- asset from one Frame.io has deleted. Set on file.deleted; cleared whenever
-- a later file.* event (or reconciliation re-resolve) proves the file is
-- still fetchable.
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
