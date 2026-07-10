// Frame.io single-instance asset-watch worker.
//
// Routes:
//   GET  /                          — UI: assets seen, watch toggles, comments, upload
//   POST /webhook                   — Frame.io webhook (verify + log + capture comments on watched files)
//   POST /watch/:fileId             — toggle watched state (form post)
//   POST /assets/:fileId/versions   — upload a new version (multipart/form-data)
//
// Docs: https://next.developer.frame.io/platform/docs/guides/webhooks

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { verifySignature } from "./verify";
import { recordEvent, recentEvents } from "./db";
import { renderHome } from "./home";
import type { Env } from "./src/env";
import {
  listAssetsFromEvents,
  listWatchedAssets,
  isWatched,
  watchAsset,
  unwatchAsset,
  insertCapturedComment,
  commentsForFile,
  upsertAsset,
} from "./src/db/queries";
import { handleVersionUpload } from "./src/upload";
import { FrameIoClient, isValidFrameIoId } from "./src/frameio/client";

export type { Env };

const app = new Hono<{ Bindings: Env }>();

// Everything except /webhook (which authenticates via HMAC signature) is
// gated behind basic auth: the UI exposes comment text and author emails,
// and the upload/watch routes act on Frame.io with the server's token.
// Fails closed with 503 until the UI_PASSWORD secret is set.
app.use("*", async (c, next) => {
  if (c.req.path === "/webhook") return next();
  if (!c.env.UI_PASSWORD) {
    return c.text("UI disabled: set the UI_PASSWORD secret (wrangler secret put UI_PASSWORD)", 503);
  }
  return basicAuth({
    username: c.env.UI_USERNAME || "admin",
    password: c.env.UI_PASSWORD,
  })(c, next);
});

app.get("/", async (c) => {
  const [assets, watched, events] = await Promise.all([
    listAssetsFromEvents(c.env.DB, 50),
    listWatchedAssets(c.env.DB),
    recentEvents(c.env.DB, 20),
  ]);
  const commentsByFile: Record<string, Awaited<ReturnType<typeof commentsForFile>>> = {};
  await Promise.all(
    watched.map(async (w) => {
      commentsByFile[w.file_id] = await commentsForFile(c.env.DB, w.file_id, 20);
    }),
  );
  const webhookUrl = new URL("/webhook", c.req.url).toString();
  const uploadedFileId = c.req.query("uploaded") ?? null;
  return c.html(renderHome({ assets, watched, commentsByFile, events, webhookUrl, uploadedFileId }));
});

