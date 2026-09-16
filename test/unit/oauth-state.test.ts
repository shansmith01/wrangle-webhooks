import { deriveRouteSecret } from "../../src/credentials";
import { expect, test } from "vitest";
import {
  OAUTH_STATE_TTL_MS,
  unwrapOAuthState,
  unwrapOAuthStateForRoute,
  wrapOAuthState
} from "../../src/oauth-state";

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
