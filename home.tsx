import { renderToString } from "react-dom/server";
import type { StoredEvent } from "./db";
import type { AssetListRow, CapturedComment, WatchedAsset } from "./src/db/queries";

interface HomeProps {
  assets: AssetListRow[];
  watched: WatchedAsset[];
  commentsByFile: Record<string, CapturedComment[]>;
  events: StoredEvent[];
  webhookUrl: string;
  uploadedFileId: string | null;
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

function AssetRow({ a }: { a: AssetListRow }) {
  return (
    <tr className="border-b border-gray-100">
      <td className="font-mono text-xs py-2 pr-3 align-top">{a.file_id}</td>
      <td className="text-sm py-2 pr-3 align-top">{a.name ?? <span className="text-gray-400">(unknown)</span>}</td>
      <td className="font-mono text-xs py-2 pr-3 align-top">{a.last_event_type}</td>
      <td className="text-xs text-gray-500 py-2 pr-3 align-top whitespace-nowrap">{a.last_event_at}Z</td>
      <td className="py-2 align-top">
        <form method="POST" action={`/watch/${encodeURIComponent(a.file_id)}`} className="inline">
          <input type="hidden" name="action" value={a.is_watched ? "unwatch" : "watch"} />
          <input type="hidden" name="name" value={a.name ?? ""} />
          <input type="hidden" name="account_id" value={a.account_id ?? ""} />
          <input type="hidden" name="workspace_id" value={a.workspace_id ?? ""} />
          <input type="hidden" name="project_id" value={a.project_id ?? ""} />
          <button
            type="submit"
            className={
              "text-xs font-semibold rounded px-3 py-1 " +
              (a.is_watched
                ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                : "bg-blue-600 text-white hover:bg-blue-700")
            }
          >
            {a.is_watched ? "Unwatch" : "Watch"}
          </button>
        </form>
      </td>
    </tr>
  );
}

function WatchedPanel({
  w,
  comments,
  justUploaded,
}: {
  w: WatchedAsset;
  comments: CapturedComment[];
  justUploaded: boolean;
}) {
  return (
    <article className="bg-white border border-gray-200 rounded p-4 space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            <a
              href={frameIoAssetUrl(w)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 hover:underline"
            >
              {w.name ?? "(unnamed asset)"} ↗
            </a>
          </h3>
          <p className="font-mono text-xs text-gray-500">{w.file_id}</p>
        </div>
        <form method="POST" action={`/watch/${encodeURIComponent(w.file_id)}`}>
          <input type="hidden" name="action" value="unwatch" />
          <button
            type="submit"
            className="text-xs font-semibold rounded px-3 py-1 bg-amber-100 text-amber-800 hover:bg-amber-200"
          >
            Unwatch
          </button>
        </form>
      </header>

      {justUploaded
        ? (
          <p className="text-xs bg-green-50 text-green-800 rounded p-2 border border-green-200">
            ✅ New version submitted.
          </p>
        )
        : null}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Upload new version</h4>
        <form
          method="POST"
          action={`/assets/${encodeURIComponent(w.file_id)}/versions`}
          encType="multipart/form-data"
          className="flex items-center gap-2"
        >
          <input
            type="file"
            name="file"
            required
            className="text-xs flex-1 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
          />
          <button
            type="submit"
            className="text-xs font-semibold rounded px-3 py-1 bg-blue-600 text-white hover:bg-blue-700"
          >
            Upload
          </button>
        </form>
        <p className="text-xs text-gray-500">
          Cloudflare Workers cap request bodies at ~100 MB. Larger video deliverables
          will need a direct-to-Frame.io upload path (not yet wired).
        </p>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Comments ({comments.length})</h4>
        {comments.length === 0
          ? <p className="text-xs text-gray-500">No comments captured yet.</p>
          : (
            <ul className="space-y-2">
              {comments.map((c) => (
                <li key={c.comment_id} className="border border-gray-100 rounded p-2 bg-gray-50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold">
                      {c.author_name ?? c.author_email ?? "(unknown author)"}
                    </span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">{c.received_at}Z</span>
                  </div>
                  {c.timecode
                    ? <p className="text-xs font-mono text-gray-500">@ {c.timecode}</p>
                    : null}
                  <p className="text-sm mt-1 whitespace-pre-wrap">{c.text ?? <em>(no text)</em>}</p>
                </li>
              ))}
            </ul>
          )}
      </section>
    </article>
  );
}

function EventRow({ ev }: { ev: StoredEvent }) {
  const subtitle = [ev.resource_type, ev.resource_id].filter(Boolean).join(" ");
  return (
    <details className="border border-gray-200 rounded p-3 bg-white">
      <summary className="cursor-pointer flex justify-between items-center gap-4">
        <span className="font-mono text-sm font-semibold">{ev.event_type}</span>
        <span className="text-xs text-gray-500 font-mono truncate">{subtitle}</span>
        <span className="text-xs text-gray-400 ml-auto whitespace-nowrap">{ev.received_at}Z</span>
      </summary>
      <pre className="mt-3 p-3 bg-gray-50 rounded text-xs overflow-x-auto">{prettify(ev.payload)}</pre>
    </details>
  );
}

export function renderHome(props: HomeProps): string {
  const { assets, watched, commentsByFile, events, webhookUrl, uploadedFileId } = props;
  const html = renderToString(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Frame.io Asset Watch</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script src="https://cdn.twind.style" crossOrigin="anonymous"></script>
      </head>
      <body className="bg-gray-50 text-gray-900 font-sans">
        <main className="max-w-5xl mx-auto p-6 space-y-6">
          <header className="space-y-2">
            <h1 className="text-2xl font-bold">🎬 Frame.io Asset Watch</h1>
            <p className="text-gray-600 text-sm">
              Webhook URL:{" "}
              <code className="bg-gray-100 px-1 py-0.5 rounded break-all">{webhookUrl}</code>
            </p>
          </header>

          <section className="space-y-3">
            <h2 className="font-semibold">Watched assets ({watched.length})</h2>
            {watched.length === 0
              ? (
                <p className="text-sm text-gray-500">
                  No assets watched yet. Pick one from the Assets section below.
                </p>
              )
              : (
                <div className="space-y-4">
                  {watched.map((w) => (
                    <WatchedPanel
                      key={w.file_id}
                      w={w}
                      comments={commentsByFile[w.file_id] ?? []}
                      justUploaded={uploadedFileId === w.file_id}
                    />
                  ))}
                </div>
              )}
          </section>

          <section className="bg-white border border-gray-200 rounded p-4 space-y-3">
            <h2 className="font-semibold">Assets seen via webhook ({assets.length})</h2>
            {assets.length === 0
              ? (
                <p className="text-sm text-gray-500">
                  No file events received yet. Trigger an action in Frame.io to populate this list.
                </p>
              )
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-gray-200 text-xs text-gray-500">
                        <th className="py-2 pr-3">file_id</th>
                        <th className="py-2 pr-3">name</th>
                        <th className="py-2 pr-3">last event</th>
                        <th className="py-2 pr-3">at</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {assets.map((a) => <AssetRow key={a.file_id} a={a} />)}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          <section className="space-y-3">
            <h2 className="font-semibold">Recent webhook events ({events.length})</h2>
            {events.length === 0
              ? <p className="text-sm text-gray-500">No events received yet.</p>
              : <div className="space-y-2">{events.map((ev) => <EventRow key={ev.id} ev={ev} />)}</div>}
          </section>
        </main>
      </body>
    </html>,
  );
  return "<!doctype html>" + html;
}