app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Frameio-Signature") ?? "";
  const timestamp = c.req.header("X-Frameio-Request-Timestamp") ?? "";
  const secret = c.env.FRAMEIO_SIGNING_SECRET;

  if (!secret) {
    console.error("Missing FRAMEIO_SIGNING_SECRET env var");
    return c.json({ error: "server misconfigured" }, 500);
  }

  const verification = await verifySignature({
    signature,
    timestamp,
    body: rawBody,
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  if (!verification.ok) {
    console.warn("Signature verification failed:", verification.reason);
    return c.json({ error: "invalid signature", reason: verification.reason }, 401);
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  console.log("Frame.io webhook received:", payload.type);
  await recordEvent(c.env.DB, payload as unknown as Record<string, unknown>, rawBody);

  // file.* events carry no metadata in the body — fetch and cache.
  if (isFileEvent(payload.type)) {
    const accountId = payload.account?.id ?? null;
    const fileId = payload.resource?.id ?? payload.file?.id ?? null;
    if (accountId && fileId) {
      await resolveAndCacheFile(c.env, accountId, fileId);
    }
  }

  // Capture comments on watched files. The webhook body doesn't include the
  // comment's parent file — we have to GET the comment from Frame.io to find
  // out which file it belongs to.
  if (payload.type === "comment.created" || payload.type === "comment.updated") {
    const accountId = payload.account?.id ?? null;
    const commentId = payload.resource?.id ?? null;
    if (!accountId || !commentId) {
      console.warn("comment webhook: missing account.id or resource.id; skipping");
    } else if (!c.env.FRAMEIO_TOKEN) {
      console.warn("comment webhook: FRAMEIO_TOKEN not set; cannot resolve parent file");
    } else {
      try {
        const client = new FrameIoClient(c.env);
        const comment = await client.getComment(accountId, commentId);
        const details = extractCommentDetails(comment, payload);
        if (!details.fileId) {
          console.warn(
            "comment webhook: comment record had no parent file id",
            JSON.stringify(comment).slice(0, 1000),
          );
        } else if (await isWatched(c.env.DB, details.fileId)) {
          await insertCapturedComment(c.env.DB, {
            comment_id: commentId,
            file_id: details.fileId,
            parent_id: details.parentId,
            author_name: details.authorName,
            author_email: details.authorEmail,
            text: details.text,
            timecode: details.timecode,
            raw_payload: JSON.stringify({ webhook: payload, comment }),
          });
        } else {
          console.log(
            `comment webhook: file ${details.fileId} not in watched_assets; skipping`,
          );
        }
      } catch (err) {
        console.error("comment webhook: getComment failed:", err);
      }
    }
  }

  return c.json({ ok: true });
});

app.post("/watch/:fileId", async (c) => {
  const fileId = c.req.param("fileId");
  if (!isValidFrameIoId(fileId)) {
    return c.json({ error: "invalid file id" }, 400);
  }
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const action = typeof form.action === "string" ? form.action : "toggle";

  const currentlyWatched = await isWatched(c.env.DB, fileId);

  if (action === "unwatch" || (action === "toggle" && currentlyWatched)) {
    await unwatchAsset(c.env.DB, fileId);
  } else {
    const accountId = idOrNull(form.account_id);
    await watchAsset(c.env.DB, {
      file_id: fileId,
      name: stringOrNull(form.name),
      account_id: accountId,
      workspace_id: idOrNull(form.workspace_id),
      project_id: idOrNull(form.project_id),
    });
    // Backfill existing comments + ensure asset metadata is cached.
    if (accountId) {
      await Promise.all([
        resolveAndCacheFile(c.env, accountId, fileId),
        backfillCommentsForFile(c.env, accountId, fileId).then((r) =>
          console.log(`watch backfill ${fileId}: inserted=${r.inserted} skipped=${r.skipped}${r.error ? " error=" + r.error : ""}`),
        ),
      ]);
    } else {
      console.warn(`watch ${fileId}: no account_id in form; skipping backfill`);
    }
  }

  return c.redirect("/", 303);
});

app.post("/assets/:fileId/versions", (c) => {
  const fileId = c.req.param("fileId");
  if (!isValidFrameIoId(fileId)) {
    return c.json({ error: "invalid file id" }, 400);
  }
  return handleVersionUpload(c, fileId);
});

export default { fetch: app.fetch };

// ---------------------------------------------------------------------------

interface WebhookPayload {
  id?: string;
  type: string;
  account?: { id: string };
  resource?: { id: string; type?: string };
  file?: { id: string };
  user?: { id?: string; name?: string; email?: string };
  comment?: {
    id?: string;
    text?: string;
    parent_id?: string | null;
    file?: { id?: string };
    author?: { id?: string; name?: string; email?: string };
    timecode?: string;
    start_time?: string;
    timestamp?: number;
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Form-posted ids end up in D1 and in Frame.io API URL paths — drop anything
// that isn't shaped like a Frame.io id rather than storing it.
function idOrNull(v: unknown): string | null {
  return typeof v === "string" && isValidFrameIoId(v) ? v : null;
}

function isFileEvent(type: string): boolean {
  // Resolve metadata for any file event except deletion. Trying to GET a
  // deleted file will 404, so we skip — the file_mapping marker handling
  // belongs to a future flow if we add it.
  return (
    type === "file.created" ||
    type === "file.updated" ||
    type === "file.ready" ||
    type === "file.versioned"
  );
}

async function resolveAndCacheFile(env: Env, accountId: string, fileId: string): Promise<void> {
  if (!env.FRAMEIO_TOKEN) {
    console.warn(`file event for ${fileId}: FRAMEIO_TOKEN not set; cannot fetch metadata`);
    return;
  }
  try {
    const client = new FrameIoClient(env);
    const raw = (await client.getFile(accountId, fileId)) as unknown as Record<string, unknown>;
    const extracted = extractFileMetadata(raw, accountId);
    await upsertAsset(env.DB, {
      file_id: fileId,
      name: extracted.name,
      account_id: extracted.accountId ?? accountId,
      workspace_id: extracted.workspaceId,
      project_id: extracted.projectId,
      parent_folder_id: extracted.parentFolderId,
      file_size: extracted.fileSize,
      media_type: extracted.mediaType,
      status: extracted.status,
      view_url: extracted.viewUrl,
      raw: JSON.stringify(raw),
    });
  } catch (err) {
    console.error(`file event for ${fileId}: getFile failed:`, err);
  }
}

interface FileMetadata {
  name: string | null;
  accountId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  parentFolderId: string | null;
  fileSize: number | null;
  mediaType: string | null;
  status: string | null;
  viewUrl: string | null;
}

// V4 "Show file" wraps the record in `data`. workspace_id is not present at
// the file level — only available via the project include parameter — so we
// leave it null unless an event payload already carried it.
function extractFileMetadata(r: Record<string, unknown>, _accountId: string): FileMetadata {
  return {
    name: getString(r, ["data", "name"]) ?? getString(r, ["name"]),
    accountId: getString(r, ["data", "account_id"]) ?? getString(r, ["account_id"]),
    workspaceId: getString(r, ["data", "workspace_id"]) ?? getString(r, ["workspace_id"]),
    projectId: getString(r, ["data", "project_id"]) ?? getString(r, ["project_id"]),
    parentFolderId:
      getString(r, ["data", "parent_id"]) ??
      getString(r, ["data", "parent_folder_id"]) ??
      getString(r, ["parent_id"]),
    fileSize: getNumber(r, ["data", "file_size"]) ?? getNumber(r, ["file_size"]),
    mediaType: getString(r, ["data", "media_type"]) ?? getString(r, ["media_type"]),
    status: getString(r, ["data", "status"]) ?? getString(r, ["status"]),
    viewUrl: getString(r, ["data", "view_url"]) ?? getString(r, ["view_url"]),
  };
}

function getNumber(obj: unknown, path: string[]): number | null {
  const v = getAny(obj, path);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface CommentDetails {
  fileId: string | null;
  parentId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  text: string | null;
  timecode: string | null;
}

// Read a single comment record (unwrapped — i.e. what's inside `data`).
// Used both by the show flow (after unwrapping) and the list-backfill flow
// (where each list item is already the record).
function extractCommentRecord(
  record: Record<string, unknown>,
  webhook?: WebhookPayload,
): CommentDetails & { commentId: string | null } {
  const fileId = getString(record, ["file_id"]);
  const commentId = getString(record, ["id"]);
  const parentId = null;

  const authorName =
    getString(record, ["owner", "name"]) ??
    getString(record, ["author", "name"]) ??
    (webhook ? getString(webhook as unknown as Record<string, unknown>, ["user", "name"]) : null);

  const authorEmail =
    getString(record, ["owner", "email"]) ??
    getString(record, ["author", "email"]) ??
    (webhook ? getString(webhook as unknown as Record<string, unknown>, ["user", "email"]) : null);

  const text = getString(record, ["text"]);

  const tcRaw =
    getAny(record, ["timestamp"]) ??
    getAny(record, ["start_time"]) ??
    getAny(record, ["timecode"]);
  const timecode =
    typeof tcRaw === "string"
      ? tcRaw
      : typeof tcRaw === "number"
        ? String(tcRaw)
        : null;

  return { commentId, fileId, parentId, authorName, authorEmail, text, timecode };
}

// V4 "Show comment" wraps the record in `data`. Unwrap, then delegate.
function extractCommentDetails(
  c: Record<string, unknown>,
  webhook: WebhookPayload,
): CommentDetails {
  const dataField = c["data"];
  const record =
    dataField && typeof dataField === "object" ? (dataField as Record<string, unknown>) : c;
  const { commentId: _ignored, ...details } = extractCommentRecord(record, webhook);
  return details;
}

// Backfill all existing comments for a watched file. Called from the watch
// handler so the panel has content before the user looks at it.
async function backfillCommentsForFile(
  env: Env,
  accountId: string,
  fileId: string,
): Promise<{ inserted: number; skipped: number; error?: string }> {
  if (!env.FRAMEIO_TOKEN) {
    return { inserted: 0, skipped: 0, error: "FRAMEIO_TOKEN not set" };
  }
  try {
    const client = new FrameIoClient(env);
    const records = await client.listFileComments(accountId, fileId);
    let inserted = 0;
    let skipped = 0;
    for (const record of records) {
      const details = extractCommentRecord(record);
      if (!details.commentId) {
        skipped++;
        continue;
      }
      await insertCapturedComment(env.DB, {
        comment_id: details.commentId,
        file_id: details.fileId ?? fileId,
        parent_id: details.parentId,
        author_name: details.authorName,
        author_email: details.authorEmail,
        text: details.text,
        timecode: details.timecode,
        raw_payload: JSON.stringify(record),
      });
      inserted++;
    }
    return { inserted, skipped };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`backfillCommentsForFile(${fileId}) failed:`, detail);
    return { inserted: 0, skipped: 0, error: detail };
  }
}

function getAny(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function getString(obj: unknown, path: string[]): string | null {
  const v = getAny(obj, path);
  return typeof v === "string" && v.length > 0 ? v : null;
}
