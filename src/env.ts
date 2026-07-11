// Worker bindings.

export interface Env {
  DB: D1Database;

  // Frame.io webhook signing secret (configured on the Frame.io webhook).
  FRAMEIO_SIGNING_SECRET: string;

  // Frame.io developer / personal access token. Used as a `Bearer` on V4 API
  // calls (uploads, version creation). Set via `wrangler secret put`.
  // Fallback when IMS_CLIENT_ID / IMS_CLIENT_SECRET aren't set.
  FRAMEIO_TOKEN: string;

  // Adobe IMS OAuth Server-to-Server credential (recommended over
  // FRAMEIO_TOKEN — long-lived, auto-refreshing). Both must be set to use
  // this flow; see src/frameio/ims.ts. Set via `wrangler secret put`.
  IMS_CLIENT_ID?: string;
  IMS_CLIENT_SECRET?: string;

  // Comma-separated IMS scopes for the token exchange. Optional — defaults
  // to "openid,AdobeID,read_organizations,frameio_api,offline_access".
  IMS_SCOPES?: string;

  // Basic-auth credentials for the browser UI (every route except /webhook).
  // The UI fails closed (503) until UI_PASSWORD is set. Username defaults to
  // "admin" when UI_USERNAME is unset.
  UI_USERNAME?: string;
  UI_PASSWORD?: string;
}
