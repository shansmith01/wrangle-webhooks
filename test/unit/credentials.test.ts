import { describe, expect, it } from "vitest";
import {
  deriveRouteSecret,
  hashConnectionToken,
  matchJoinCredential,
  randomConnectionToken
} from "../../src/credentials";

describe("route credentials", () => {
  it("derives a distinct secret per route", async () => {
    const nomads = await deriveRouteSecret("operator-secret", "nomads");
    const other = await deriveRouteSecret("operator-secret", "other");
    expect(nomads).toMatch(/^rt_/);
    expect(nomads).not.toBe(other);
    expect(nomads).toBe(await deriveRouteSecret("operator-secret", "nomads"));
  });

  it("derives a distinct secret for the empty root route", async () => {
    const root = await deriveRouteSecret("operator-secret", "");
    const named = await deriveRouteSecret("operator-secret", "nomads");
    expect(root).toMatch(/^rt_/);
    expect(root).not.toBe(named);
    expect(await matchJoinCredential(root, "operator-secret", "")).toBe("route");
    expect(await matchJoinCredential(root, "operator-secret", "nomads")).toBeNull();
  });

  it("accepts the operator secret or the matching route secret", async () => {
    const routeSecret = await deriveRouteSecret("operator-secret", "nomads");
    expect(await matchJoinCredential("operator-secret", "operator-secret", "nomads")).toBe(
      "operator"
    );
    expect(await matchJoinCredential(routeSecret, "operator-secret", "nomads")).toBe("route");
    expect(await matchJoinCredential(routeSecret, "operator-secret", "other")).toBeNull();
  });

  it("hashes connection tokens without storing the plaintext", async () => {
    const token = randomConnectionToken();
    expect(token).toMatch(/^ct_/);
    const hash = await hashConnectionToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
  });
});
