import { describe, expect, it } from "vitest";
import { dashboardHtml } from "../../src/dashboard";

describe("dashboardHtml", () => {
  it("escapes subscriber fields in HTML and does not inline JSON", () => {
    const html = dashboardHtml({
      ok: true,
      secretConfigured: true,
      generatedAt: "2026-01-01T00:00:00.000Z",
      routeCount: 1,
      subscriberCount: 1,
      routes: [
        {
          routeId: "xss",
          publicPath: "/xss/*",
          subscribers: [
            {
              id: "sub_1",
              transport: "public",
              targetBaseUrl: "https://evil.example/?x=</script><script>alert(1)",
              createdAt: 0,
              lastHeartbeatAt: 0,
              expiresAt: 0,
              environmentId: "amp-thread-1"
            }
          ]
        }
      ]
    });
    expect(html).not.toMatch(/const status = /);
    expect(html).toContain("&lt;/script&gt;");
    expect(html).not.toContain("</script><script>alert(1)");
  });
});
