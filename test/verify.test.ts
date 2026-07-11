import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../verify";

const SECRET = "test-signing-secret";

/** Compute a real `v0=<hex>` signature the same way Frame.io does. */
function sign(secret: string, timestamp: string, body: string): string {
  const hex = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${hex}`;
}

describe("verifySignature", () => {
  it("accepts a valid signature", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const body = JSON.stringify({ type: "file.ready" });
    const signature = sign(SECRET, timestamp, body);

    const result = await verifySignature({ signature, timestamp, body, secret: SECRET, nowSeconds });

    expect(result).toEqual({ ok: true });
  });

  it("rejects a missing signature header", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const body = "{}";

    const result = await verifySignature({
      signature: "",
      timestamp,
      body,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "missing-header" });
  });

  it("rejects a missing timestamp header", async () => {
    const nowSeconds = 1_700_000_000;
    const body = "{}";
    const signature = sign(SECRET, "1700000000", body);

    const result = await verifySignature({
      signature,
      timestamp: "",
      body,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "missing-header" });
  });

  it("rejects a non-numeric timestamp as bad-format", async () => {
    const nowSeconds = 1_700_000_000;
    const body = "{}";
    const signature = sign(SECRET, "not-a-number", body);

    const result = await verifySignature({
      signature,
      timestamp: "not-a-number",
      body,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "bad-format" });
  });

  it("rejects a timestamp older than the tolerance window", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds - 301); // default tolerance is 300s
    const body = "{}";
    const signature = sign(SECRET, timestamp, body);

    const result = await verifySignature({ signature, timestamp, body, secret: SECRET, nowSeconds });

    expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("accepts a timestamp just inside the tolerance window", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds - 300); // exactly at the boundary, still allowed
    const body = "{}";
    const signature = sign(SECRET, timestamp, body);

    const result = await verifySignature({ signature, timestamp, body, secret: SECRET, nowSeconds });

    expect(result).toEqual({ ok: true });
  });

  it("rejects a future timestamp beyond the tolerance window", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds + 301);
    const body = "{}";
    const signature = sign(SECRET, timestamp, body);

    const result = await verifySignature({ signature, timestamp, body, secret: SECRET, nowSeconds });

    expect(result).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a signature missing the v0= prefix as bad-format", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const body = "{}";
    const hex = createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex");

    const result = await verifySignature({
      signature: hex, // missing "v0=" prefix
      timestamp,
      body,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "bad-format" });
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const body = "{}";
    const signature = sign("some-other-secret", timestamp, body);

    const result = await verifySignature({ signature, timestamp, body, secret: SECRET, nowSeconds });

    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when the body has been tampered with after signing", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const originalBody = JSON.stringify({ amount: 1 });
    const signature = sign(SECRET, timestamp, originalBody);
    const tamperedBody = JSON.stringify({ amount: 1000 });

    const result = await verifySignature({
      signature,
      timestamp,
      body: tamperedBody,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a provided hex of the wrong length", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds);
    const body = "{}";

    const result = await verifySignature({
      signature: "v0=abcd", // far shorter than a real sha256 hex digest
      timestamp,
      body,
      secret: SECRET,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: "mismatch" });
  });

  it("honors a custom toleranceSeconds", async () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds - 30);
    const body = "{}";
    const signature = sign(SECRET, timestamp, body);

    const tooStrict = await verifySignature({
      signature,
      timestamp,
      body,
      secret: SECRET,
      nowSeconds,
      toleranceSeconds: 10,
    });
    expect(tooStrict).toEqual({ ok: false, reason: "stale-timestamp" });

    const lenient = await verifySignature({
      signature,
      timestamp,
      body,
      secret: SECRET,
      nowSeconds,
      toleranceSeconds: 60,
    });
    expect(lenient).toEqual({ ok: true });
  });
});
