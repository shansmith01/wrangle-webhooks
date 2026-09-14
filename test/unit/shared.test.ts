import { describe, expect, it } from "vitest";
import {
  isAllowedEnvironmentId,
  isAllowedRouteId,
  isValidRouteId,
  managementSubscriberPath,
  forwardingDisplayUrl,
  publicIngressUrl,
  joinTargetUrl,
  remainingPathFromPublicUrl,
  shouldForwardHeader,
  validateLocalUrl,
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

describe("validateLocalUrl", () => {
  it("accepts loopback http URLs", () => {
    expect(validateLocalUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("accepts private docker hostnames", () => {
    expect(validateLocalUrl("http://host.docker.internal:5173")).toBe(
      "http://host.docker.internal:5173/"
    );
  });

  it("rejects credentials and fragments", () => {
    expect(() => validateLocalUrl("http://user:pass@127.0.0.1:3000")).toThrow(/credentials/);
    expect(() => validateLocalUrl("http://127.0.0.1:3000/#x")).toThrow(/fragment/);
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

describe("isAllowedEnvironmentId", () => {
  it("accepts stable cloud environment identifiers", () => {
    expect(isAllowedEnvironmentId("amp-thread-1")).toBe(true);
    expect(isAllowedEnvironmentId("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(isAllowedEnvironmentId("local-host.example:@+dev")).toBe(true);
    expect(isAllowedEnvironmentId("a".repeat(128))).toBe(true);
    expect(isAllowedEnvironmentId("")).toBe(false);
    expect(isAllowedEnvironmentId("has space")).toBe(false);
    expect(isAllowedEnvironmentId("a".repeat(129))).toBe(false);
    expect(isAllowedEnvironmentId("has/slash")).toBe(false);
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

describe("forwardingDisplayUrl", () => {
  it("does not print a double slash when the target already has a trailing slash", () => {
    expect(forwardingDisplayUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/*");
    expect(forwardingDisplayUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/*");
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
    expect(shouldForwardHeader("X-Signature")).toBe(true);
    expect(shouldForwardHeader("Content-Type")).toBe(true);
    expect(shouldForwardHeader("Authorization")).toBe(false);
    expect(shouldForwardHeader("Cookie")).toBe(false);
    expect(shouldForwardHeader("Set-Cookie")).toBe(false);
  });
});
