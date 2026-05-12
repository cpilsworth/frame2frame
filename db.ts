// Persists received Frame.io webhook events so we can render them on the home page.

export interface StoredEvent {
  id: number;
  received_at: string;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  account_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  payload: string;
}

export async function recordEvent(db: D1Database, payload: Record<string, unknown>, rawBody: string) {
  await db
    .prepare(
      `INSERT INTO frameio_events
        (event_type, resource_type, resource_id, account_id, workspace_id, project_id, user_id, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
}

export async function recentEvents(db: D1Database, limit = 20): Promise<StoredEvent[]> {
  const res = await db
    .prepare(
      `SELECT id, received_at, event_type, resource_type, resource_id,
              account_id, workspace_id, project_id, user_id, payload
       FROM frameio_events
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<StoredEvent>();
  return res.results;
}
