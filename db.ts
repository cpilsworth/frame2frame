// Persists received Frame.io webhook events so we can render them on the home page.

export interface StoredEvent {
  id: number;
  received_at: string;
  event_type: string;
  event_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  account_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  payload: string;
}

// Frame.io retries webhook deliveries on non-2xx responses and can, rarely,
// double-send. Each delivery carries a unique `id`; INSERT OR IGNORE against
// a UNIQUE index on event_id makes storing a redelivered event a no-op, and
// the caller uses `isNew` to skip re-running deferred side effects.
export async function recordEvent(
  db: D1Database,
  payload: Record<string, unknown>,
  rawBody: string,
): Promise<{ isNew: boolean }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO frameio_events
        (event_id, event_type, resource_type, resource_id, account_id, workspace_id, project_id, user_id, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      (payload?.id as string) ?? null,
      (payload?.type as string) ?? "unknown",
      (payload?.resource as Record<string, unknown>)?.type ?? null,
      (payload?.resource as Record<string, unknown>)?.id ?? null,
      (payload?.account as Record<string, unknown>)?.id ?? null,
      (payload?.workspace as Record<string, unknown>)?.id ?? null,
      (payload?.project as Record<string, unknown>)?.id ?? null,
      (payload?.user as Record<string, unknown>)?.id ?? null,
      rawBody,
    )
    .run();
  return { isNew: result.meta.changes > 0 };
}

export async function recentEvents(db: D1Database, limit = 20): Promise<StoredEvent[]> {
  const res = await db
    .prepare(
      `SELECT id, received_at, event_type, event_id, resource_type, resource_id,
              account_id, workspace_id, project_id, user_id, payload
       FROM frameio_events
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<StoredEvent>();
  return res.results;
}

// Retention: drop raw event log rows older than `olderThanDays`. Run from the
// reconciliation cron so frameio_events doesn't grow unbounded.
export async function pruneOldEvents(db: D1Database, olderThanDays: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM frameio_events WHERE received_at < datetime('now', ?)`)
    .bind(`-${olderThanDays} days`)
    .run();
  return result.meta.changes;
}
