import { describe, expect, it } from "vitest";
import { isValidFrameIoId } from "../src/frameio/client";

describe("isValidFrameIoId", () => {
  it("accepts a UUID", () => {
    expect(isValidFrameIoId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts plain alphanumerics", () => {
    expect(isValidFrameIoId("abc123XYZ")).toBe(true);
  });

  it("accepts dashes and underscores", () => {
    expect(isValidFrameIoId("file-abc_123")).toBe(true);
  });

  it("accepts a 64-char string", () => {
    expect(isValidFrameIoId("a".repeat(64))).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidFrameIoId("")).toBe(false);
  });

  it("rejects '..'", () => {
    expect(isValidFrameIoId("..")).toBe(false);
  });

  it("rejects anything containing a slash", () => {
    expect(isValidFrameIoId("abc/def")).toBe(false);
    expect(isValidFrameIoId("../../etc/passwd")).toBe(false);
  });

  it("rejects a percent-escape", () => {
    expect(isValidFrameIoId("%2f")).toBe(false);
    expect(isValidFrameIoId("abc%2fdef")).toBe(false);
  });

  it("rejects a dot", () => {
    expect(isValidFrameIoId(".")).toBe(false);
    expect(isValidFrameIoId("abc.def")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidFrameIoId("abc def")).toBe(false);
    expect(isValidFrameIoId(" abc")).toBe(false);
    expect(isValidFrameIoId("abc ")).toBe(false);
  });

  it("rejects a 65-char string", () => {
    expect(isValidFrameIoId("a".repeat(65))).toBe(false);
  });
});
