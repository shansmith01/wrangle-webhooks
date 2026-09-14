import { describe, expect, it } from "vitest";
import { requireDashboardAuth } from "../../src/auth";

function dashboardRequest(authorization?: string): Request {
  return new Request("https://dev-webhooks.example.com/dashboard", {
    headers: authorization ? { Authorization: authorization } : undefined
  });
}

describe("dashboard auth", () => {
  it("accepts HTTP Basic with any username and the configured password", () => {
    const header = `Basic ${btoa("operator:s3cret")}`;
    expect(requireDashboardAuth(dashboardRequest(header), "s3cret")).toBe(true);
  });

  it("rejects missing, malformed, or wrong credentials", () => {
    expect(requireDashboardAuth(dashboardRequest(), "s3cret")).toBe(false);
    expect(requireDashboardAuth(dashboardRequest("Bearer s3cret"), "s3cret")).toBe(false);
    expect(
      requireDashboardAuth(dashboardRequest(`Basic ${btoa("operator:nope")}`), "s3cret")
    ).toBe(false);
    expect(requireDashboardAuth(dashboardRequest("Basic not-base64"), "s3cret")).toBe(false);
    expect(requireDashboardAuth(dashboardRequest(`Basic ${btoa("operator:s3cret")}`), "")).toBe(
      false
    );
  });
});
