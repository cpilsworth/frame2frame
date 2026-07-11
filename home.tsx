import { renderToString } from "react-dom/server";
import type { StoredEvent } from "./db";
import type { AssetListRow, CapturedComment, WatchedAsset } from "./src/db/queries";

// Another agent adds these columns + POST /watch/:fileId/refresh. Until then
// they're just absent (undefined) and the status line renders nothing.
type WatchedAssetView = WatchedAsset & {
  last_backfill_at?: string | null;
  last_backfill_error?: string | null;
};

interface HomeProps {
  assets: AssetListRow[];
  watched: WatchedAssetView[];
  commentsByFile: Record<string, CapturedComment[]>;
  events: StoredEvent[];
  webhookUrl: string;
  uploadedFileId: string | null;
  uploadStackFailed: boolean;
}

function prettify(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// Prefer the authoritative `view_url` from the Frame.io file record (cached
// in the `assets` table). Fall back to a constructed URL when the file
// metadata hasn't been resolved yet. Only https URLs are rendered as links —
// the value comes from an API response, not our own code.
function frameIoAssetUrl(w: {
  file_id: string;
  project_id: string | null;
  view_url: string | null;
}): string {
  if (w.view_url && w.view_url.startsWith("https://")) return w.view_url;
  if (w.project_id) {
    return `https://next.frame.io/project/${encodeURIComponent(w.project_id)}/view/${encodeURIComponent(w.file_id)}`;
  }
  return `https://next.frame.io/`;
}

// SWC has no initials avatar (sp-avatar renders an <img>), so we hand a small
// SVG data URI to sp-avatar. img-src in the CSP allows data: for exactly this.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters =
    parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0];
  const cleaned = letters.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return cleaned || "?";
}

