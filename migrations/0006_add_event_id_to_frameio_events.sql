-- Webhook deliveries carry a unique `id`. Frame.io retries on non-2xx
-- responses and can rarely double-send, so we store the delivery id and
-- dedupe on it (INSERT OR IGNORE against this unique index) rather than
-- re-running deferred side effects for the same event twice.
ALTER TABLE frameio_events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_frameio_events_event_id ON frameio_events(event_id);
