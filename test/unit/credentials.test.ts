import { expect, test } from "vitest";
import {
  deriveRouteSecret,
  hashConnectionToken,
  matchJoinCredential,
  randomConnectionToken
} from "../../src/credentials";

test("deriveRouteSecret is distinct per route including the empty root", async () => {
  const nomads = await deriveRouteSecret("operator-secret", "nomads");
  const other = await deriveRouteSecret("operator-secret", "other");
  const root = await deriveRouteSecret("operator-secret", "");
  expect(nomads).toMatch(/^rt_/);
  expect(root).toMatch(/^rt_/);
  expect(nomads).not.toBe(other);
  expect(root).not.toBe(nomads);
  expect(nomads).toBe(await deriveRouteSecret("operator-secret", "nomads"));
  expect(await matchJoinCredential(root, "operator-secret", "")).toBe("route");
  expect(await matchJoinCredential(root, "operator-secret", "nomads")).toBeNull();
});

test("matchJoinCredential accepts the operator secret or the matching route secret", async () => {
  const routeSecret = await deriveRouteSecret("operator-secret", "nomads");
  expect(await matchJoinCredential("operator-secret", "operator-secret", "nomads")).toBe(
    "operator"
  );
  expect(await matchJoinCredential(routeSecret, "operator-secret", "nomads")).toBe("route");
  expect(await matchJoinCredential(routeSecret, "operator-secret", "other")).toBeNull();
});

test("hashConnectionToken does not store the plaintext token", async () => {
  const token = randomConnectionToken();
  expect(token).toMatch(/^ct_/);
  const hash = await hashConnectionToken(token);
  expect(hash).toHaveLength(64);
  expect(hash).not.toContain(token);
});