function avatarDataUri(name: string): string {
  const text = initials(name);
  let hue = 0;
  for (let i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">` +
    `<rect width="36" height="36" rx="18" fill="hsl(${hue},42%,52%)"/>` +
    `<text x="18" y="18" dy="0.35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#fff">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function AssetRow({ a }: { a: AssetListRow }) {
  return (
    <tr>
      <td className="mono small top">{a.file_id}</td>
      <td className="top">{a.name ?? <span className="muted">(unknown)</span>}</td>
      <td className="mono small top">{a.last_event_type}</td>
      <td className="muted small top nowrap">{a.last_event_at}Z</td>
      <td className="top">
        {/* Enhanced into an sp-switch by app.js; the <noscript> button keeps it
            working without JS. The server toggles based on current state. */}
        <form
          method="POST"
          action={`/watch/${encodeURIComponent(a.file_id)}`}
          data-enhance="toggle"
          className="watch-form"
        >
          <input type="hidden" name="action" value="toggle" />
          <input type="hidden" name="name" value={a.name ?? ""} />
          <input type="hidden" name="account_id" value={a.account_id ?? ""} />
          <input type="hidden" name="workspace_id" value={a.workspace_id ?? ""} />
          <input type="hidden" name="project_id" value={a.project_id ?? ""} />
          <sp-switch size="s" checked={a.is_watched ? "" : undefined}>
            {a.is_watched ? "Watched" : "Watch"}
          </sp-switch>
          <noscript>
            <button type="submit" className="fallback-btn">
              {a.is_watched ? "Unwatch" : "Watch"}
            </button>
          </noscript>
        </form>
      </td>
    </tr>
  );
}

function CommentItem({ c }: { c: CapturedComment }) {
  const author = c.author_name ?? c.author_email ?? "(unknown author)";
  return (
    <li className="comment">
      <sp-avatar label={author} src={avatarDataUri(author)} size="50" class="comment-avatar" />
      <div className="comment-body">
        <div className="comment-head">
          <span className="small strong">{author}</span>
          <span className="muted small nowrap">{c.received_at}Z</span>
        </div>
        {c.timecode ? <p className="mono small muted">@ {c.timecode}</p> : null}
        <p className="comment-text">{c.text ?? <em>(no text)</em>}</p>
      </div>
    </li>
  );
}

function WatchedPanel({
  w,
  comments,
  justUploaded,
  stackFailed,
}: {
  w: WatchedAssetView;
  comments: CapturedComment[];
  justUploaded: boolean;
  stackFailed: boolean;
}) {
  return (
    <article className="card panel">
      <header className="panel-head">
        <div>
          <h3 className="panel-title">
            <a href={frameIoAssetUrl(w)} target="_blank" rel="noopener noreferrer" className="link">
              {w.name ?? "(unnamed asset)"} ↗
            </a>
          </h3>
          <p className="mono small muted">{w.file_id}</p>
        </div>
        <form method="POST" action={`/watch/${encodeURIComponent(w.file_id)}`}>
          <input type="hidden" name="action" value="unwatch" />
          <sp-action-button size="s" quiet="" data-submit="">
            Unwatch
          </sp-action-button>
          <noscript>
            <button type="submit" className="fallback-btn">
              Unwatch
            </button>
          </noscript>
        </form>
      </header>

      {justUploaded
        ? stackFailed
          ? (
            <sp-toast open="" variant="negative">
              New version uploaded, but stacking it as a version failed.
            </sp-toast>
          )
          : (
            <sp-toast open="" variant="positive">
              New version submitted.
            </sp-toast>
          )
        : null}

      <section className="stack">
        <div className="row-between">
          <h4 className="subhead">Comments ({comments.length})</h4>
          {/* Task 6 integration: route 404s until the other agent lands it. */}
          <form method="POST" action={`/watch/${encodeURIComponent(w.file_id)}/refresh`}>
            <sp-action-button size="s" quiet="" data-submit="">
              Refresh comments
            </sp-action-button>
            <noscript>
              <button type="submit" className="fallback-btn">
                Refresh comments
              </button>
            </noscript>
          </form>
        </div>
        {w.last_backfill_error
          ? <p className="status-warn small">Last refresh failed: {w.last_backfill_error}</p>
          : w.last_backfill_at
            ? <p className="muted small">Last refreshed {w.last_backfill_at}Z</p>
            : null}
        {comments.length === 0
          ? <p className="muted small">No comments captured yet.</p>
          : (
            <ul className="comment-list">
              {comments.map((c) => <CommentItem key={c.comment_id} c={c} />)}
            </ul>
          )}
      </section>

      <section className="stack">
        <h4 className="subhead">Upload new version</h4>
        {/* Without JS this posts multipart to the worker, which proxies the
            upload (~100 MB body cap). app.js intercepts it and uploads chunks
            straight to Frame.io's presigned URLs instead, falling back to this
            same POST if the browser is blocked by S3 CORS. */}
        <form
          method="POST"
          action={`/assets/${encodeURIComponent(w.file_id)}/versions`}
          encType="multipart/form-data"
          data-upload=""
          data-file-id={w.file_id}
          className="upload-form"
        >
          <sp-dropzone className="dropzone">
            <div className="dropzone-inner">
              <span className="muted small">Drag a file here or</span>
              <input type="file" name="file" required className="file-input" />
              <span className="mono small" data-file-name></span>
            </div>
          </sp-dropzone>
          <sp-progress-bar className="upload-progress" label="Uploading…" progress="0" hidden={true} />
          <div className="upload-actions">
            <sp-button type="submit" variant="accent" size="s" data-upload-submit="">
              Upload new version
            </sp-button>
            <noscript>
              <button type="submit" className="fallback-btn">
                Upload new version
              </button>
            </noscript>
          </div>
        </form>
      </section>
    </article>
  );
}

export function renderHome(props: HomeProps): string {
  const { assets, watched, commentsByFile, events, webhookUrl, uploadedFileId, uploadStackFailed } =
    props;
  const html = renderToString(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Frame.io Asset Watch</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: LAYOUT_CSS }} />
        <script type="module" src="/app.js"></script>
      </head>
      <body>
        <sp-theme system="spectrum-two" color="light" scale="medium">
          <main className="container">
            <header className="stack">
              <h1 className="title">🎬 Frame.io Asset Watch</h1>
              <p className="muted small">
                Webhook URL: <code className="code">{webhookUrl}</code>
              </p>
            </header>

            <section className="stack">
              <h2 className="section-title">Watched assets ({watched.length})</h2>
              {watched.length === 0
                ? (
                  <p className="muted small">
                    No assets watched yet. Pick one from the Assets section below.
                  </p>
                )
                : (
                  <div className="panels">
                    {watched.map((w) => (
                      <WatchedPanel
                        key={w.file_id}
                        w={w}
                        comments={commentsByFile[w.file_id] ?? []}
                        justUploaded={uploadedFileId === w.file_id}
                        stackFailed={uploadStackFailed}
                      />
                    ))}
                  </div>
                )}
            </section>

            <section className="card">
              <h2 className="section-title">Assets seen via webhook ({assets.length})</h2>
              {assets.length === 0
                ? (
                  <p className="muted small">
                    No file events received yet. Trigger an action in Frame.io to populate this list.
                  </p>
                )
                : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>file_id</th>
                          <th>name</th>
                          <th>last event</th>
                          <th>at</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>{assets.map((a) => <AssetRow key={a.file_id} a={a} />)}</tbody>
                    </table>
                  </div>
                )}
            </section>

            <section className="stack">
              <h2 className="section-title">Recent webhook events ({events.length})</h2>
              {events.length === 0
                ? <p className="muted small">No events received yet.</p>
                : (
                  <sp-accordion allow-multiple="" size="s">
                    {events.map((ev) => {
                      const subtitle = [ev.resource_type, ev.resource_id].filter(Boolean).join(" ");
                      const label = [ev.event_type, subtitle, `${ev.received_at}Z`]
                        .filter(Boolean)
                        .join("  ·  ");
                      return (
                        <sp-accordion-item key={ev.id} label={label}>
                          <pre className="raw-json">{prettify(ev.payload)}</pre>
                        </sp-accordion-item>
                      );
                    })}
                  </sp-accordion>
                )}
            </section>
          </main>
        </sp-theme>
      </body>
    </html>,
  );
  return "<!doctype html>" + html;
}

// Hand-written layout-only CSS. Spectrum components carry their own theming;
// this styles the page chrome (cards, tables, spacing) and swaps a small set
// of neutral tokens on prefers-color-scheme so the layout matches light/dark.
const LAYOUT_CSS = `
:root {
  --page-bg:#f4f4f4; --card-bg:#ffffff; --border:#e2e2e2; --muted:#6b6b6b;
  --text:#1a1a1a; --code-bg:#eaeaea; --warn:#9a6b00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page-bg:#1c1c1c; --card-bg:#262626; --border:#3a3a3a; --muted:#a3a3a3;
    --text:#ededed; --code-bg:#333333; --warn:#e0b02a;
  }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--page-bg); color:var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
sp-theme { display:block; background:var(--page-bg); min-height:100vh; }
.container { max-width:64rem; margin:0 auto; padding:1.5rem; display:flex;
  flex-direction:column; gap:1.5rem; }
.stack { display:flex; flex-direction:column; gap:.75rem; }
.title { font-size:1.5rem; font-weight:700; margin:0; }
.section-title { font-size:1.05rem; font-weight:600; margin:0; }
.subhead { font-size:.9rem; font-weight:600; margin:0; }
.small { font-size:.78rem; }
.muted { color:var(--muted); }
.strong { font-weight:600; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.nowrap { white-space:nowrap; }
.top { vertical-align:top; }
.link { color:#2563eb; text-decoration:none; }
.link:hover { text-decoration:underline; }
@media (prefers-color-scheme: dark) { .link { color:#6ea8fe; } }
.code { background:var(--code-bg); padding:.1rem .35rem; border-radius:4px;
  word-break:break-all; font-family: ui-monospace, Menlo, monospace; font-size:.78rem; }
.card { background:var(--card-bg); border:1px solid var(--border); border-radius:8px;
  padding:1rem; display:flex; flex-direction:column; gap:.75rem; }
.panels { display:flex; flex-direction:column; gap:1rem; }
.panel-head { display:flex; align-items:baseline; justify-content:space-between; gap:.75rem; }
.panel-title { font-weight:600; margin:0; font-size:1rem; }
.row-between { display:flex; align-items:center; justify-content:space-between; gap:.75rem; }
.table-scroll { overflow-x:auto; }
.data-table { width:100%; border-collapse:collapse; text-align:left; }
.data-table th { font-size:.72rem; color:var(--muted); font-weight:600;
  border-bottom:1px solid var(--border); padding:.5rem .75rem .5rem 0; }
.data-table td { padding:.5rem .75rem .5rem 0; border-bottom:1px solid var(--border); font-size:.85rem; }
.watch-form { display:flex; align-items:center; gap:.5rem; }
.comment-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.6rem; }
.comment { display:flex; gap:.6rem; align-items:flex-start; border:1px solid var(--border);
  border-radius:6px; padding:.6rem; }
.comment-avatar { flex:0 0 auto; }
.comment-body { flex:1 1 auto; min-width:0; }
.comment-head { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; }
.comment-text { font-size:.85rem; margin:.25rem 0 0; white-space:pre-wrap; word-break:break-word; }
.dropzone { display:block; }
.dropzone-inner { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; padding:.5rem; }
.file-input { font-size:.8rem; }
.upload-actions { display:flex; align-items:center; gap:.5rem; }
.upload-progress { display:block; max-width:22rem; }
/* keep the [hidden] attribute winning over the display:block above so the bar
   only appears once app.js reveals it during an upload */
.upload-progress[hidden] { display:none; }
.status-warn { color:var(--warn); }
.raw-json { margin:0; padding:.75rem; background:var(--code-bg); border-radius:6px;
  font-size:.75rem; overflow-x:auto; }
.fallback-btn { font-size:.78rem; font-weight:600; padding:.3rem .7rem; border-radius:6px;
  border:1px solid var(--border); background:var(--card-bg); color:var(--text); cursor:pointer; }
#toast-region { position:fixed; left:50%; bottom:1.25rem; transform:translateX(-50%);
  display:flex; flex-direction:column; gap:.5rem; z-index:1000; }
/* Interactive Spectrum controls that have <noscript> fallbacks: hide them
   until they upgrade so there's no flash and no dead widget without JS. */
sp-switch:not(:defined), sp-action-button:not(:defined), sp-button:not(:defined),
sp-dropzone:not(:defined), sp-progress-bar:not(:defined) { display:none !important; }
`;
