import { renderToString } from "react-dom/server";
import type { StoredEvent } from "./db";

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

function prettify(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function renderHome(events: StoredEvent[], webhookUrl: string): string {
  const html = renderToString(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Frame.io Webhook Receiver</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script src="https://cdn.twind.style" crossOrigin="anonymous"></script>
      </head>
      <body className="bg-gray-50 text-gray-900 font-sans">
        <main className="max-w-3xl mx-auto p-6 space-y-6">
          <header className="space-y-2">
            <h1 className="text-2xl font-bold">🎬 Frame.io Webhook Receiver</h1>
            <p className="text-gray-600 text-sm">
              A Cloudflare Workers endpoint that verifies and logs incoming Frame.io V4 webhooks.
            </p>
          </header>

          <section className="bg-white border border-gray-200 rounded p-4 space-y-2">
            <h2 className="font-semibold">Webhook URL</h2>
            <code className="block bg-gray-100 p-2 rounded text-sm break-all">{webhookUrl}</code>
            <p className="text-sm text-gray-600">
              Set <code className="bg-gray-100 px-1 rounded">FRAMEIO_SIGNING_SECRET</code> via{" "}
              <code className="bg-gray-100 px-1 rounded">wrangler secret put FRAMEIO_SIGNING_SECRET</code>.
              For local dev, add it to <code className="bg-gray-100 px-1 rounded">.dev.vars</code>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-semibold">Recent events ({events.length})</h2>
            {events.length === 0
              ? <p className="text-sm text-gray-500">No events yet. Trigger an action in Frame.io to see one here.</p>
              : <div className="space-y-2">{events.map((ev) => <EventRow key={ev.id} ev={ev} />)}</div>}
          </section>
        </main>
      </body>
    </html>,
  );
  return "<!doctype html>" + html;
}
