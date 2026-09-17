import { deriveRouteSecret } from "../../src/credentials";
import { expect, test } from "vitest";
import {
  OAUTH_STATE_TTL_MS,
  classifyDelivery,
  hasOAuthCodeOrError,
  isOAuthCallbackMethod,
  isOAuthCallbackPath,
  unwrapOAuthState,
  unwrapOAuthStateForRoute,
  wrapOAuthState
} from "../../src/oauth-state";

test("isOAuthCallbackPath recognises nested oauth, auth, and oolio callback paths", () => {
  expect(isOAuthCallbackPath("/oauth/callback")).toBe(true);
  expect(isOAuthCallbackPath("/api/auth/callback/google")).toBe(true);
  expect(isOAuthCallbackPath("/oolio/callback")).toBe(true);
  expect(isOAuthCallbackPath("/api/integrations/oolio/callback")).toBe(true);
  expect(isOAuthCallbackPath("/api/integrations/oolio/callback/")).toBe(true);
  expect(isOAuthCallbackPath("/api/integrations/oolio/callback/extra")).toBe(true);
  expect(isOAuthCallbackPath("/api/integrations/oolio/webhooks")).toBe(false);
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

test("classifyDelivery treats oolio callback paths as OAuth only when code or error is present", () => {
  expect(
    classifyDelivery({
      remainingPath: "/api/integrations/oolio/callback",
      search: "?code=one-time&state=app-nonce",
      form: null
    })
  ).toBe("oauth");
  expect(
    classifyDelivery({
      remainingPath: "/integrations/oolio/callback",
      search: "?error=access_denied",
      form: null
    })
  ).toBe("oauth");
  expect(
    classifyDelivery({
      remainingPath: "/integrations/oolio/callback",
      search: "",
      form: null
    })
  ).toBe("oauth_callback_incomplete");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?state=app-nonce",
      form: null
    })
  ).toBe("oauth_callback_incomplete");
  expect(
    classifyDelivery({
      remainingPath: "/api/integrations/oolio/webhooks",
      search: "?code=one-time&state=app-nonce",
      form: null
    })
  ).toBe("fanout");
  expect(
    classifyDelivery({
      remainingPath: "/admin",
      search: "?code=1&state=1",
      form: null
    })
  ).toBe("fanout");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      form: null,
      method: "PUT"
    })
  ).toBe("oauth_method_not_allowed");
  expect(
    classifyDelivery({
      remainingPath: "/oauth/callback",
      search: "?code=one-time",
      form: null,
      method: "GET"
    })
  ).toBe("oauth");
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
