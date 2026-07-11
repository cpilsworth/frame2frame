// D1 accessors for the single-instance watch/comment UI.

export interface WatchedAsset {
  file_id: string;
  name: string | null;
  account_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  view_url: string | null;
  watched_at: string;
  last_backfill_at: string | null;
  last_backfill_error: string | null;
}

export interface AssetMetadata {
  file_id: string;
  name: string | null;
  account_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  parent_folder_id: string | null;
  file_size: number | null;
  media_type: string | null;
  status: string | null;
  view_url: string | null;
  resolved_at: string;
  raw: string | null;
  deleted_at: string | null;
}

export interface CapturedComment {
  comment_id: string;
  file_id: string;
  parent_id: string | null;
  author_name: string | null;
  author_email: string | null;
  text: string | null;
  timecode: string | null;
  comment_created_at: string | null;
  comment_updated_at: string | null;
  received_at: string;
  raw_payload: string;
}

/**
 * One row per file_id seen across the debug event log. Asset name and account
 * context are best-effort from the most recent event mentioning the file.
 */
export interface AssetListRow {
  file_id: string;
  name: string | null;
  account_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  view_url: string | null;
  last_event_type: string;
  last_event_at: string;
  is_watched: number; // SQLite boolean
}

// --- assets (cached file metadata from API) ----------------------------------

// A successful upsert is proof the file is still fetchable from Frame.io, so
// this always clears deleted_at — even if a stale file.deleted event is
// later reprocessed, the next successful resolve wins.
export async function upsertAsset(
  db: D1Database,
  asset: Omit<AssetMetadata, "resolved_at" | "deleted_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets
         (file_id, name, account_id, workspace_id, project_id, parent_folder_id,
          file_size, media_type, status, view_url, raw, resolved_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT (file_id) DO UPDATE SET
         name             = COALESCE(excluded.name, assets.name),
         account_id       = COALESCE(excluded.account_id, assets.account_id),
         workspace_id     = COALESCE(excluded.workspace_id, assets.workspace_id),
         project_id       = COALESCE(excluded.project_id, assets.project_id),
         parent_folder_id = COALESCE(excluded.parent_folder_id, assets.parent_folder_id),
         file_size        = COALESCE(excluded.file_size, assets.file_size),
         media_type       = COALESCE(excluded.media_type, assets.media_type),
         status           = COALESCE(excluded.status, assets.status),
         view_url         = COALESCE(excluded.view_url, assets.view_url),
         raw              = excluded.raw,
         resolved_at      = datetime('now'),
         deleted_at       = NULL`,
    )
    .bind(
      asset.file_id,
      asset.name,
      asset.account_id,
      asset.workspace_id,
      asset.project_id,
      asset.parent_folder_id,
      asset.file_size,
      asset.media_type,
      asset.status,
      asset.view_url,
      asset.raw,
    )
    .run();
}

export async function getAsset(db: D1Database, file_id: string): Promise<AssetMetadata | null> {
  return db.prepare(`SELECT * FROM assets WHERE file_id = ?`).bind(file_id).first<AssetMetadata>();
}

// file.deleted webhook handling. Upserts a bare row (resolved_at falls back
// to its column default) so a delete-before-any-resolve event still lands,
// then stamps deleted_at. Cleared again by the next successful upsertAsset.
export async function markAssetDeleted(db: D1Database, file_id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets (file_id, deleted_at)
       VALUES (?, datetime('now'))
       ON CONFLICT (file_id) DO UPDATE SET deleted_at = datetime('now')`,
    )
    .bind(file_id)
    .run();
}

// --- assets (derived from frameio_events) ------------------------------------

/**
 * Distinct file_id seen in webhook events, joined with watched_assets so the
 * UI can show a Watch/Unwatch toggle. Most-recent event metadata wins.
 *
 * NOTE: we look at any event whose `resource_type='file'` OR whose
 * `event_type` starts with 'file.' — covers `file.ready`, `file.created`,
 * `file.versioned`, `file.deleted`, etc.
 */
// TODO(v4-verify): exact JSON path of the file name in the V4 webhook payload.
// COALESCE across the most plausible shapes; adjust to the single correct one
// once a real payload is inspected.
const EVENT_NAME_EXPR = `COALESCE(
  json_extract(payload, '$.resource.name'),
  json_extract(payload, '$.data.name'),
  json_extract(payload, '$.data.resource.name'),
  json_extract(payload, '$.data.file.name'),
  json_extract(payload, '$.file.name'),
  json_extract(payload, '$.name')
)`;

export async function listAssetsFromEvents(db: D1Database, limit = 50): Promise<AssetListRow[]> {
  const res = await db
    .prepare(
      `WITH files AS (
         SELECT
           resource_id   AS file_id,
           account_id,
           workspace_id,
           project_id,
           event_type,
           received_at,
           ${EVENT_NAME_EXPR} AS event_name,
           ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY id DESC) AS rn
         FROM frameio_events
         WHERE resource_id IS NOT NULL
           AND (resource_type = 'file' OR event_type LIKE 'file.%')
       )
       SELECT
         f.file_id,
         COALESCE(w.name, a.name, f.event_name)            AS name,
         COALESCE(a.account_id,    f.account_id)            AS account_id,
         COALESCE(a.workspace_id,  f.workspace_id)          AS workspace_id,
         COALESCE(a.project_id,    f.project_id)            AS project_id,
         a.view_url                                         AS view_url,
         f.event_type                                       AS last_event_type,
         f.received_at                                      AS last_event_at,
         CASE WHEN w.file_id IS NULL THEN 0 ELSE 1 END      AS is_watched
       FROM files f
       LEFT JOIN watched_assets w ON w.file_id = f.file_id
       LEFT JOIN assets          a ON a.file_id = f.file_id
       WHERE f.rn = 1
       ORDER BY f.received_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<AssetListRow>();
  return res.results;
}

// --- watched_assets ----------------------------------------------------------

export async function isWatched(db: D1Database, file_id: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT file_id FROM watched_assets WHERE file_id = ?`)
    .bind(file_id)
    .first<{ file_id: string }>();
  return row !== null;
}

