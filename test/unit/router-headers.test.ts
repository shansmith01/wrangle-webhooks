import { expect, test } from "vitest";
import { buildForwardHeaders } from "../../src/forward";
import { shouldForwardHeader } from "../../src/router-headers";

test("shouldForwardHeader drops hop-by-hop and spoofed forwarding headers", () => {
  expect(shouldForwardHeader("Content-Type")).toBe(true);
  expect(shouldForwardHeader("Accept")).toBe(true);
  expect(shouldForwardHeader("Origin")).toBe(true);
  expect(shouldForwardHeader("Referer")).toBe(true);
  expect(shouldForwardHeader("User-Agent")).toBe(true);
  expect(shouldForwardHeader("Stripe-Signature")).toBe(true);
  expect(shouldForwardHeader("Authorization")).toBe(false);
  expect(shouldForwardHeader("Cookie")).toBe(false);
  expect(shouldForwardHeader("X-Original-URL")).toBe(false);
  expect(shouldForwardHeader("X-Rewrite-URL")).toBe(false);
  expect(shouldForwardHeader("X-Real-IP")).toBe(false);
  expect(shouldForwardHeader("X-Forwarded-For")).toBe(false);
  expect(shouldForwardHeader("Forwarded")).toBe(false);
});

test("buildForwardHeaders overwrites X-Forwarded-For from the connecting IP", () => {
  const incoming = new Headers({
    "Content-Type": "application/json",
    Origin: "https://accounts.google.com",
    "X-Original-URL": "/admin",
    "X-Real-IP": "1.2.3.4",
    "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
    "X-Dev-Router-Token": "ft_spoofed"
  });
  const headers = buildForwardHeaders({
    incoming,
    routeId: "nomads",
    subscriberId: "sub_abc",
    requestId: "req_test",
    publicHost: "dev-webhooks.example.com",
    publicProto: "https",
    clientIp: "203.0.113.10",
    forwardToken: "ft_real"
  });
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("Origin")).toBe("https://accounts.google.com");
  expect(headers.get("X-Original-URL")).toBeNull();
  expect(headers.get("X-Real-IP")).toBeNull();
  expect(headers.get("X-Forwarded-For")).toBe("203.0.113.10");
  expect(headers.get("X-Forwarded-Host")).toBe("dev-webhooks.example.com");
  expect(headers.get("X-Dev-Router-Token")).toBe("ft_real");
});
