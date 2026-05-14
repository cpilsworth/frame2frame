// Worker bindings.

export interface Env {
  DB: D1Database;

  // Frame.io webhook signing secret (configured on the Frame.io webhook).
  FRAMEIO_SIGNING_SECRET: string;

  // Frame.io developer / personal access token. Used as a `Bearer` on V4 API
  // calls (uploads, version creation). Set via `wrangler secret put`.
  FRAMEIO_TOKEN: string;
}
