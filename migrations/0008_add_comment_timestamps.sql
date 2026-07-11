-- Frame.io's own created_at/updated_at on the comment record, distinct from
-- received_at (when our webhook/backfill saw it). Lets comment ordering
-- reflect when the comment actually happened rather than when we learned
-- about it.
ALTER TABLE captured_comments ADD COLUMN comment_created_at TEXT;
ALTER TABLE captured_comments ADD COLUMN comment_updated_at TEXT;
