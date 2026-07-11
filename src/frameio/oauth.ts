// Adobe IMS user-authentication OAuth (authorization code + refresh token).
//
// Used when the Developer Console credential is a "Web App" (user auth) type
// rather than Server-to-Server: the operator connects once via /oauth/login,
// the callback stores the refresh token in D1, and the client mints fresh
// access tokens from it as needed. Tokens act as the signed-in user, so the
// worker sees exactly the Frame.io accounts that user can access.
//
// Docs: https://developer.adobe.com/developer-console/docs/guides/authentication/UserAuthentication/

import type { Env } from "../env";
import { FrameIoImsError } from "./ims";

const IMS_AUTHORIZE_URL = "https://ims-na1.adobelogin.com/ims/authorize/v2";
const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";

// Scopes for the user-auth flow. Must be a subset of what the Developer
// Console credential allows; override with IMS_SCOPES if the console lists
// something different.
const DEFAULT_USER_SCOPES = "openid,AdobeID,email,profile,offline_access,additional_info.roles";

// Refresh this long before actual expiry so in-flight requests never race a
// token that expires mid-call.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface StoredOAuthTokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: number; // epoch ms
}

export function buildAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.IMS_CLIENT_ID ?? "",
    scope: env.IMS_SCOPES || DEFAULT_USER_SCOPES,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `${IMS_AUTHORIZE_URL}?${params.toString()}`;
}

interface ImsGrantResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
}

export async function exchangeAuthCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<StoredOAuthTokens> {
  const json = await tokenGrant(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  if (!json.refresh_token) {
    throw new FrameIoImsError(
      "IMS returned no refresh_token — ensure the credential's scopes include offline_access",
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    access_expires_at: Date.now() + json.expires_in * 1000,
  };
}

async function refreshUserTokens(env: Env, refreshToken: string): Promise<StoredOAuthTokens> {
  const json = await tokenGrant(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    access_token: json.access_token,
    // IMS may rotate the refresh token; keep the old one if it doesn't.
    refresh_token: json.refresh_token ?? refreshToken,
    access_expires_at: Date.now() + json.expires_in * 1000,
  };
}

async function tokenGrant(env: Env, params: Record<string, string>): Promise<ImsGrantResponse> {
  const clientId = env.IMS_CLIENT_ID;
  const clientSecret = env.IMS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new FrameIoImsError("IMS_CLIENT_ID / IMS_CLIENT_SECRET not set");
  }
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });
  const resp = await fetch(IMS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    // Never include the request body in the error — it carries the secret.
    const text = await resp.text().catch(() => "");
    throw new FrameIoImsError(
      `IMS ${params.grant_type} grant → ${resp.status} ${text.slice(0, 500)}`,
    );
  }
  const json = (await resp.json()) as ImsGrantResponse;
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new FrameIoImsError("IMS grant response missing access_token/expires_in");
  }
  return json;
}

// --- D1 persistence (single row, id = 1) -------------------------------------

export async function loadOAuthTokens(db: D1Database): Promise<StoredOAuthTokens | null> {
  return db
    .prepare(`SELECT access_token, refresh_token, access_expires_at FROM oauth_tokens WHERE id = 1`)
    .first<StoredOAuthTokens>();
}

export async function saveOAuthTokens(db: D1Database, t: StoredOAuthTokens): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, access_expires_at, updated_at)
       VALUES (1, ?, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_expires_at = excluded.access_expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(t.access_token, t.refresh_token, t.access_expires_at)
    .run();
}

export async function hasOAuthConnection(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT id FROM oauth_tokens WHERE id = 1`).first<{ id: number }>();
  return row !== null;
}

// --- access-token acquisition -------------------------------------------------

// Module-level cache mirrors ims.ts: reused across requests within an isolate,
// refreshed before expiry, one in-flight refresh shared by concurrent callers.
let cached: { accessToken: string; expiresAt: number } | null = null;
let inFlight: Promise<string | null> | null = null;

// Returns a valid access token from the stored user connection, refreshing it
// via the refresh token when needed. Returns null when no connection has been
// made yet (i.e. the operator never visited /oauth/login). Throws when a
// refresh fails — e.g. the refresh token itself expired — with a hint to
// reconnect.
export async function getUserAccessToken(env: Env): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
    return cached.accessToken;
  }
  if (!inFlight) {
    inFlight = acquire(env).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function acquire(env: Env): Promise<string | null> {
  const row = await loadOAuthTokens(env.DB);
  if (!row) return null;

  if (row.access_expires_at - Date.now() > REFRESH_MARGIN_MS) {
    cached = { accessToken: row.access_token, expiresAt: row.access_expires_at };
    return row.access_token;
  }

  let refreshed: StoredOAuthTokens;
  try {
    refreshed = await refreshUserTokens(env, row.refresh_token);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new FrameIoImsError(
      `user OAuth refresh failed (reconnect via /oauth/login): ${detail}`,
    );
  }
  await saveOAuthTokens(env.DB, refreshed);
  cached = { accessToken: refreshed.access_token, expiresAt: refreshed.access_expires_at };
  return refreshed.access_token;
}
