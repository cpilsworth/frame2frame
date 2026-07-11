// Adobe IMS OAuth Server-to-Server token exchange.
//
// Frame.io V4 auth (via Adobe IMS) issues short-lived access tokens through
// the `client_credentials` grant. This module fetches one, caches it in
// module scope for the life of the isolate, and transparently refreshes it
// shortly before it expires. See getFrameIoBearer() in client.ts for the
// fallback to a static FRAMEIO_TOKEN when IMS credentials aren't configured.
//
// Docs: https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/

import type { Env } from "../env";

const IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";

const DEFAULT_SCOPES = "openid,AdobeID,read_organizations,frameio_api,offline_access";

// Refresh this long before actual expiry so in-flight requests never race a
// token that expires mid-call.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Module-level cache. Workers reuse the isolate across requests, so this
// avoids a token round-trip per request while still refreshing before expiry.
let cachedToken: CachedToken | null = null;
let inFlightRefresh: Promise<string> | null = null;

interface ImsTokenResponse {
  access_token: string;
  expires_in: number; // seconds
}

// Fetch (or reuse) an Adobe IMS access token for the OAuth Server-to-Server
// (client_credentials) flow. Throws a FrameIoImsError on a non-200 response.
export async function getImsAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > REFRESH_MARGIN_MS) {
    return cachedToken.accessToken;
  }

  // Share one in-flight refresh across concurrent callers so a burst of
  // requests doesn't fire off duplicate token exchanges.
  if (!inFlightRefresh) {
    inFlightRefresh = refreshToken(env).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function refreshToken(env: Env): Promise<string> {
  const clientId = env.IMS_CLIENT_ID;
  const clientSecret = env.IMS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new FrameIoImsError("IMS_CLIENT_ID / IMS_CLIENT_SECRET not set");
  }
  const scope = env.IMS_SCOPES || DEFAULT_SCOPES;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const resp = await fetch(IMS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    // Never include the client secret (or the request body) in the error —
    // only the response, truncated, which Adobe doesn't echo secrets into.
    const text = await resp.text().catch(() => "");
    throw new FrameIoImsError(`IMS token request → ${resp.status} ${text.slice(0, 500)}`);
  }

  const json = (await resp.json()) as ImsTokenResponse;
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new FrameIoImsError("IMS token response missing access_token/expires_in");
  }

  const token: CachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  cachedToken = token;
  return token.accessToken;
}

export class FrameIoImsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameIoImsError";
  }
}