export async function getWatchedAsset(db: D1Database, file_id: string): Promise<WatchedAsset | null> {
  return db
    .prepare(`SELECT * FROM watched_assets WHERE file_id = ?`)
    .bind(file_id)
    .first<WatchedAsset>();
}

export async function listWatchedAssets(db: D1Database): Promise<WatchedAsset[]> {
  const res = await db
    .prepare(
      `WITH event_names AS (
         SELECT
           resource_id AS file_id,
           ${EVENT_NAME_EXPR} AS name,
           ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY id DESC) AS rn
         FROM frameio_events
         WHERE resource_id IS NOT NULL
       )
       SELECT
         w.file_id,
         COALESCE(w.name, a.name, en.name)             AS name,
         COALESCE(w.account_id,    a.account_id)        AS account_id,
         COALESCE(w.workspace_id,  a.workspace_id)      AS workspace_id,
         COALESCE(w.project_id,    a.project_id)        AS project_id,
         a.view_url                                     AS view_url,
         w.watched_at,
         w.last_backfill_at,
         w.last_backfill_error
       FROM watched_assets w
       LEFT JOIN assets      a  ON a.file_id  = w.file_id
       LEFT JOIN event_names en ON en.file_id = w.file_id AND en.rn = 1
       ORDER BY w.watched_at DESC`,
    )
    .all<WatchedAsset>();
  return res.results;
}

export async function watchAsset(
  db: D1Database,
  asset: Omit<WatchedAsset, "watched_at" | "view_url" | "last_backfill_at" | "last_backfill_error">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watched_assets (file_id, name, account_id, workspace_id, project_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET
         name = COALESCE(excluded.name, watched_assets.name),
         account_id = COALESCE(excluded.account_id, watched_assets.account_id),
         workspace_id = COALESCE(excluded.workspace_id, watched_assets.workspace_id),
         project_id = COALESCE(excluded.project_id, watched_assets.project_id)`,
    )
    .bind(asset.file_id, asset.name, asset.account_id, asset.workspace_id, asset.project_id)
    .run();
}

export async function unwatchAsset(db: D1Database, file_id: string): Promise<void> {
  await db.prepare(`DELETE FROM watched_assets WHERE file_id = ?`).bind(file_id).run();
}

// Recorded after every backfill attempt (initial watch, manual refresh, and
// the reconciliation cron) so the UI/operator can see when it last ran and,
// if it failed, why. `error` null means the run succeeded.
export async function setBackfillStatus(
  db: D1Database,
  file_id: string,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE watched_assets SET last_backfill_at = datetime('now'), last_backfill_error = ? WHERE file_id = ?`,
    )
    .bind(error, file_id)
    .run();
}

// --- captured_comments -------------------------------------------------------

export async function insertCapturedComment(
  db: D1Database,
  row: Omit<CapturedComment, "received_at">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO captured_comments
         (comment_id, file_id, parent_id, author_name, author_email, text, timecode,
          comment_created_at, comment_updated_at, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (comment_id) DO UPDATE SET
         file_id = excluded.file_id,
         parent_id = excluded.parent_id,
         author_name = excluded.author_name,
         author_email = excluded.author_email,
         text = excluded.text,
         timecode = excluded.timecode,
         comment_created_at = excluded.comment_created_at,
         comment_updated_at = excluded.comment_updated_at,
         raw_payload = excluded.raw_payload`,
    )
    .bind(
      row.comment_id,
      row.file_id,
      row.parent_id,
      row.author_name,
      row.author_email,
      row.text,
      row.timecode,
      row.comment_created_at,
      row.comment_updated_at,
      row.raw_payload,
    )
    .run();
}

export async function deleteCapturedComment(db: D1Database, comment_id: string): Promise<void> {
  await db.prepare(`DELETE FROM captured_comments WHERE comment_id = ?`).bind(comment_id).run();
}

// Reconciliation: drop captured comments for a file that no longer appear in
// a live listing from Frame.io. Only call this with a listing that actually
// succeeded — an empty array legitimately means "delete everything captured
// for this file".
export async function deleteCommentsNotIn(
  db: D1Database,
  file_id: string,
  liveCommentIds: string[],
): Promise<number> {
  if (liveCommentIds.length === 0) {
    const result = await db
      .prepare(`DELETE FROM captured_comments WHERE file_id = ?`)
      .bind(file_id)
      .run();
    return result.meta.changes;
  }
  const placeholders = liveCommentIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`DELETE FROM captured_comments WHERE file_id = ? AND comment_id NOT IN (${placeholders})`)
    .bind(file_id, ...liveCommentIds)
    .run();
  return result.meta.changes;
}

export async function commentsForFile(
  db: D1Database,
  file_id: string,
  limit = 50,
): Promise<CapturedComment[]> {
  const res = await db
    .prepare(
      `SELECT * FROM captured_comments
       WHERE file_id = ?
       ORDER BY COALESCE(comment_created_at, received_at) ASC
       LIMIT ?`,
    )
    .bind(file_id, limit)
    .all<CapturedComment>();
  return res.results;
}
