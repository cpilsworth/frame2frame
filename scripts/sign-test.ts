// Compute a valid Frame.io-style signature for a test payload.
// Run with: bun scripts/sign-test.ts
// Or: node --env-file=.dev.vars scripts/sign-test.ts  (Node 20.6+)
//
// Requires FRAMEIO_SIGNING_SECRET in the environment or .dev.vars file.

const secret = process.env.FRAMEIO_SIGNING_SECRET;
if (!secret) throw new Error("Set FRAMEIO_SIGNING_SECRET (e.g. in .dev.vars)");

const timestamp = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({
  account: { id: "acct-123" },
  workspace: { id: "ws-123" },
  project: { id: "proj-123" },
  user: { id: "user-123" },
  resource: { id: "file-abc", type: "file" },
  type: "file.ready",
});

const enc = new TextEncoder();
const key = await crypto.subtle.importKey(
  "raw",
  enc.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`));
const sigHex = [...new Uint8Array(sigBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

console.log("timestamp:", timestamp);
console.log("signature:", `v0=${sigHex}`);
console.log("body:", body);
