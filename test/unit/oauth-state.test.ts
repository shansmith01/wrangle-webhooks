import { deriveRouteSecret } from "../../src/credentials";
import { describe, expect, it } from "vitest";
import {
  classifyDelivery,
  unwrapOAuthState,
  unwrapOAuthStateForRoute,
  wrapOAuthState
} from "../../src/oauth-state";

describe("classifyDelivery", () => {
  it("does not reverse-proxy arbitrary paths that happen to include code and state", () => {
    expect(
      classifyDelivery({
        remainingPath: "/login",
        search: "?code=abc&state=xyz",
        form: null
      })
    ).toBe("fanout");
  });

  it("treats /oauth/callback as oauth", () => {
    expect(
      classifyDelivery({
        remainingPath: "/oauth/callback",
        search: "?code=123",
        form: null
      })
    ).toBe("oauth");
  });

  it("treats nested provider callback paths as oauth", () => {
    expect(
      classifyDelivery({
        remainingPath: "/api/auth/callback/google",
        search: "?code=abc&state=xyz",
        form: null
      })
    ).toBe("oauth");
  });

  it("treats a signed wrapOAuthState value as oauth on any path", async () => {
    const state = await wrapOAuthState({
      secret: "test-secret",
      subscriberId: "sub_abc",
      routeId: "nomads"
    });
    expect(
      classifyDelivery({
        remainingPath: "/custom/redirect",
        search: `?code=abc&state=${encodeURIComponent(state)}`,
        form: null
      })
    ).toBe("oauth");
  });

  it("keeps webhooks as fan-out", () => {
    expect(
      classifyDelivery({
        remainingPath: "/api/hooks/payment",
        search: "?id=123",
        form: null
      })
    ).toBe("fanout");
  });
});

describe("wrapOAuthState", () => {
  it("round-trips a signed subscriber reference", async () => {
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

  it("rejects a state signed with a different secret", async () => {
    const state = await wrapOAuthState({
      secret: "test-secret",
      subscriberId: "sub_abc",
      routeId: "nomads"
    });
    expect(await unwrapOAuthState("other-secret", state)).toBeNull();
  });

  it("unwraps a state signed with the route credential", async () => {
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
});
