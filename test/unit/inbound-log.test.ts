import { describe, expect, it } from "vitest";
import {
  buildInboundLogEvent,
  formatInboundBodyBytes,
  inboundBodyBytes,
  inboundHasQuery,
  sanitizeHttpMethod,
  sanitizeInboundPath,
  sanitizeInboundRequestId,
  sanitizeInboundStatus
} from "../../src/inbound-log";

describe("inbound request log helpers", () => {
  it("strips query strings and fragments so OAuth codes and tokens are not stored", () => {
    expect(sanitizeInboundPath("/api/hooks/payment?code=one-time&state=secret")).toBe(
      "/api/hooks/payment"
    );
    expect(sanitizeInboundPath("/oauth/callback#access_token=abc")).toBe("/oauth/callback");
    expect(sanitizeInboundPath("api/hooks")).toBe("/api/hooks");
    expect(sanitizeInboundPath("/path\nX-Injected: 1")).toBe("/");
    expect(sanitizeInboundPath("")).toBe("/");
    expect(sanitizeInboundPath(`/${"a".repeat(300)}`).length).toBe(256);
  });

  it("records that a query string existed without keeping its values", () => {
    expect(inboundHasQuery("?code=one-time&state=secret")).toBe(true);
    expect(inboundHasQuery("")).toBe(false);
    expect(inboundHasQuery("?")).toBe(false);
  });

  it("keeps plausible HTTP methods and status codes", () => {
    expect(sanitizeHttpMethod("post")).toBe("POST");
    expect(sanitizeHttpMethod("GET\nHost: evil")).toBe("UNKNOWN");
    expect(sanitizeInboundStatus(202)).toBe(202);
    expect(sanitizeInboundStatus(99)).toBe(0);
    expect(sanitizeInboundStatus(900)).toBe(0);
  });

  it("accepts router request ids and drops anything else", () => {
    expect(sanitizeInboundRequestId("req_abc123def456")).toBe("req_abc123def456");
    expect(sanitizeInboundRequestId("req_abc\nInjected")).toBe("req_invalid");
    expect(sanitizeInboundRequestId("not-a-request-id")).toBe("req_invalid");
  });

  it("reads body length from the buffer or a numeric Content-Length header", () => {
    const encoded = new TextEncoder().encode('{"ok":true}');
    const body = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    expect(inboundBodyBytes(new Request("https://example.com"), body)).toBe(11);
    expect(
      inboundBodyBytes(
        new Request("https://example.com", { headers: { "Content-Length": "2048" } })
      )
    ).toBe(2048);
    expect(
      inboundBodyBytes(
        new Request("https://example.com", { headers: { "Content-Length": "nope" } })
      )
    ).toBe(0);
  });

  it("builds metadata that excludes query values, headers, and payload text", () => {
    const event = buildInboundLogEvent({
      id: "req_abc123def456",
      method: "POST",
      routeId: "nomads",
      remainingPath: "/api/hooks/payment?id=secret-customer",
      search: "?id=secret-customer&token=super-secret",
      kind: "webhook",
      result: "accepted",
      status: 202,
      subscriberCount: 2,
      bodyBytes: 2048
    });
    expect(event.path).toBe("/api/hooks/payment");
    expect(event.hasQuery).toBe(true);
    expect(event.routeId).toBe("nomads");
    expect(JSON.stringify(event)).not.toContain("secret-customer");
    expect(JSON.stringify(event)).not.toContain("super-secret");
    expect(formatInboundBodyBytes(event.bodyBytes)).toBe("2.0 KB");
  });

  it("drops unknown error codes rather than storing free-form messages", () => {
    const event = buildInboundLogEvent({
      id: "req_abc123def456",
      method: "GET",
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      kind: "oauth",
      result: "rejected",
      status: 409,
      error: "OAuth failed: code=one-time",
      subscriberCount: 2,
      bodyBytes: 0
    });
    expect(event.error).toBeNull();
    expect(event.kind).toBe("oauth");
    expect(JSON.stringify(event)).not.toContain("one-time");
  });
});
