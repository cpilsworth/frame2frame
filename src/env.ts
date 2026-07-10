// Worker bindings.

export interface Env {
  DB: D1Database;

  // Frame.io webhook signing secret (configured on the Frame.io webhook).
  FRAMEIO_SIGNING_SECRET: string;

  // Frame.io developer / personal access token. Used as a `Bearer` on V4 API
  // calls (uploads, version creation). Set via `wrangler secret put`.
  FRAMEIO_TOKEN: string;

  // Basic-auth credentials for the browser UI (every route except /webhook).
  // The UI fails closed (503) until UI_PASSWORD is set. Username defaults to
  // "admin" when UI_USERNAME is unset.
  UI_USERNAME?: string;
  UI_PASSWORD?: string;
}
