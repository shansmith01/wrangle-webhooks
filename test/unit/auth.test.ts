import { describe, expect, it } from "vitest";
import {
  DASHBOARD_COOKIE_NAME,
  dashboardSessionSetCookie,
  mintDashboardSession,
  requireDashboardAuth,
  verifyDashboardSession
} from "../../src/auth";

function dashboardRequest(headers?: HeadersInit): Request {
  return new Request("https://dev-webhooks.example.com/dashboard", { headers });
}

describe("dashboard auth", () => {
  it("accepts a signed session cookie scoped to /dashboard", async () => {
    const session = await mintDashboardSession("s3cret");
    const request = dashboardRequest({ Cookie: `${DASHBOARD_COOKIE_NAME}=${session}` });
    expect(await requireDashboardAuth(request, "s3cret")).toBe(true);

    const setCookie = dashboardSessionSetCookie(request, session);
    expect(setCookie).toContain(`${DASHBOARD_COOKIE_NAME}=${session}`);
    expect(setCookie).toContain("Path=/dashboard");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
  });

  it("rejects missing, expired, Basic, or bearer credentials", async () => {
    expect(await requireDashboardAuth(dashboardRequest(), "s3cret")).toBe(false);
    expect(
      await requireDashboardAuth(
        dashboardRequest({ Authorization: `Basic ${btoa("operator:s3cret")}` }),
        "s3cret"
      )
    ).toBe(false);
    expect(
      await requireDashboardAuth(dashboardRequest({ Authorization: "Bearer s3cret" }), "s3cret")
    ).toBe(false);
    expect(await verifyDashboardSession("not-a-session", "s3cret")).toBe(false);
    expect(await verifyDashboardSession("1.abc", "s3cret", 2)).toBe(false);
    expect(await requireDashboardAuth(dashboardRequest(), "")).toBe(false);

    const session = await mintDashboardSession("s3cret");
    expect(
      await requireDashboardAuth(
        dashboardRequest({ Cookie: `${DASHBOARD_COOKIE_NAME}=${session}` }),
        "other"
      )
    ).toBe(false);
  });
});
