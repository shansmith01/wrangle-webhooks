import { describe, expect, it } from "vitest";
import {
  classifyDelivery,
  unwrapOAuthState,
  wrapOAuthState
} from "../../src/oauth-state";

describe("classifyDelivery", () => {
  it("treats OAuth code+state as oauth", () => {
    expect(
      classifyDelivery({
        remainingPath: "/login",
        search: "?code=abc&state=xyz",
        form: null
      })
    ).toBe("oauth");
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
});
