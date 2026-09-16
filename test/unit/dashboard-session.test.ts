import { expect, test } from "vitest";
import {
  DASHBOARD_SESSION_TTL_MS,
  mintDashboardSession,
  verifyDashboardSession
} from "../../src/dashboard-session";

test("verifyDashboardSession rejects an expired or wrong-password session", async () => {
  const mintedAt = 1_700_000_000_000;
  const session = await mintDashboardSession("s3cret", mintedAt);
  expect(await verifyDashboardSession(session, "s3cret", mintedAt + 1)).toBe(true);
  expect(
    await verifyDashboardSession(session, "s3cret", mintedAt + DASHBOARD_SESSION_TTL_MS + 1)
  ).toBe(false);
  expect(await verifyDashboardSession(session, "other", mintedAt + 1)).toBe(false);
});
