// Frame.io V4 webhook handler
// Docs: https://next.developer.frame.io/platform/docs/guides/webhooks
import { Hono } from "hono";
import { verifySignature } from "./verify";
import { recordEvent, recentEvents } from "./db";
import { renderHome } from "./home";

export interface Env {
  DB: D1Database;
  FRAMEIO_SIGNING_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const events = await recentEvents(c.env.DB, 20);
  const webhookUrl = new URL("/webhook", c.req.url).toString();
  return c.html(renderHome(events, webhookUrl));
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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  console.log("Frame.io webhook received:", payload.type, payload);
  await recordEvent(c.env.DB, payload, rawBody);

  // Route based on event type — extend this switch with your business logic.
  switch (payload.type) {
    case "file.ready":
      // e.g. sync to DAM, notify Slack, etc.
      break;
    case "comment.created":
      // e.g. forward to ticketing system
      break;
    default:
      break;
  }

  return c.json({ ok: true });
});

export default app;
