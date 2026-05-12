// HMAC SHA256 signature verification for Frame.io V4 webhooks.
// Reference: https://next.developer.frame.io/platform/docs/guides/webhooks#verifying-webhook-signatures
//
// Frame.io sends two headers with every delivery:
//   X-Frameio-Request-Timestamp: unix epoch seconds
//   X-Frameio-Signature:         "v0=<hex hmac sha256>"
// The signed message is `v0:<timestamp>:<raw request body>` and is signed
// with the webhook's signing secret (returned only at webhook creation time).

export interface VerifyArgs {
  signature: string;
  timestamp: string;
  body: string;
  secret: string;
  /** Current time in unix seconds. Pass it in to make the function testable. */
  nowSeconds: number;
  /** Maximum allowed skew between Frame.io's timestamp and now. Defaults to 5 minutes. */
  toleranceSeconds?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing-header" | "stale-timestamp" | "bad-format" | "mismatch" };

export async function verifySignature(args: VerifyArgs): Promise<VerifyResult> {
  const { signature, timestamp, body, secret, nowSeconds, toleranceSeconds = 300 } = args;

  if (!signature || !timestamp) return { ok: false, reason: "missing-header" };

  const reqTime = Number(timestamp);
  if (!Number.isFinite(reqTime)) return { ok: false, reason: "bad-format" };
  if (Math.abs(nowSeconds - reqTime) > toleranceSeconds) {
    return { ok: false, reason: "stale-timestamp" };
  }

  if (!signature.startsWith("v0=")) return { ok: false, reason: "bad-format" };
  const providedHex = signature.slice(3);

  const expectedHex = await hmacSha256Hex(secret, `v0:${timestamp}:${body}`);

  // Constant-time comparison
  if (providedHex.length !== expectedHex.length) return { ok: false, reason: "mismatch" };
  let diff = 0;
  for (let i = 0; i < providedHex.length; i++) {
    diff |= providedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "mismatch" };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
