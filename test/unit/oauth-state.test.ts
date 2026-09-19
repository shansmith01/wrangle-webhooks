import { deriveRouteSecret } from "../../src/credentials";
import { expect, test } from "vitest";
import {
  OAUTH_STATE_TTL_MS,
  classifyDelivery,
  hasOAuthCodeOrError,
  isOAuthCallbackMethod,
  looksLikeOAuthCallbackPath,
  unwrapOAuthState,
  unwrapOAuthStateForRoute,
  wrapOAuthState
} from "../../src/oauth-state";
import { looksLikeOAuthCallbackPath as looksLikeFromPathModule } from "../../src/oauth-callback-path";

test("looksLikeOAuthCallbackPath recognises nested oauth and auth callback paths", () => {
  expect(looksLikeOAuthCallbackPath("/oauth/callback")).toBe(true);
  expect(looksLikeOAuthCallbackPath("/api/auth/callback/google")).toBe(true);
  expect(looksLikeOAuthCallbackPath("/oolio/callback")).toBe(false);
  expect(looksLikeFromPathModule("/api/integrations/oolio/callback")).toBe(false);
  expect(looksLikeOAuthCallbackPath("/api/integrations/oolio/webhooks")).toBe(false);
});

test("hasOAuthCodeOrError reads code or error from query or form fields", () => {
  expect(hasOAuthCodeOrError("?code=one-time", null)).toBe(true);
  expect(hasOAuthCodeOrError("?error=access_denied", null)).toBe(true);
  expect(hasOAuthCodeOrError("?state=app-nonce", null)).toBe(false);
  expect(hasOAuthCodeOrError("", new URLSearchParams({ code: "one-time" }))).toBe(true);
});

test("isOAuthCallbackMethod allows GET and POST only", () => {
  expect(isOAuthCallbackMethod("GET")).toBe(true);
  expect(isOAuthCallbackMethod("post")).toBe(true);
  expect(isOAuthCallbackMethod("PUT")).toBe(false);
  expect(isOAuthCallbackMethod("DELETE")).toBe(false);
  expect(isOAuthCallbackMethod("PATCH")).toBe(false);
});

test("classifyDelivery proxies only allowlisted paths with code or error", () => {
  expect(
    classifyDelivery({
      remainingPath: "/api/auth/callback/google",
      search: "?code=one-time&state=app-nonce",
      form: null,
      allowedCallbackPaths: ["/api/auth/callback/google"]
    })
  ).toBe("oauth");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?error=access_denied",
      form: null,
      allowedCallbackPaths: ["/oauth/callback"]
    })
  ).toBe("oauth");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "",
      form: null,
      allowedCallbackPaths: ["/oauth/callback"]
    })
  ).toBe("oauth_callback_incomplete");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      form: null,
      method: "PUT",
      allowedCallbackPaths: ["/oauth/callback"]
    })
  ).toBe("oauth_method_not_allowed");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      form: null,
      method: "GET",
      allowedCallbackPaths: ["/oauth/callback"]
    })
  ).toBe("oauth");
});

test("classifyDelivery rejects unregistered heuristic callback paths with no fan-out", () => {
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      form: null,
      allowedCallbackPaths: []
    })
  ).toBe("oauth_callback_not_registered");
  expect(
    classifyDelivery({
      remainingPath: "/api/auth/callback/google",
      search: "",
      form: null,
      allowedCallbackPaths: []
    })
  ).toBe("oauth_callback_not_registered");
  expect(
    classifyDelivery({
      remainingPath: "/api/integrations/oolio/callback",
      search: "?code=one-time",
      form: null,
      allowedCallbackPaths: []
    })
  ).toBe("fanout");
  expect(
    classifyDelivery({
      remainingPath: "/api/integrations/oolio/callback",
      search: "?code=one-time",
      form: null,
      allowedCallbackPaths: ["/api/integrations/oolio/callback"]
    })
  ).toBe("oauth");
});

test("classifyDelivery rejects signed dr1. state on non-allowlisted paths", async () => {
  const state = await wrapOAuthState({
    secret: "test-secret",
    subscriberId: "sub_abc",
    routeId: "nomads"
  });
  expect(
    classifyDelivery({
      remainingPath: "/custom/redirect",
      search: `?code=one-time&state=${state}`,
      form: null,
      allowedCallbackPaths: []
    })
  ).toBe("oauth_callback_not_registered");
  expect(
    classifyDelivery({
      remainingPath: "/custom/redirect",
      search: `?code=one-time&state=${state}`,
      form: null,
      allowedCallbackPaths: ["/custom/redirect"]
    })
  ).toBe("oauth");
});

test("classifyDelivery fans out unrelated paths with code or state", () => {
  expect(
    classifyDelivery({
      remainingPath: "/api/hooks",
      search: "?code=1&state=1",
      form: null,
      allowedCallbackPaths: []
    })
  ).toBe("fanout");
  expect(
    classifyDelivery({
      remainingPath: "/admin",
      search: "?code=1&state=1",
      form: null
    })
  ).toBe("fanout");
});

test("wrapOAuthState round-trips a signed subscriber reference", async () => {
  const state = await wrapOAuthState({
    secret: "test-secret",
    subscriberId: "sub_abc",
    routeId: "nomads",
    inner: "app-nonce"
  });
  const payload = await unwrapOAuthState("test-secret", state);
  expect(payload).toMatchObject({
    v: 1,
    sub: "sub_abc",
    route: "nomads",
    d: "app-nonce"
  });
});

test("unwrapOAuthState rejects a state signed with a different secret", async () => {
  const state = await wrapOAuthState({
    secret: "test-secret",
    subscriberId: "sub_abc",
    routeId: "nomads"
  });
  expect(await unwrapOAuthState("other-secret", state)).toBeNull();
});

test("unwrapOAuthStateForRoute accepts a state signed with the route credential", async () => {
  const routeSecret = await deriveRouteSecret("operator-secret", "nomads");
  const state = await wrapOAuthState({
    secret: routeSecret,
    subscriberId: "sub_abc",
    routeId: "nomads"
  });
  const payload = await unwrapOAuthStateForRoute({
    operatorSecret: "operator-secret",
    routeSecret,
    state
  });
  expect(payload).toMatchObject({ sub: "sub_abc", route: "nomads" });
});

test("unwrapOAuthState rejects a signed OAuth state after its expiry", async () => {
  const mintedAt = 1_700_000_000_000;
  const state = await wrapOAuthState({
    secret: "test-secret",
    subscriberId: "sub_abc",
    routeId: "nomads",
    now: mintedAt
  });
  expect(await unwrapOAuthState("test-secret", state, mintedAt + 1)).toMatchObject({
    sub: "sub_abc",
    route: "nomads"
  });
  expect(
    await unwrapOAuthState("test-secret", state, mintedAt + OAUTH_STATE_TTL_MS + 1)
  ).toBeNull();
});
