import { describe, expect, it } from "vitest";
import {
  isAllowedRouteId,
  isValidRouteId,
  managementSubscriberPath,
  publicIngressUrl,
  joinTargetUrl,
  remainingPathFromPublicUrl,
  shouldForwardHeader,
  validateTargetBaseUrl
} from "../../src/shared";

describe("validateTargetBaseUrl", () => {
  it("accepts https URLs", () => {
    expect(validateTargetBaseUrl("https://abc123.cloud-dev.example")).toBe(
      "https://abc123.cloud-dev.example/"
    );
  });

  it("accepts a base path", () => {
    expect(validateTargetBaseUrl("https://abc123.cloud-dev.example/dev-ingress")).toBe(
      "https://abc123.cloud-dev.example/dev-ingress"
    );
  });

  it("rejects http", () => {
    expect(() => validateTargetBaseUrl("http://abc123.cloud-dev.example")).toThrow(
      /https/
    );
  });

  it("rejects credentials", () => {
    expect(() =>
      validateTargetBaseUrl("https://user:pass@abc123.cloud-dev.example")
    ).toThrow(/credentials/);
  });
});

describe("joinTargetUrl", () => {
  it("joins remaining paths without rewriting them", () => {
    expect(
      joinTargetUrl("https://dev-a.example", "/oauth/callback", "?code=abc&state=123")
    ).toBe("https://dev-a.example/oauth/callback?code=abc&state=123");
  });

  it("joins a target base path", () => {
    expect(joinTargetUrl("https://abc123.cloud-dev.example/dev-ingress", "/foo", "")).toBe(
      "https://abc123.cloud-dev.example/dev-ingress/foo"
    );
  });

  it("preserves a trailing slash for the route root", () => {
    expect(joinTargetUrl("https://dev-a.example", "/", "")).toBe("https://dev-a.example/");
  });

  it("preserves repeated query parameters", () => {
    expect(joinTargetUrl("https://dev-a.example", "/callback", "?id=1&id=2")).toBe(
      "https://dev-a.example/callback?id=1&id=2"
    );
  });
});

describe("remainingPathFromPublicUrl", () => {
  it("strips the route id and keeps the rest opaque", () => {
    expect(remainingPathFromPublicUrl("/project-a/api/webhooks/payment", "project-a")).toBe(
      "/api/webhooks/payment"
    );
  });

  it("keeps the full path when the route id is empty", () => {
    expect(remainingPathFromPublicUrl("/oauth/callback", "")).toBe("/oauth/callback");
  });
});

describe("isValidRouteId", () => {
  it("rejects the reserved management namespace", () => {
    expect(isValidRouteId("_router")).toBe(false);
    expect(isValidRouteId("dashboard")).toBe(false);
  });

  it("allows an empty route id as a root catch-all", () => {
    expect(isValidRouteId("")).toBe(false);
    expect(isAllowedRouteId("")).toBe(true);
  });
});

describe("publicIngressUrl", () => {
  it("omits a prefix when the route id is empty", () => {
    expect(publicIngressUrl("https://dev-webhooks.example.com", "")).toBe(
      "https://dev-webhooks.example.com/*"
    );
    expect(publicIngressUrl("https://dev-webhooks.example.com", "project-a")).toBe(
      "https://dev-webhooks.example.com/project-a/*"
    );
  });
});

describe("managementSubscriberPath", () => {
  it("uses the root management namespace when the route id is empty", () => {
    expect(managementSubscriberPath("")).toBe("/_router/subscribers");
    expect(managementSubscriberPath("", "sub_abc", "heartbeat")).toBe(
      "/_router/subscribers/sub_abc/heartbeat"
    );
  });
});

describe("shouldForwardHeader", () => {
  it("drops hop-by-hop and host headers", () => {
    expect(shouldForwardHeader("Host")).toBe(false);
    expect(shouldForwardHeader("Connection")).toBe(false);
    expect(shouldForwardHeader("Content-Length")).toBe(false);
    expect(shouldForwardHeader("Stripe-Signature")).toBe(true);
    expect(shouldForwardHeader("Content-Type")).toBe(true);
  });
});
