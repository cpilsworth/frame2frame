-- V4 file response carries an authoritative `view_url` we should use for
-- linking back into the Frame.io UI, instead of guessing the URL shape.
ALTER TABLE assets ADD COLUMN view_url TEXT;
