import { describe, expect, it } from "vitest";
import {
  clientIpFromRequest,
  connectionLogTargetBaseUrl,
  publicPathForRouteId,
  sanitizeClientIp
} from "../../src/connection-log";

describe("connection audit log helpers", () => {
  it("keeps a plausible CF-Connecting-IP and drops empty or oversized values", () => {
    expect(sanitizeClientIp(" 203.0.113.10 ")).toBe("203.0.113.10");
    expect(sanitizeClientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(sanitizeClientIp("")).toBeNull();
    expect(sanitizeClientIp("x".repeat(65))).toBeNull();
    expect(sanitizeClientIp("1.2.3.4\nX-Injected: 1")).toBeNull();
    expect(clientIpFromRequest(new Request("https://example.com"))).toBeNull();
    expect(
      clientIpFromRequest(
        new Request("https://example.com", { headers: { "CF-Connecting-IP": "198.51.100.8" } })
      )
    ).toBe("198.51.100.8");
  });

  it("formats the root catch-all and named public paths", () => {
    expect(publicPathForRouteId("")).toBe("/*");
    expect(publicPathForRouteId("nomads")).toBe("/nomads/*");
  });

  it("never stores a Worker-visible URL for reverse-tunnel subscribers", () => {
    expect(connectionLogTargetBaseUrl("tunnel", "http://127.0.0.1:3000")).toBe("reverse-tunnel");
    expect(connectionLogTargetBaseUrl("public", "https://dev-a.example/")).toBe(
      "https://dev-a.example/"
    );
  });
});
